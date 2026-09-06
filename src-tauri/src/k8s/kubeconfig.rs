use crate::error::{AppError, AppResult};
use crate::k8s::types::ContextInfo;
use kube::config::{Kubeconfig, NamedAuthInfo, NamedCluster, NamedContext};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const TRASH_FILE: &str = "deleted-kube-contexts.json";
const TRASH_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrashStore {
    entries: Vec<DeletedContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DeletedContext {
    name: String,
    deleted_at_ms: i64,
    expires_at_ms: i64,
    context: NamedContext,
    cluster: Option<NamedCluster>,
    auth_info: Option<NamedAuthInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeletedContextSummary {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: Option<String>,
    pub is_prod: bool,
    pub deleted_at_ms: i64,
    pub expires_at_ms: i64,
    pub days_remaining: i64,
    pub has_conflict: bool,
}

pub fn default_path() -> PathBuf {
    if let Ok(p) = std::env::var("KUBECONFIG") {
        if let Some(path) = first_config_path(&p, cfg!(windows)) {
            return path;
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".kube/config"))
        .unwrap_or_else(|| PathBuf::from(".kube/config"))
}

/// Select the first configured source without merging multiple kubeconfig files.
/// `windows` is explicit so path-list behavior can be tested on every host.
pub(crate) fn first_config_path(value: &str, windows: bool) -> Option<PathBuf> {
    let separator = if windows { ';' } else { ':' };
    value
        .split(separator)
        .map(str::trim)
        .find(|entry| !entry.is_empty())
        .map(PathBuf::from)
}

pub fn list_contexts_from(cfg: &Kubeconfig) -> Vec<ContextInfo> {
    let current = cfg.current_context.clone().unwrap_or_default();
    cfg.contexts
        .iter()
        .map(|NamedContext { name, context }| {
            let ctx = context.clone().unwrap_or_default();
            let is_prod = name.to_lowercase().contains("prod");
            ContextInfo {
                name: name.clone(),
                cluster: ctx.cluster.clone(),
                user: ctx.user.clone().unwrap_or_default(),
                namespace: ctx.namespace.clone(),
                is_current: *name == current,
                is_prod,
            }
        })
        .collect()
}

pub fn load() -> AppResult<Kubeconfig> {
    let path = default_path();
    if !path.exists() {
        return Err(AppError::Kubeconfig(format!(
            "no kubeconfig at {}",
            path.display()
        )));
    }
    Kubeconfig::read_from(&path).map_err(|e| AppError::Kubeconfig(e.to_string()))
}

fn trash_path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::Internal(format!("no app config dir: {e}")))?
        .join(TRASH_FILE))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_raw(path: &Path) -> AppResult<String> {
    std::fs::read_to_string(path)
        .map_err(|e| AppError::Kubeconfig(format!("read {}: {e}", path.display())))
}

fn read_config_raw(path: &Path) -> AppResult<Kubeconfig> {
    let raw = read_raw(path)?;
    serde_yaml::from_str(&raw).map_err(|e| AppError::Kubeconfig(e.to_string()))
}

fn write_config_raw(path: &Path, cfg: &Kubeconfig) -> AppResult<()> {
    let rendered = serde_yaml::to_string(cfg)
        .map_err(|e| AppError::Kubeconfig(format!("serialize kubeconfig: {e}")))?;
    atomic_write(
        path,
        rendered.as_bytes(),
        "config.tmp",
        AppError::Kubeconfig,
    )
}

fn atomic_write(
    path: &Path,
    bytes: &[u8],
    tmp_extension: &str,
    err: fn(String) -> AppError,
) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(format!("create dir: {e}")))?;
    }
    let tmp = path.with_extension(tmp_extension);
    std::fs::write(&tmp, bytes).map_err(|e| err(format!("write temp: {e}")))?;
    std::fs::rename(&tmp, path).map_err(|e| err(format!("rename temp: {e}")))?;
    Ok(())
}

