//! Native mutation policy. Only explicit protection preferences reach disk;
//! unlock grants are process-local and expire against a monotonic clock.
use crate::error::{AppError, AppResult};
use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const UNLOCK_DURATION: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize)]
pub struct ContextProtection {
    pub context: String,
    pub protected: bool,
    pub unlocked_until_ms: Option<u64>,
    pub can_mutate: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Preferences {
    version: u8,
    protected_contexts: BTreeSet<String>,
}
struct Unlock {
    identity: String,
    expires: Instant,
    until_ms: u64,
}
struct Policy {
    preferences: Preferences,
    unlocks: HashMap<String, Unlock>,
    storage_error: Option<String>,
}
pub struct ContextProtectionPolicy {
    path: Option<PathBuf>,
    policy: Mutex<Policy>,
}

impl ContextProtectionPolicy {
    pub fn load(path: PathBuf) -> Self {
        let loaded = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Preferences>(&bytes)
                .map_err(|e| e.to_string())
                .and_then(|p| {
                    if p.version == 1 {
                        Ok(p)
                    } else {
                        Err("unsupported policy version".into())
                    }
                }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences {
                version: 1,
                ..Default::default()
            }),
            Err(e) => Err(e.to_string()),
        };
        let (preferences, storage_error) = match loaded {
            Ok(p) => (p, None),
            Err(e) => (Preferences::default(), Some(e)),
        };
        Self {
            path: Some(path),
            policy: Mutex::new(Policy {
                preferences,
                unlocks: HashMap::new(),
                storage_error,
            }),
        }
    }

    /// State without a configured app directory cannot authorize mutations.
    pub fn unavailable() -> Self {
        Self {
            path: None,
            policy: Mutex::new(Policy {
                preferences: Preferences::default(),
                unlocks: HashMap::new(),
                storage_error: Some("app config directory unavailable".into()),
            }),
        }
    }

    fn healthy(policy: &Policy) -> AppResult<()> {
        if let Some(error) = &policy.storage_error {
            return Err(AppError::PermissionDenied(format!("Context protection storage is unavailable; mutations are locked. Repair the protection settings file and restart Lumen: {error}")));
        }
        Ok(())
    }

    fn status_at(
        policy: &mut Policy,
        context: &str,
        identity: &str,
        now: Instant,
    ) -> AppResult<ContextProtection> {
        Self::healthy(policy)?;
        if policy
            .unlocks
            .get(context)
            .is_some_and(|u| u.identity != identity || now >= u.expires)
        {
            policy.unlocks.remove(context);
        }
        let protected = policy.preferences.protected_contexts.contains(context);
        let unlocked_until_ms = policy.unlocks.get(context).map(|u| u.until_ms);
        Ok(ContextProtection {
            context: context.into(),
            protected,
            unlocked_until_ms,
            can_mutate: !protected || unlocked_until_ms.is_some(),
        })
    }

    pub fn status(&self, context: &str, identity: &str) -> AppResult<ContextProtection> {
        Self::status_at(
            &mut self.policy.lock().unwrap(),
            context,
            identity,
            Instant::now(),
        )
    }

    pub fn require_mutation(&self, context: &str, identity: &str, dry_run: bool) -> AppResult<()> {
        if dry_run {
            return Ok(());
        }
        if !self.status(context, identity)?.can_mutate {
            return Err(AppError::PermissionDenied(format!(
                "Context '{context}' is protected. Unlock it for 10 minutes before making changes."
            )));
        }
        Ok(())
    }

    pub fn set_protected(
        &self,
        context: &str,
        protected: bool,
        identity: &str,
    ) -> AppResult<ContextProtection> {
        let mut policy = self.policy.lock().unwrap();
        Self::healthy(&policy)?;
        policy.unlocks.remove(context);
        if protected {
            policy.preferences.protected_contexts.insert(context.into());
        } else {
            policy.preferences.protected_contexts.remove(context);
        }
        // An unsuccessful write locks the entire policy for this process. Never
        // continue using a preference that was not safely persisted.
        let result = self.persist(&policy.preferences);
        if let Err(e) = result {
            policy.storage_error = Some(e.to_string());
        }
        Self::status_at(&mut policy, context, identity, Instant::now())
    }

