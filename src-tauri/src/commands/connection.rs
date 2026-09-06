use crate::k8s::kubeconfig;
use kube::config::Kubeconfig;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticStatus {
    ReadyToRetry,
    MissingConfig,
    InvalidConfig,
    ContextMissing,
    MissingCredentialExecutable,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectionDiagnostic {
    pub context: Option<String>,
    pub config_path: String,
    pub status: DiagnosticStatus,
    pub credential_executable: Option<String>,
    pub credential_executable_available: Option<bool>,
    pub message: String,
    pub single_source_only: bool,
}

fn is_executable_file(path: &Path, windows: bool) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    if !windows {
        use std::os::unix::fs::PermissionsExt;
        return metadata.permissions().mode() & 0o111 != 0;
    }
    true
}

fn windows_candidates(command: &str, path_ext: Option<&str>) -> Vec<String> {
    if Path::new(command).extension().is_some() {
        return vec![command.to_owned()];
    }
    path_ext
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .map(str::trim)
        .filter(|suffix| !suffix.is_empty())
        .map(|suffix| format!("{command}{}", suffix.to_ascii_lowercase()))
        .collect()
}

fn executable_available(
    command: &str,
    working_dir: &Path,
    path: Option<&str>,
    windows: bool,
    path_ext: Option<&str>,
) -> bool {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        let resolved = if command_path.is_absolute() {
            command_path.to_path_buf()
        } else {
            working_dir.join(command_path)
        };
        return is_executable_file(&resolved, windows);
    }
    let candidates = if windows {
        windows_candidates(command, path_ext)
    } else {
        vec![command.to_owned()]
    };
    let separator = if windows { ';' } else { ':' };
    path.into_iter()
        .flat_map(|value| value.split(separator))
        .any(|dir| {
            !dir.trim().is_empty()
                && candidates.iter().any(|candidate| {
                    is_executable_file(&Path::new(dir.trim()).join(candidate), windows)
                })
        })
}

fn inspect_path(
    path: &Path,
    selected_context: Option<&str>,
    executable_path: Option<&str>,
    working_dir: &Path,
    windows: bool,
    path_ext: Option<&str>,
) -> ConnectionDiagnostic {
    let base = |status, message: &str| ConnectionDiagnostic {
        context: selected_context.map(str::to_owned),
        config_path: path.display().to_string(),
        status,
        credential_executable: None,
        credential_executable_available: None,
        message: message.to_owned(),
        single_source_only: true,
    };

    if !path.is_file() {
        return base(
            DiagnosticStatus::MissingConfig,
            "No kubeconfig file was found. Create or copy one at the shown path, then rescan.",
        );
    }
    let config = match Kubeconfig::read_from(path) {
        Ok(config) => config,
        Err(_) => {
            return base(
                DiagnosticStatus::InvalidConfig,
                "The kubeconfig could not be parsed. Validate its YAML and required fields, then rescan.",
            )
        }
    };
    let context_name = selected_context
        .map(str::to_owned)
        .or_else(|| config.current_context.clone());
    let Some(context_name) = context_name else {
        return base(
            DiagnosticStatus::ContextMissing,
            "No context is selected and the kubeconfig has no current context.",
        );
    };
    let Some(context) = config
        .contexts
        .iter()
        .find(|item| item.name == context_name)
    else {
        return base(
            DiagnosticStatus::ContextMissing,
            "The selected context is not present in this kubeconfig source.",
        );
    };
    let Some(context_details) = context.context.as_ref() else {
        return base(
            DiagnosticStatus::InvalidConfig,
            "The selected context has no cluster configuration.",
        );
    };
    let Some(cluster) = config
        .clusters
        .iter()
        .find(|item| item.name == context_details.cluster)
        .and_then(|item| item.cluster.as_ref())
    else {
        return base(
            DiagnosticStatus::InvalidConfig,
            "The selected context references a cluster that is missing from this kubeconfig source.",
        );
    };
    if cluster
        .server
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .is_empty()
    {
        return base(
            DiagnosticStatus::InvalidConfig,
            "The selected cluster does not define a server endpoint.",
        );
    }
    let user_name = context
        .context
        .as_ref()
        .and_then(|item| item.user.as_deref());
    if let Some(user_name) = user_name {
        if !config.auth_infos.iter().any(|item| item.name == user_name) {
            return base(
                DiagnosticStatus::InvalidConfig,
                "The selected context references a user that is missing from this kubeconfig source.",
            );
        }
    }
    let command = user_name
        .and_then(|name| config.auth_infos.iter().find(|item| item.name == name))
        .and_then(|item| item.auth_info.as_ref())
        .and_then(|item| item.exec.as_ref())
        .and_then(|exec| exec.command.as_deref());
    if let Some(command) = command {
        let available =
            executable_available(command, working_dir, executable_path, windows, path_ext);
        return ConnectionDiagnostic {
            context: Some(context_name),
            config_path: path.display().to_string(),
            status: if available {
                DiagnosticStatus::ReadyToRetry
            } else {
                DiagnosticStatus::MissingCredentialExecutable
            },
            credential_executable: Some(
                Path::new(command)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("credential tool")
                    .to_owned(),
            ),
            credential_executable_available: Some(available),
            message: if available {
                "Configuration inspection passed. Retry to test actual cluster access."
            } else if Path::new(command).components().count() > 1
                && !Path::new(command).is_absolute()
            {
                "The relative credential executable is not available from the app working directory used by the Kubernetes client. Update the configured command or launch environment, then retry."
            } else {
                "The credential executable is not available on the app PATH. Install it or update PATH, then retry."
            }
            .to_owned(),
            single_source_only: true,
        };
    }
    ConnectionDiagnostic {
        context: Some(context_name),
        ..base(
            DiagnosticStatus::ReadyToRetry,
            "Configuration inspection passed. Retry to test actual cluster access.",
        )
    }
}