fn load_trash(path: &Path) -> AppResult<TrashStore> {
    if !path.exists() {
        return Ok(TrashStore { entries: vec![] });
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| AppError::Internal(format!("read deleted contexts: {e}")))?;
    serde_json::from_str(&text)
        .map_err(|e| AppError::Internal(format!("parse deleted contexts: {e}")))
}

fn save_trash(path: &Path, trash: &TrashStore) -> AppResult<()> {
    let json = serde_json::to_vec_pretty(trash)
        .map_err(|e| AppError::Internal(format!("serialize deleted contexts: {e}")))?;
    atomic_write(path, &json, "json.tmp", AppError::Internal)
}

fn prune_expired(trash: &mut TrashStore, now: i64) {
    trash.entries.retain(|entry| entry.expires_at_ms > now);
}

pub fn delete_context(app: &AppHandle, name: &str) -> AppResult<()> {
    delete_context_with_backup(&default_path(), &trash_path(app)?, name, now_ms())
}

fn delete_context_with_backup(
    kube_path: &Path,
    trash_path: &Path,
    name: &str,
    now: i64,
) -> AppResult<()> {
    if !kube_path.exists() {
        return Err(AppError::Kubeconfig(format!(
            "no kubeconfig at {}",
            kube_path.display()
        )));
    }
    let mut cfg = read_config_raw(kube_path)?;
    let deleted = deleted_context_from(&cfg, name, now)?;
    delete_context_from(&mut cfg, name)?;

    let mut trash = load_trash(trash_path)?;
    prune_expired(&mut trash, now);
    trash.entries.retain(|entry| entry.name != name);
    trash.entries.push(deleted);
    save_trash(trash_path, &trash)?;
    write_config_raw(kube_path, &cfg)?;
    Ok(())
}

pub fn list_deleted_contexts(app: &AppHandle) -> AppResult<Vec<DeletedContextSummary>> {
    list_deleted_contexts_from(&default_path(), &trash_path(app)?, now_ms())
}

fn list_deleted_contexts_from(
    kube_path: &Path,
    trash_path: &Path,
    now: i64,
) -> AppResult<Vec<DeletedContextSummary>> {
    let mut trash = load_trash(trash_path)?;
    let before = trash.entries.len();
    prune_expired(&mut trash, now);
    if trash.entries.len() != before {
        save_trash(trash_path, &trash)?;
    }
    let cfg = if kube_path.exists() {
        Some(read_config_raw(kube_path)?)
    } else {
        None
    };
    Ok(trash
        .entries
        .iter()
        .map(|entry| deleted_summary(entry, cfg.as_ref(), now))
        .collect())
}

pub fn restore_deleted_context(app: &AppHandle, name: &str, overwrite: bool) -> AppResult<()> {
    restore_deleted_context_from(
        &default_path(),
        &trash_path(app)?,
        name,
        overwrite,
        now_ms(),
    )
}

fn restore_deleted_context_from(
    kube_path: &Path,
    trash_path: &Path,
    name: &str,
    overwrite: bool,
    now: i64,
) -> AppResult<()> {
    let mut trash = load_trash(trash_path)?;
    prune_expired(&mut trash, now);
    let Some(entry) = trash
        .entries
        .iter()
        .find(|entry| entry.name == name)
        .cloned()
    else {
        save_trash(trash_path, &trash)?;
        return Err(AppError::NotFound(format!(
            "deleted context '{name}' not found"
        )));
    };
    if !kube_path.exists() {
        return Err(AppError::Kubeconfig(format!(
            "no kubeconfig at {}",
            kube_path.display()
        )));
    }
    let mut cfg = read_config_raw(kube_path)?;
    let conflicts = restore_conflicts(&cfg, &entry);
    if !conflicts.is_empty() && !overwrite {
        return Err(AppError::Conflict(format!(
            "{} already exists",
            conflicts.join(", ")
        )));
    }
    if overwrite {
        remove_restore_conflicts(&mut cfg, &entry);
    }
    cfg.contexts.push(entry.context.clone());
    if let Some(cluster) = &entry.cluster {
        cfg.clusters.push(cluster.clone());
    }
    if let Some(auth_info) = &entry.auth_info {
        cfg.auth_infos.push(auth_info.clone());
    }
    if cfg.current_context.is_none() {
        cfg.current_context = Some(entry.name.clone());
    }
    trash.entries.retain(|entry| entry.name != name);
    write_config_raw(kube_path, &cfg)?;
    save_trash(trash_path, &trash)?;
    Ok(())
}

