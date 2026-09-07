use super::*;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct ConfigSource {
    pub path: PathBuf,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigDefinition {
    pub kind: String,
    pub name: String,
    pub source: PathBuf,
    pub shadowed: bool,
}

// Source contents stay in memory only. Never serialize or log revisions.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct SourceRevision(Vec<(PathBuf, Option<Vec<u8>>)>);

pub struct ConfigSnapshot {
    pub config: Kubeconfig,
    pub sources: Vec<ConfigSource>,
    pub definitions: Vec<ConfigDefinition>,
    pub(crate) revision: SourceRevision,
}

fn paths_for(value: Option<&std::ffi::OsStr>, fallback: PathBuf) -> Vec<PathBuf> {
    match value {
        Some(value) if !value.is_empty() => std::env::split_paths(value)
            .filter(|p| !p.as_os_str().is_empty())
            .collect(),
        _ => vec![fallback],
    }
}

pub fn source_paths() -> Vec<PathBuf> {
    paths_for(
        std::env::var_os("KUBECONFIG").as_deref(),
        super::default_path(),
    )
}

pub fn load_snapshot() -> AppResult<ConfigSnapshot> {
    load_paths(&source_paths())
}

fn absolute(path: &Path) -> AppResult<PathBuf> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| AppError::Kubeconfig("cannot resolve kubeconfig path".into()))?
            .join(path)
    };
    Ok(path)
}

fn resolve_path(value: &mut Option<String>, directory: &Path) {
    if let Some(path) = value {
        if !path.is_empty() && Path::new(path).is_relative() {
            *path = directory.join(&*path).to_string_lossy().into_owned();
        }
    }
}

fn resolve_references(config: &mut Kubeconfig, directory: &Path) {
    for named in &mut config.clusters {
        if let Some(cluster) = &mut named.cluster {
            resolve_path(&mut cluster.certificate_authority, directory);
        }
    }
    for named in &mut config.auth_infos {
        if let Some(auth) = &mut named.auth_info {
            resolve_path(&mut auth.client_certificate, directory);
            resolve_path(&mut auth.client_key, directory);
            resolve_path(&mut auth.token_file, directory);
            if let Some(exec) = &mut auth.exec {
                if exec
                    .command
                    .as_ref()
                    .is_some_and(|c| c.contains('/') || (cfg!(windows) && c.contains('\\')))
                {
                    resolve_path(&mut exec.command, directory);
                }
            }
        }
    }
}

pub fn load_paths(paths: &[PathBuf]) -> AppResult<ConfigSnapshot> {
    let mut config = Kubeconfig::default();
    let mut sources = Vec::new();
    let mut definitions = Vec::new();
    let mut revision = Vec::new();
    let mut seen = BTreeSet::new();
    let mut names = BTreeSet::new();
    for path in paths {
        let path = absolute(path)?;
        if !seen.insert(path.clone()) {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                sources.push(ConfigSource {
                    path: path.clone(),
                    exists: false,
                });
                revision.push((path, None));
                continue;
            }
            Err(_) => {
                return Err(AppError::Kubeconfig(format!(
                    "cannot read kubeconfig source {}",
                    path.display()
                )))
            }
        };
        let raw = std::str::from_utf8(&bytes).map_err(|_| {
            AppError::Kubeconfig(format!("invalid kubeconfig source {}", path.display()))
        })?;
        let mut next = Kubeconfig::from_yaml(raw).map_err(|_| {
            AppError::Kubeconfig(format!("invalid kubeconfig source {}", path.display()))
        })?;
        if next.current_context.as_deref() == Some("") {
            next.current_context = None;
        }
        for (kind, entries) in [
            (
                "context",
                next.contexts.iter().map(|v| &v.name).collect::<Vec<_>>(),
            ),
            ("cluster", next.clusters.iter().map(|v| &v.name).collect()),
            ("user", next.auth_infos.iter().map(|v| &v.name).collect()),
        ] {
            for name in entries {
                definitions.push(ConfigDefinition {
                    kind: kind.into(),
                    name: name.clone(),
                    source: path.clone(),
                    shadowed: !names.insert((kind.to_owned(), name.clone())),
                });
            }
        }
        // kubeconfig merge operates on whole named definitions, never individual credentials.
        resolve_references(&mut next, path.parent().unwrap_or(Path::new(".")));
        // Also enforce first-wins for duplicate names within the same document.
        let mut local = BTreeSet::new();
        next.contexts.retain(|v| local.insert(v.name.clone()));
        let mut local = BTreeSet::new();
        next.clusters.retain(|v| local.insert(v.name.clone()));
        let mut local = BTreeSet::new();
        next.auth_infos.retain(|v| local.insert(v.name.clone()));
        config = config.merge(next).map_err(|_| {
            AppError::Kubeconfig(format!("incompatible kubeconfig source {}", path.display()))
        })?;
        sources.push(ConfigSource {
            path: path.clone(),
            exists: true,
        });
        revision.push((path, Some(bytes)));
    }
    Ok(ConfigSnapshot {
        config,
        sources,
        definitions,
        revision: SourceRevision(revision),
    })
}