    fn persist(&self, preferences: &Preferences) -> AppResult<()> {
        use std::io::Write;
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| AppError::Internal("no protection path".into()))?;
        let parent = path
            .parent()
            .ok_or_else(|| AppError::Internal("no protection directory".into()))?;
        std::fs::create_dir_all(parent).map_err(|e| AppError::Internal(e.to_string()))?;
        let temp = path.with_extension(format!("{}.tmp", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|e| AppError::Internal(e.to_string()))?;
        let result = (|| {
            file.write_all(&serde_json::to_vec(preferences)?)?;
            file.sync_all()?;
            std::fs::rename(&temp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temp);
        }
        result.map_err(|e: std::io::Error| AppError::Internal(e.to_string()))
    }

    pub fn unlock(&self, context: &str, identity: &str) -> AppResult<ContextProtection> {
        let mut policy = self.policy.lock().unwrap();
        Self::healthy(&policy)?;
        let now = Instant::now();
        if policy.preferences.protected_contexts.contains(context) {
            let wall = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            policy.unlocks.insert(
                context.into(),
                Unlock {
                    identity: identity.into(),
                    expires: now + UNLOCK_DURATION,
                    until_ms: wall + UNLOCK_DURATION.as_millis() as u64,
                },
            );
        }
        Self::status_at(&mut policy, context, identity, now)
    }

    pub fn lock(&self, context: &str, identity: &str) -> AppResult<ContextProtection> {
        let mut policy = self.policy.lock().unwrap();
        policy.unlocks.remove(context);
        Self::status_at(&mut policy, context, identity, Instant::now())
    }
}

/// Capture selected credentials and CA data before authorization. The native
/// client and Helm process consume these same bytes, not mutable file paths.
pub fn materialize_context(config: &Kubeconfig, context: &str) -> AppResult<Kubeconfig> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut selected = config.clone();
    selected.contexts.retain(|c| c.name == context);
    let ctx = selected
        .contexts
        .first()
        .and_then(|c| c.context.as_ref())
        .ok_or_else(|| AppError::Kubeconfig(format!("context '{context}' not found")))?
        .clone();
    selected.clusters.retain(|c| c.name == ctx.cluster);
    selected
        .auth_infos
        .retain(|a| ctx.user.as_ref() == Some(&a.name));
    selected.current_context = Some(context.into());
    let read = |path: &str| {
        std::fs::read(path).map_err(|_| {
            AppError::Kubeconfig(
                "Cannot read a credential or certificate file for this context".into(),
            )
        })
    };
    if let Some(cluster) = selected
        .clusters
        .first_mut()
        .and_then(|c| c.cluster.as_mut())
    {
        if cluster.certificate_authority_data.is_none() {
            if let Some(path) = cluster.certificate_authority.as_deref() {
                cluster.certificate_authority_data = Some(STANDARD.encode(read(path)?));
            }
        }
        cluster.certificate_authority = None;
    }
    if let Some(auth) = selected
        .auth_infos
        .first_mut()
        .and_then(|a| a.auth_info.as_mut())
    {
        if auth.client_certificate_data.is_none() {
            if let Some(path) = auth.client_certificate.as_deref() {
                auth.client_certificate_data = Some(STANDARD.encode(read(path)?));
            }
        }
        if auth.client_key_data.is_none() {
            if let Some(path) = auth.client_key.as_deref() {
                auth.client_key_data = Some(STANDARD.encode(read(path)?).into());
            }
        }
        if auth.token.is_none() {
            if let Some(path) = auth.token_file.as_deref() {
                let token = String::from_utf8(read(path)?)
                    .map_err(|_| AppError::Kubeconfig("Token file is not UTF-8".into()))?;
                auth.token = Some(token.trim().to_owned().into());
            }
        }
        auth.client_certificate = None;
        auth.client_key = None;
        auth.token_file = None;
    }
    Ok(selected)
}

pub fn load_target(context: &str) -> AppResult<(Kubeconfig, String)> {
    target_from_snapshot(crate::k8s::kubeconfig::load_snapshot()?, context)
}