fn deleted_context_from(cfg: &Kubeconfig, name: &str, now: i64) -> AppResult<DeletedContext> {
    let context = cfg
        .contexts
        .iter()
        .find(|c| c.name == name)
        .cloned()
        .ok_or_else(|| AppError::Kubeconfig(format!("context '{name}' not found")))?;
    let cluster = context.context.as_ref().and_then(|ctx| {
        cfg.clusters
            .iter()
            .find(|cluster| cluster.name == ctx.cluster)
            .cloned()
    });
    let auth_info = context.context.as_ref().and_then(|ctx| {
        ctx.user.as_ref().and_then(|user| {
            cfg.auth_infos
                .iter()
                .find(|auth_info| auth_info.name == *user)
                .cloned()
        })
    });
    Ok(DeletedContext {
        name: context.name.clone(),
        deleted_at_ms: now,
        expires_at_ms: now + TRASH_RETENTION_MS,
        context,
        cluster,
        auth_info,
    })
}

fn deleted_summary(
    entry: &DeletedContext,
    cfg: Option<&Kubeconfig>,
    now: i64,
) -> DeletedContextSummary {
    let ctx = entry.context.context.clone().unwrap_or_default();
    DeletedContextSummary {
        name: entry.name.clone(),
        cluster: ctx.cluster,
        user: ctx.user.unwrap_or_default(),
        namespace: ctx.namespace,
        is_prod: entry.name.to_lowercase().contains("prod"),
        deleted_at_ms: entry.deleted_at_ms,
        expires_at_ms: entry.expires_at_ms,
        days_remaining: ((entry.expires_at_ms - now).max(0) + 86_399_999) / 86_400_000,
        has_conflict: cfg
            .map(|cfg| !restore_conflicts(cfg, entry).is_empty())
            .unwrap_or(false),
    }
}

fn restore_conflicts(cfg: &Kubeconfig, entry: &DeletedContext) -> Vec<String> {
    let mut conflicts = Vec::new();
    if cfg.contexts.iter().any(|ctx| ctx.name == entry.name) {
        conflicts.push(format!("context '{}'", entry.name));
    }
    if let Some(cluster) = &entry.cluster {
        if cfg
            .clusters
            .iter()
            .any(|existing| existing.name == cluster.name)
        {
            conflicts.push(format!("cluster '{}'", cluster.name));
        }
    }
    if let Some(auth_info) = &entry.auth_info {
        if cfg
            .auth_infos
            .iter()
            .any(|existing| existing.name == auth_info.name)
        {
            conflicts.push(format!("user '{}'", auth_info.name));
        }
    }
    conflicts
}

fn remove_restore_conflicts(cfg: &mut Kubeconfig, entry: &DeletedContext) {
    cfg.contexts.retain(|ctx| ctx.name != entry.name);
    if let Some(cluster) = &entry.cluster {
        cfg.clusters
            .retain(|existing| existing.name != cluster.name);
    }
    if let Some(auth_info) = &entry.auth_info {
        cfg.auth_infos
            .retain(|existing| existing.name != auth_info.name);
    }
}

#[allow(dead_code)]
pub fn delete_context_without_backup(name: &str) -> AppResult<()> {
    let path = default_path();
    if !path.exists() {
        return Err(AppError::Kubeconfig(format!(
            "no kubeconfig at {}",
            path.display()
        )));
    }
    let mut cfg = read_config_raw(&path)?;
    delete_context_from(&mut cfg, name)?;
    write_config_raw(&path, &cfg)
}

