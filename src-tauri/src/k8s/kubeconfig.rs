pub(crate) mod sources;
use crate::error::{AppError, AppResult};
use crate::k8s::types::ContextInfo;
use kube::config::{Kubeconfig, NamedAuthInfo, NamedCluster, NamedContext};
use serde::{Deserialize, Serialize};
pub use sources::{
    load_paths, load_snapshot, source_paths, ConfigDefinition, ConfigSnapshot, ConfigSource,
};
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
    #[serde(default)]
    source_path: Option<PathBuf>,
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
    pub source_path: Option<PathBuf>,
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
        .map(|NamedContext { name, context, .. }| {
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
    Ok(load_snapshot()?.config)
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
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::Kubeconfig(format!("read {}: {e}", path.display())))?;
    sources::decode_source(&bytes).ok_or_else(|| {
        AppError::Kubeconfig(format!("invalid kubeconfig encoding {}", path.display()))
    })
}

fn read_config_raw(path: &Path) -> AppResult<Kubeconfig> {
    let raw = read_raw(path)?;
    serde_yaml::from_str(&raw)
        .map_err(|_| AppError::Kubeconfig(format!("invalid kubeconfig source {}", path.display())))
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
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| err(format!("create dir: {e}")))?;
    }
    let tmp = path.with_extension(format!(
        "{tmp_extension}.{}.{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&tmp)
        .map_err(|e| err(format!("create private temp: {e}")))?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|e| err(format!("write temp: {e}")))?;
        file.sync_all()
            .map_err(|e| err(format!("sync temp: {e}")))?;
        drop(file);
        std::fs::rename(&tmp, path).map_err(|e| err(format!("rename temp: {e}")))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
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
    delete_from_sources(&source_paths(), &trash_path(app)?, name, now_ms())
}

fn reject_symlink_edit(path: &Path) -> AppResult<()> {
    if std::fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::Conflict("this kubeconfig source is a symbolic link; edit the original file explicitly before deleting or restoring contexts".into()));
    }
    Ok(())
}

fn delete_from_sources(
    paths: &[PathBuf],
    trash_path: &Path,
    name: &str,
    now: i64,
) -> AppResult<()> {
    let snapshot = load_paths(paths)?;
    let owner = snapshot.owner(name)?;
    reject_symlink_edit(&owner)?;
    let mut config = read_config_raw(&owner)?;
    let mut deleted = deleted_context_from(&config, name, now)?;
    deleted.source_path = Some(owner.clone());
    config.contexts.retain(|context| context.name != name);
    if config.current_context.as_deref() == Some(name) {
        config.current_context = config.contexts.first().map(|context| context.name.clone());
    }
    // Include even shadowed contexts: deleting one file must not damage references in another.
    let mut referenced_clusters = BTreeSet::new();
    let mut referenced_users = BTreeSet::new();
    for source in snapshot.sources.iter().filter(|source| source.exists) {
        let raw = read_config_raw(&source.path)?;
        for context in raw.contexts {
            if source.path == owner && context.name == name {
                continue;
            }
            if let Some(context) = context.context {
                referenced_clusters.insert(context.cluster);
                if let Some(user) = context.user {
                    referenced_users.insert(user);
                }
            }
        }
    }
    if let Some(cluster) = &deleted.cluster {
        if referenced_clusters.contains(&cluster.name) {
            deleted.cluster = None;
        } else {
            config.clusters.retain(|value| value.name != cluster.name);
        }
    }
    if let Some(user) = &deleted.auth_info {
        if referenced_users.contains(&user.name) {
            deleted.auth_info = None;
        } else {
            config.auth_infos.retain(|value| value.name != user.name);
        }
    }
    if !snapshot.unchanged() {
        return Err(AppError::Conflict(
            "kubeconfig changed while deleting; rescan and retry".into(),
        ));
    }
    let mut trash = load_trash(trash_path)?;
    prune_expired(&mut trash, now);
    trash.entries.retain(|entry| entry.name != name);
    trash.entries.push(deleted);
    save_trash(trash_path, &trash)?;
    write_config_raw(&owner, &config)
}

fn restore_from_sources(
    paths: &[PathBuf],
    trash_path: &Path,
    name: &str,
    overwrite: bool,
    now: i64,
) -> AppResult<()> {
    let trash = load_trash(trash_path)?;
    let entry = trash
        .entries
        .iter()
        .find(|entry| entry.name == name && entry.expires_at_ms > now)
        .ok_or_else(|| AppError::NotFound(format!("deleted context '{name}' not found")))?;
    let fallback = std::path::absolute(paths.first().cloned().unwrap_or_else(default_path))
        .map_err(|_| AppError::Kubeconfig("cannot resolve restore source path".into()))?;
    let owner = entry.source_path.as_deref().unwrap_or(&fallback);
    reject_symlink_edit(owner)?;
    let snapshot = load_paths(paths)?;
    // Overwrite never changes a definition owned by a different source.
    for source in snapshot
        .sources
        .iter()
        .filter(|source| source.exists && source.path != owner)
    {
        let config = read_config_raw(&source.path)?;
        if !restore_conflicts(&config, entry).is_empty() {
            return Err(AppError::Conflict("restoring would conflict with another kubeconfig source; resolve that definition first".into()));
        }
    }
    if !snapshot.unchanged() {
        return Err(AppError::Conflict(
            "kubeconfig changed; rescan and retry".into(),
        ));
    }
    restore_deleted_context_from(owner, trash_path, name, overwrite, now)
}

#[cfg(test)]
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
    let config = load_snapshot()?.config;
    let path = trash_path(app)?;
    let mut trash = load_trash(&path)?;
    prune_expired(&mut trash, now_ms());
    save_trash(&path, &trash)?;
    Ok(trash
        .entries
        .iter()
        .map(|entry| deleted_summary(entry, Some(&config), now_ms()))
        .collect())
}