fn target_from_snapshot(
    snapshot: crate::k8s::kubeconfig::ConfigSnapshot,
    context: &str,
) -> AppResult<(Kubeconfig, String)> {
    let sources = snapshot.context_sources(context);
    let original_identity = identity_from_config(&snapshot.config, context)?;
    let config = materialize_context(&snapshot.config, context)?;
    let identity = serde_json::to_string(&(
        sources,
        original_identity,
        identity_from_config(&config, context)?,
    ))
    .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok((config, identity))
}

/// Full canonical effective config identity kept in memory only. Do not log it:
/// it may contain credentials. Unrelated contexts do not invalidate a grant.
pub fn identity_from_config(config: &Kubeconfig, context: &str) -> AppResult<String> {
    let named = config
        .contexts
        .iter()
        .find(|c| c.name == context)
        .ok_or_else(|| AppError::Kubeconfig(format!("context '{context}' not found")))?;
    let ctx = named
        .context
        .as_ref()
        .ok_or_else(|| AppError::Kubeconfig("context has no configuration".into()))?;
    let cluster = config
        .clusters
        .iter()
        .find(|c| c.name == ctx.cluster)
        .ok_or_else(|| AppError::Kubeconfig("context cluster not found".into()))?;
    let auth = ctx
        .user
        .as_ref()
        .and_then(|user| config.auth_infos.iter().find(|a| &a.name == user));
    serde_json::to_string(&(named, cluster, auth)).map_err(|e| AppError::Internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, ContextProtectionPolicy) {
        let path = std::env::temp_dir()
            .join(format!(
                "lumen-protection-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .join("policy.json");
        let policy = ContextProtectionPolicy::load(path.clone());
        (path, policy)
    }
    #[test]
    fn protection_is_explicit_and_unlocks_are_isolated_and_volatile() {
        let (path, policy) = fixture();
        assert!(policy.status("prod", "one").unwrap().can_mutate);
        assert_eq!(
            serde_json::to_value(policy.status("prod", "one").unwrap()).unwrap(),
            serde_json::json!({"context":"prod", "protected":false, "unlocked_until_ms":null, "can_mutate":true})
        );
        policy.set_protected("prod", true, "one").unwrap();
        policy.set_protected("other", true, "two").unwrap();
        assert!(policy.require_mutation("prod", "one", false).is_err());
        assert!(policy.require_mutation("prod", "one", true).is_ok());
        assert!(policy.unlock("prod", "one").unwrap().can_mutate);
        assert!(!policy.status("other", "two").unwrap().can_mutate);
        let restarted = ContextProtectionPolicy::load(path.clone());
        assert!(!restarted.status("prod", "one").unwrap().can_mutate);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("until"));
        assert!(!disk.contains("identity"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn expiration_boundary_and_config_change_revoke_unlock_permanently() {
        let (path, policy) = fixture();
        policy.set_protected("prod", true, "one").unwrap();
        policy.unlock("prod", "one").unwrap();
        let mut inner = policy.policy.lock().unwrap();
        let expires = inner.unlocks["prod"].expires;
        assert!(
            ContextProtectionPolicy::status_at(
                &mut inner,
                "prod",
                "one",
                expires - Duration::from_nanos(1)
            )
            .unwrap()
            .can_mutate
        );
        assert!(
            !ContextProtectionPolicy::status_at(&mut inner, "prod", "one", expires)
                .unwrap()
                .can_mutate
        );
        drop(inner);
        policy.unlock("prod", "one").unwrap();
        assert!(!policy.status("prod", "replacement").unwrap().can_mutate);
        assert!(!policy.status("prod", "one").unwrap().can_mutate);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn corrupt_or_failed_storage_fails_closed_but_allows_preview() {
        let (path, policy) = fixture();
        policy.set_protected("prod", true, "one").unwrap();
        std::fs::write(&path, "broken").unwrap();
        let corrupt = ContextProtectionPolicy::load(path.clone());
        assert!(corrupt.require_mutation("dev", "any", false).is_err());
        assert!(corrupt.require_mutation("dev", "any", true).is_ok());
        assert!(corrupt.unlock("dev", "any").is_err());
        assert!(corrupt.set_protected("dev", false, "any").is_err());
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(policy.set_protected("prod", false, "one").is_err());
        assert!(policy.require_mutation("dev", "any", false).is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn captured_external_credentials_are_immutable_and_rotation_changes_identity() {
        let (path, _) = fixture();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let token_file = path.with_extension("token");
        std::fs::write(&token_file, "first-token\n").unwrap();
        let config: Kubeconfig = serde_json::from_value(serde_json::json!({
            "clusters": [{"name":"cluster", "cluster":{"server":"https://localhost"}}],
            "users": [{"name":"user", "user":{"tokenFile":token_file}}],
            "contexts": [{"name":"prod", "context":{"cluster":"cluster", "user":"user"}}]
        }))
        .unwrap();
        let captured = materialize_context(&config, "prod").unwrap();
        let first_identity = identity_from_config(&captured, "prod").unwrap();
        assert!(captured.auth_infos[0]
            .auth_info
            .as_ref()
            .unwrap()
            .token_file
            .is_none());
        std::fs::write(&token_file, "second-token\n").unwrap();
        let updated = materialize_context(&config, "prod").unwrap();
        assert_ne!(
            first_identity,
            identity_from_config(&updated, "prod").unwrap()
        );
        assert_eq!(
            first_identity,
            identity_from_config(&captured, "prod").unwrap()
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn server_and_auth_changes_revoke_grants_but_unrelated_contexts_do_not() {
        let config: Kubeconfig = serde_json::from_value(serde_json::json!({
            "clusters": [{"name":"cluster", "cluster":{"server":"https://localhost"}}],
            "users": [{"name":"user", "user":{"token":"first"}}],
            "contexts": [{"name":"prod", "context":{"cluster":"cluster", "user":"user"}}]
        }))
        .unwrap();
        let (path, policy) = fixture();
        let first = identity_from_config(&config, "prod").unwrap();
        policy.set_protected("prod", true, &first).unwrap();
        policy.unlock("prod", &first).unwrap();
        let mut updated = config.clone();
        updated.contexts.push(kube::config::NamedContext {
            name: "dev".into(),
            ..Default::default()
        });
        assert_eq!(first, identity_from_config(&updated, "prod").unwrap());
        updated.clusters[0].cluster.as_mut().unwrap().server = Some("https://replacement".into());
        assert!(
            !policy
                .status("prod", &identity_from_config(&updated, "prod").unwrap())
                .unwrap()
                .can_mutate
        );
        assert!(!policy.status("prod", &first).unwrap().can_mutate);
        policy.unlock("prod", &first).unwrap();
        let mut updated = config;
        updated.auth_infos[0].auth_info.as_mut().unwrap().token = Some("replacement".into());
        assert!(
            !policy
                .status("prod", &identity_from_config(&updated, "prod").unwrap())
                .unwrap()
                .can_mutate
        );
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn identical_context_from_a_different_source_requires_a_new_unlock() {
        let (path, policy) = fixture();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let first_path = path.with_extension("first.yaml");
        let second_path = path.with_extension("second.yaml");
        let yaml = "apiVersion: v1\nkind: Config\nclusters:\n- name: cluster\n  cluster:\n    server: https://localhost\ncontexts:\n- name: prod\n  context:\n    cluster: cluster\n";
        std::fs::write(&first_path, yaml).unwrap();
        std::fs::write(&second_path, yaml).unwrap();
        let (_, first_identity) = target_from_snapshot(
            crate::k8s::kubeconfig::load_paths(&[first_path]).unwrap(),
            "prod",
        )
        .unwrap();
        let (_, second_identity) = target_from_snapshot(
            crate::k8s::kubeconfig::load_paths(&[second_path]).unwrap(),
            "prod",
        )
        .unwrap();
        policy.set_protected("prod", true, &first_identity).unwrap();
        policy.unlock("prod", &first_identity).unwrap();
        assert_ne!(first_identity, second_identity);
        assert!(!policy.status("prod", &second_identity).unwrap().can_mutate);
        assert!(!policy.status("prod", &first_identity).unwrap().can_mutate);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