pub fn delete_context_from(cfg: &mut Kubeconfig, name: &str) -> AppResult<()> {
    let removed = cfg.contexts.iter().find(|c| c.name == name).cloned();
    let Some(removed) = removed else {
        return Err(AppError::Kubeconfig(format!("context '{name}' not found")));
    };
    cfg.contexts.retain(|c| c.name != name);

    if cfg.current_context.as_deref() == Some(name) {
        cfg.current_context = cfg.contexts.first().map(|c| c.name.clone());
    }

    let mut referenced_clusters = BTreeSet::new();
    let mut referenced_users = BTreeSet::new();
    for named in &cfg.contexts {
        if let Some(ctx) = &named.context {
            referenced_clusters.insert(ctx.cluster.as_str());
            if let Some(user) = ctx.user.as_deref() {
                referenced_users.insert(user);
            }
        }
    }

    if let Some(ctx) = removed.context {
        if !referenced_clusters.contains(ctx.cluster.as_str()) {
            cfg.clusters.retain(|c| c.name != ctx.cluster);
        }
        if let Some(user) = ctx.user {
            if !referenced_users.contains(user.as_str()) {
                cfg.auth_infos.retain(|u| u.name != user);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    const SAMPLE: &str = r#"
apiVersion: v1
kind: Config
current-context: dev
contexts:
  - name: dev
    context:
      cluster: dev-cluster
      user: dev-user
      namespace: default
  - name: prod-eks
    context:
      cluster: prod-cluster
      user: prod-user
clusters:
  - name: dev-cluster
    cluster: { server: "https://dev.example" }
  - name: prod-cluster
    cluster: { server: "https://prod.example" }
users:
  - name: dev-user
    user: { token: "dev-token" }
  - name: prod-user
    user: { token: "prod-token" }
"#;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lumen-kubeconfig-test-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("file")
    }

    #[test]
    fn lists_contexts_with_current_and_prod_flags() {
        let cfg: Kubeconfig = serde_yaml::from_str(SAMPLE).unwrap();
        let ctxs = list_contexts_from(&cfg);
        assert_eq!(ctxs.len(), 2);
        let dev = ctxs.iter().find(|c| c.name == "dev").unwrap();
        assert!(dev.is_current);
        assert!(!dev.is_prod);
        assert_eq!(dev.namespace.as_deref(), Some("default"));
        let prod = ctxs.iter().find(|c| c.name == "prod-eks").unwrap();
        assert!(!prod.is_current);
        assert!(prod.is_prod);
    }

    #[test]
    fn delete_context_removes_unreferenced_cluster_and_user() {
        let mut cfg: Kubeconfig = serde_yaml::from_str(SAMPLE).unwrap();
        delete_context_from(&mut cfg, "prod-eks").unwrap();

        assert!(cfg.contexts.iter().all(|c| c.name != "prod-eks"));
        assert!(cfg.clusters.iter().all(|c| c.name != "prod-cluster"));
        assert!(cfg.auth_infos.iter().all(|u| u.name != "prod-user"));
        assert_eq!(cfg.current_context.as_deref(), Some("dev"));
    }

    #[test]
    fn delete_current_context_selects_next_context() {
        let mut cfg: Kubeconfig = serde_yaml::from_str(SAMPLE).unwrap();
        delete_context_from(&mut cfg, "dev").unwrap();

        assert_eq!(cfg.current_context.as_deref(), Some("prod-eks"));
        assert!(cfg.contexts.iter().all(|c| c.name != "dev"));
    }

    #[test]
    fn delete_context_keeps_shared_cluster_and_user() {
        let mut cfg: Kubeconfig = serde_yaml::from_str(SAMPLE).unwrap();
        cfg.contexts.push(NamedContext {
            name: "prod-copy".into(),
            context: cfg
                .contexts
                .iter()
                .find(|c| c.name == "prod-eks")
                .and_then(|c| c.context.clone()),
        });

        delete_context_from(&mut cfg, "prod-eks").unwrap();

        assert!(cfg.contexts.iter().all(|c| c.name != "prod-eks"));
        assert!(cfg.clusters.iter().any(|c| c.name == "prod-cluster"));
        assert!(cfg.auth_infos.iter().any(|u| u.name == "prod-user"));
    }

    #[test]
    fn delete_context_writes_recoverable_trash_backup() {
        let kube_path = temp_file("delete-kube.yaml");
        let trash_path = temp_file("delete-trash.json");
        std::fs::write(&kube_path, SAMPLE).unwrap();
        let _ = std::fs::remove_file(&trash_path);

        delete_context_with_backup(&kube_path, &trash_path, "prod-eks", NOW).unwrap();

        let cfg = read_config_raw(&kube_path).unwrap();
        assert!(cfg.contexts.iter().all(|ctx| ctx.name != "prod-eks"));
        let deleted = list_deleted_contexts_from(&kube_path, &trash_path, NOW).unwrap();
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].name, "prod-eks");
        assert_eq!(deleted[0].days_remaining, 90);
    }

    #[test]
    fn restore_deleted_context_returns_it_to_kubeconfig() {
        let kube_path = temp_file("restore-kube.yaml");
        let trash_path = temp_file("restore-trash.json");
        std::fs::write(&kube_path, SAMPLE).unwrap();
        let _ = std::fs::remove_file(&trash_path);
        delete_context_with_backup(&kube_path, &trash_path, "prod-eks", NOW).unwrap();

        restore_deleted_context_from(&kube_path, &trash_path, "prod-eks", false, NOW).unwrap();

        let cfg = read_config_raw(&kube_path).unwrap();
        assert!(cfg.contexts.iter().any(|ctx| ctx.name == "prod-eks"));
        assert!(cfg
            .clusters
            .iter()
            .any(|cluster| cluster.name == "prod-cluster"));
        assert!(cfg.auth_infos.iter().any(|user| user.name == "prod-user"));
        let deleted = list_deleted_contexts_from(&kube_path, &trash_path, NOW).unwrap();
        assert!(deleted.is_empty());
    }

    #[test]
    fn restore_deleted_context_requires_overwrite_on_conflict() {
        let kube_path = temp_file("conflict-kube.yaml");
        let trash_path = temp_file("conflict-trash.json");
        std::fs::write(&kube_path, SAMPLE).unwrap();
        let _ = std::fs::remove_file(&trash_path);
        delete_context_with_backup(&kube_path, &trash_path, "prod-eks", NOW).unwrap();
        let mut cfg = read_config_raw(&kube_path).unwrap();
        cfg.contexts.push(NamedContext {
            name: "prod-eks".into(),
            context: None,
        });
        write_config_raw(&kube_path, &cfg).unwrap();

        let err = restore_deleted_context_from(&kube_path, &trash_path, "prod-eks", false, NOW)
            .unwrap_err();
        assert!(matches!(err, AppError::Conflict(_)));

        restore_deleted_context_from(&kube_path, &trash_path, "prod-eks", true, NOW).unwrap();
        let cfg = read_config_raw(&kube_path).unwrap();
        assert_eq!(
            cfg.contexts
                .iter()
                .filter(|ctx| ctx.name == "prod-eks")
                .count(),
            1
        );
    }

    #[test]
    fn load_returns_kubeconfig_error_when_missing() {
        std::env::set_var("KUBECONFIG", "/definitely/does/not/exist");
        let err = load().unwrap_err();
        match err {
            AppError::Kubeconfig(_) => {}
            other => panic!("expected Kubeconfig, got {other:?}"),
        }
        std::env::remove_var("KUBECONFIG");
    }

    #[test]
    fn selects_complete_windows_drive_path() {
        assert_eq!(
            first_config_path(r"C:\Users\ravi\.kube\config;D:\team.yaml", true),
            Some(PathBuf::from(r"C:\Users\ravi\.kube\config"))
        );
    }

    #[test]
    fn selects_first_unix_path_and_ignores_blank_entries() {
        assert_eq!(
            first_config_path("  :/tmp/a:/tmp/b", false),
            Some(PathBuf::from("/tmp/a"))
        );
        assert_eq!(first_config_path(" ; ", true), None);
    }
}