#[cfg(test)]
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
    restore_from_sources(
        &source_paths(),
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
    let kube_path = entry.source_path.as_deref().unwrap_or(kube_path);
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
        source_path: None,
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
        source_path: entry.source_path.clone(),
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
            ..Default::default()
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
    fn delete_and_restore_preserve_unknown_kubeconfig_fields() {
        let kube_path = temp_file("unknown-fields-kube.yaml");
        let trash_path = temp_file("unknown-fields-trash.json");
        let _ = std::fs::remove_file(&trash_path);
        let mut config: serde_yaml::Value = serde_yaml::from_str(SAMPLE).unwrap();
        config["custom-root"] = "root-value".into();
        for collection in ["contexts", "clusters", "users"] {
            config[collection][1]["custom-entry"] = collection.into();
        }
        std::fs::write(&kube_path, serde_yaml::to_string(&config).unwrap()).unwrap();

        delete_context_with_backup(&kube_path, &trash_path, "prod-eks", NOW).unwrap();
        restore_deleted_context_from(&kube_path, &trash_path, "prod-eks", false, NOW).unwrap();

        let restored: serde_yaml::Value =
            serde_yaml::from_str(&std::fs::read_to_string(&kube_path).unwrap()).unwrap();
        assert_eq!(restored["custom-root"], config["custom-root"]);
        for collection in ["contexts", "clusters", "users"] {
            assert_eq!(
                restored[collection][1]["custom-entry"],
                config[collection][1]["custom-entry"]
            );
        }
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
            ..Default::default()
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
    fn missing_sources_yield_empty_contexts_without_environment_mutation() {
        let path = temp_file("missing-source");
        let _ = std::fs::remove_file(&path);
        let snapshot = load_paths(&[path]).unwrap();
        assert!(list_contexts_from(&snapshot.config).is_empty());
        assert!(load_paths(&[]).unwrap().config.contexts.is_empty());
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

#[cfg(test)]
mod source_edit_tests {
    use super::*;

    fn files(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("lumen-source-edits-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        (root.join("first"), root.join("second"), root.join("trash"))
    }

    #[test]
    fn deletion_restores_original_owner_and_preserves_cross_file_references() {
        let (a, b, trash) = files("owners");
        let first = "contexts: [{name: first, context: {cluster: shared, user: shared}}]\n";
        let second = "contexts: [{name: second, context: {cluster: shared, user: shared}}]\nclusters: [{name: shared, cluster: {server: https://fixture.invalid, certificate-authority: ca.pem}}]\nusers: [{name: shared, user: {tokenFile: token}}]\n";
        std::fs::write(&a, first).unwrap();
        std::fs::write(&b, second).unwrap();
        delete_from_sources(&[a.clone(), b.clone()], &trash, "second", 100).unwrap();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), first);
        let remaining = read_config_raw(&b).unwrap();
        assert!(remaining.contexts.is_empty());
        assert_eq!(remaining.clusters.len(), 1);
        assert_eq!(remaining.auth_infos.len(), 1);
        assert_eq!(
            load_trash(&trash).unwrap().entries[0].source_path.as_ref(),
            Some(&b)
        );
        restore_from_sources(&[a.clone(), b.clone()], &trash, "second", false, 101).unwrap();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), first);
        assert_eq!(read_config_raw(&b).unwrap().contexts[0].name, "second");
        assert_eq!(
            read_config_raw(&b).unwrap().clusters[0]
                .cluster
                .as_ref()
                .unwrap()
                .certificate_authority
                .as_deref(),
            Some("ca.pem")
        );
    }

    #[test]
    fn separate_cluster_and_user_sources_are_never_written() {
        let (a, b, trash) = files("separate");
        let credentials = "clusters: [{name: shared, cluster: {server: https://fixture.invalid}}]\nusers: [{name: shared, user: {tokenFile: token}}]\n";
        std::fs::write(&a, credentials).unwrap();
        std::fs::write(
            &b,
            "contexts: [{name: second, context: {cluster: shared, user: shared}}]\n",
        )
        .unwrap();
        delete_from_sources(&[a.clone(), b.clone()], &trash, "second", 100).unwrap();
        restore_from_sources(&[a.clone(), b], &trash, "second", false, 101).unwrap();
        assert_eq!(std::fs::read_to_string(a).unwrap(), credentials);
    }

    #[test]
    fn ambiguous_deletion_and_cross_source_restore_overwrite_are_rejected() {
        let (a, b, trash) = files("duplicates");
        let config = "contexts: [{name: duplicated, context: {cluster: shared}}]\n";
        std::fs::write(&a, config).unwrap();
        std::fs::write(&b, config).unwrap();
        assert!(matches!(
            delete_from_sources(&[a.clone(), b.clone()], &trash, "duplicated", 100),
            Err(AppError::Conflict(_))
        ));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), config);
        delete_from_sources(std::slice::from_ref(&a), &trash, "duplicated", 100).unwrap();
        assert!(matches!(
            restore_from_sources(&[a, b], &trash, "duplicated", true, 101),
            Err(AppError::Conflict(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn source_and_backup_writes_keep_credentials_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (a, _, trash) = files("permissions");
        std::fs::write(&a, "contexts: [{name: dev, context: {cluster: c}}]").unwrap();
        std::fs::set_permissions(&a, std::fs::Permissions::from_mode(0o600)).unwrap();
        delete_from_sources(std::slice::from_ref(&a), &trash, "dev", 100).unwrap();
        for path in [&a, &trash] {
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        restore_from_sources(std::slice::from_ref(&a), &trash, "dev", false, 101).unwrap();
        assert_eq!(
            std::fs::metadata(a).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