impl ConfigSnapshot {
    /// Credential rotations also invalidate cached clients. Diagnostics never call this.
    pub(crate) fn track_credentials(mut self) -> Self {
        let mut paths = BTreeSet::new();
        for cluster in &self.config.clusters {
            if let Some(cluster) = &cluster.cluster {
                if let Some(path) = &cluster.certificate_authority {
                    paths.insert(PathBuf::from(path));
                }
            }
        }
        for user in &self.config.auth_infos {
            if let Some(user) = &user.auth_info {
                for path in [&user.client_certificate, &user.client_key, &user.token_file]
                    .into_iter()
                    .flatten()
                {
                    paths.insert(PathBuf::from(path));
                }
            }
        }
        for path in paths {
            self.revision
                .0
                .push((path.clone(), std::fs::read(path).ok()));
        }
        self
    }

    pub(crate) fn owner(&self, name: &str) -> AppResult<PathBuf> {
        let definitions: Vec<_> = self
            .definitions
            .iter()
            .filter(|d| d.kind == "context" && d.name == name)
            .collect();
        match definitions.as_slice() {
            [entry] => Ok(entry.source.clone()),
            [] => Err(AppError::NotFound(format!("context '{name}' not found"))),
            _ => Err(AppError::Conflict(format!("context '{name}' is defined more than once; remove the duplicate definitions before deleting it"))),
        }
    }

    pub(crate) fn unchanged(&self) -> bool {
        self.revision
            .0
            .iter()
            .all(|(path, expected)| match std::fs::read(path) {
                Ok(actual) => expected.as_ref() == Some(&actual),
                Err(error) => expected.is_none() && error.kind() == std::io::ErrorKind::NotFound,
            })
    }