#[tauri::command]
pub async fn diagnose_connection(context: Option<String>) -> ConnectionDiagnostic {
    let path = kubeconfig::default_path();
    let executable_path = std::env::var("PATH").ok();
    let path_ext = std::env::var("PATHEXT").ok();
    let working_dir = std::env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf());
    inspect_path(
        &path,
        context.as_deref(),
        executable_path.as_deref(),
        &working_dir,
        cfg!(windows),
        path_ext.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str, contents: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("lumen-diagnostic-{}-{name}", std::process::id()));
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn malformed_config_returns_only_safe_fixed_guidance() {
        let path = fixture("malformed", "token: secret-value\ncontexts: [");
        let result = inspect_path(&path, None, None, Path::new("."), false, None);
        assert_eq!(result.status, DiagnosticStatus::InvalidConfig);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("secret-value"));
    }

    #[test]
    fn missing_config_is_actionable_without_reading_any_contents() {
        let path =
            std::env::temp_dir().join(format!("lumen-diagnostic-missing-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let result = inspect_path(&path, None, None, Path::new("."), false, None);
        assert_eq!(result.status, DiagnosticStatus::MissingConfig);
        assert!(result.message.contains("Create or copy"));
    }

    #[test]
    fn missing_credential_executable_exposes_name_but_not_args_or_env() {
        let path = fixture(
            "missing-exec",
            r#"
apiVersion: v1
kind: Config
current-context: dev
contexts: [{ name: dev, context: { cluster: c, user: u } }]
clusters: [{ name: c, cluster: { server: "https://example.invalid" } }]
users:
  - name: u
    user:
      exec:
        command: definitely-missing-lumen-plugin
        args: ["--token", "secret-value"]
        env: [{ name: TOKEN, value: secret-value }]
"#,
        );
        let result = inspect_path(&path, Some("dev"), Some(""), Path::new("."), false, None);
        let rendered = serde_json::to_string(&result).unwrap();
        assert_eq!(result.status, DiagnosticStatus::MissingCredentialExecutable);
        assert_eq!(
            result.credential_executable.as_deref(),
            Some("definitely-missing-lumen-plugin")
        );
        assert!(!rendered.contains("--token"));
        assert!(!rendered.contains("secret-value"));
    }

    #[cfg(unix)]
    #[test]
    fn resolves_relative_plugins_from_runtime_working_directory_and_requires_execute_permission() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("lumen-relative-plugin-{}", std::process::id()));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let plugin = bin.join("plugin");
        std::fs::write(&plugin, "fixture").unwrap();
        std::fs::set_permissions(&plugin, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!executable_available(
            "./bin/plugin",
            &root,
            None,
            false,
            None
        ));
        std::fs::set_permissions(&plugin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(executable_available(
            "./bin/plugin",
            &root,
            None,
            false,
            None
        ));
    }

    #[test]
    fn finds_windows_executable_suffix_without_mutating_environment() {
        let root =
            std::env::temp_dir().join(format!("lumen-windows-plugin-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("kubelogin.exe"), "fixture").unwrap();
        assert!(executable_available(
            "kubelogin",
            Path::new("."),
            root.to_str(),
            true,
            Some(".EXE;.CMD"),
        ));
    }

    #[test]
    fn validates_cluster_user_references_and_server_but_allows_anonymous_contexts() {
        let missing_cluster = fixture("missing-cluster", "apiVersion: v1\ncurrent-context: dev\ncontexts: [{name: dev, context: {cluster: absent}}]\n");
        assert_eq!(
            inspect_path(
                &missing_cluster,
                Some("dev"),
                None,
                Path::new("."),
                false,
                None,
            )
            .status,
            DiagnosticStatus::InvalidConfig
        );

        let missing_user = fixture("missing-user", "apiVersion: v1\ncurrent-context: dev\ncontexts: [{name: dev, context: {cluster: c, user: absent}}]\nclusters: [{name: c, cluster: {server: https://example.invalid}}]\n");
        assert_eq!(
            inspect_path(
                &missing_user,
                Some("dev"),
                None,
                Path::new("."),
                false,
                None,
            )
            .status,
            DiagnosticStatus::InvalidConfig
        );

        let empty_server = fixture("empty-server", "apiVersion: v1\ncurrent-context: dev\ncontexts: [{name: dev, context: {cluster: c}}]\nclusters: [{name: c, cluster: {server: ''}}]\n");
        assert_eq!(
            inspect_path(
                &empty_server,
                Some("dev"),
                None,
                Path::new("."),
                false,
                None,
            )
            .status,
            DiagnosticStatus::InvalidConfig
        );

        let anonymous = fixture("anonymous", "apiVersion: v1\ncurrent-context: dev\ncontexts: [{name: dev, context: {cluster: c}}]\nclusters: [{name: c, cluster: {server: https://example.invalid}}]\n");
        assert_eq!(
            inspect_path(&anonymous, Some("dev"), None, Path::new("."), false, None,).status,
            DiagnosticStatus::ReadyToRetry
        );
    }
}