    pub fn context_sources(&self, name: &str) -> BTreeMap<String, PathBuf> {
        let mut result = BTreeMap::new();
        if let Some(context) = self.config.contexts.iter().find(|c| c.name == name) {
            for definition in self.definitions.iter().filter(|d| !d.shadowed) {
                let relevant = (definition.kind == "context" && definition.name == name)
                    || context.context.as_ref().is_some_and(|c| {
                        (definition.kind == "cluster" && definition.name == c.cluster)
                            || (definition.kind == "user"
                                && Some(definition.name.as_str()) == c.user.as_deref())
                    });
                if relevant {
                    result.insert(definition.kind.clone(), definition.source.clone());
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("lumen-sources-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.join("first.yaml"), dir.join("second.yaml"))
    }

    #[test]
    fn merges_all_sources_with_first_definition_winning() {
        let (a, b) = files("precedence");
        std::fs::write(&a, "current-context: first\ncontexts: [{name: first, context: {cluster: c}}]\nclusters: [{name: c, cluster: {server: https://first.invalid}}]\n").unwrap();
        std::fs::write(&b, "current-context: second\ncontexts: [{name: second, context: {cluster: c}}]\nclusters: [{name: c, cluster: {server: https://second.invalid}}]\n").unwrap();
        let snapshot = load_paths(&[a, b]).unwrap();
        let config = snapshot.config;
        assert_eq!(config.contexts.len(), 2);
        assert_eq!(config.current_context.as_deref(), Some("first"));
        assert_eq!(
            config.clusters[0]
                .cluster
                .as_ref()
                .unwrap()
                .server
                .as_deref(),
            Some("https://first.invalid")
        );
    }
}

#[cfg(test)]
mod source_regressions {
    use super::*;

    fn directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "lumen-source-regression-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn path_lists_use_native_separators_and_only_empty_or_unset_env_falls_back() {
        use std::ffi::OsStr;
        let fallback = PathBuf::from("fallback");
        assert_eq!(paths_for(None, fallback.clone()), vec![fallback.clone()]);
        assert_eq!(
            paths_for(Some(OsStr::new("")), fallback.clone()),
            vec![fallback.clone()]
        );
        let empty_list = if cfg!(windows) { ";;" } else { "::" };
        assert!(paths_for(Some(OsStr::new(empty_list)), fallback.clone()).is_empty());
        let entries = if cfg!(windows) {
            vec![
                PathBuf::from(r"C:\Users\ravi\config"),
                PathBuf::from(r"D:\team config"),
            ]
        } else {
            vec![
                PathBuf::from("/tmp/first"),
                PathBuf::from("/tmp/team config"),
            ]
        };
        let joined = std::env::join_paths(&entries).unwrap();
        assert_eq!(paths_for(Some(&joined), fallback), entries);
    }

    #[test]
    fn skips_missing_sources_but_rejects_malformed_existing_without_values() {
        let root = directory("missing");
        let missing = root.join("missing");
        let valid = root.join("valid");
        std::fs::write(&valid, "contexts: [{name: later, context: {cluster: c}}]").unwrap();
        let snapshot = load_paths(&[missing, valid.clone()]).unwrap();
        assert_eq!(snapshot.config.contexts[0].name, "later");
        assert!(!snapshot.sources[0].exists);
        std::fs::write(&valid, "token: never-expose-this\ncontexts: [").unwrap();
        let error = load_paths(&[valid]).err().unwrap();
        assert!(!error.to_string().contains("never-expose-this"));
    }

    #[test]
    fn resolves_each_reference_against_its_own_source_and_reports_duplicates() {
        let root = directory("relative");
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let one = a.join("config");
        let two = b.join("config");
        std::fs::write(&one, "current-context: ''\nclusters: [{name: c, cluster: {server: https://first.invalid, certificate-authority: ca.pem}}]\n").unwrap();
        std::fs::write(&two, "current-context: dev\ncontexts: [{name: dev, context: {cluster: c, user: u}}]\nclusters: [{name: c, cluster: {server: https://ignored.invalid}}]\nusers: [{name: u, user: {client-certificate: cert.pem, client-key: key.pem, tokenFile: token, exec: {command: ./bin/login}}}]\n").unwrap();
        let snapshot = load_paths(&[one.clone(), two.clone()]).unwrap();
        assert_eq!(snapshot.config.current_context.as_deref(), Some("dev"));
        let cluster = snapshot.config.clusters[0].cluster.as_ref().unwrap();
        assert_eq!(
            cluster.certificate_authority.as_deref(),
            a.join("ca.pem").to_str()
        );
        let user = snapshot.config.auth_infos[0].auth_info.as_ref().unwrap();
        assert_eq!(
            user.client_certificate.as_deref(),
            b.join("cert.pem").to_str()
        );
        assert_eq!(user.client_key.as_deref(), b.join("key.pem").to_str());
        assert_eq!(user.token_file.as_deref(), b.join("token").to_str());
        assert_eq!(
            user.exec.as_ref().unwrap().command.as_deref(),
            b.join("./bin/login").to_str()
        );
        assert_eq!(snapshot.context_sources("dev")["cluster"], one);
        assert_eq!(snapshot.context_sources("dev")["user"], two);
        assert_eq!(
            snapshot.definitions.iter().filter(|d| d.shadowed).count(),
            1
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_sources_resolve_references_relative_to_declared_source() {
        let root = directory("symlink");
        let real = root.join("real");
        let alias = root.join("alias");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&alias).unwrap();
        std::fs::write(
            real.join("config"),
            "clusters: [{name: c, cluster: {certificate-authority: ca.pem}}]",
        )
        .unwrap();
        let _ = std::fs::remove_file(alias.join("config"));
        std::os::unix::fs::symlink(real.join("config"), alias.join("config")).unwrap();
        let snapshot = load_paths(&[alias.join("config")]).unwrap();
        assert_eq!(
            snapshot.config.clusters[0]
                .cluster
                .as_ref()
                .unwrap()
                .certificate_authority
                .as_deref(),
            alias.join("ca.pem").to_str()
        );
    }

    #[test]
    fn credential_file_rotation_changes_private_revision() {
        let root = directory("rotation");
        let config = root.join("config");
        let token = root.join("token");
        std::fs::write(&config, "users: [{name: u, user: {tokenFile: token}}]").unwrap();
        std::fs::write(&token, "old").unwrap();
        let old = load_paths(std::slice::from_ref(&config))
            .unwrap()
            .track_credentials();
        std::fs::write(&token, "new").unwrap();
        let new = load_paths(&[config]).unwrap().track_credentials();
        assert!(old.revision != new.revision);
    }
}
