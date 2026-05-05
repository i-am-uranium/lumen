//! ArgoCD integration backend.
//!
//! ArgoCD lives in-cluster as CRDs (api group `argoproj.io/v1alpha1`).
//! Lumen treats them as just-another-CRD: read via the dynamic API,
//! mutate via JSON patches on the same. No `argocd` CLI / no extra
//! HTTP API to talk to — we go through the K8s API the user already
//! has credentials for.
//!
//! What we surface in v1:
//!   • `Application` list with sync/health rolled up from `.status`
//!   • One Application detail (full status + recent operations + the
//!     resource tree the controller is reconciling)
//!   • Sync action — sets `.operation.sync` on the CRD, exactly what
//!     `argocd app sync` does under the hood
//!   • Refresh annotation — `argocd.argoproj.io/refresh: normal|hard`
//!
//! Out of scope for v1 (clean follow-ups):
//!   • ApplicationSet view (templated apps)
//!   • AppProject CRUD
//!   • Diff viewer (the resource list shows synced/out-of-sync per
//!     resource; full unified diff can come later)

use crate::error::{AppError, AppResult};
use crate::k8s::time;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
use kube::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const ARGO_GROUP: &str = "argoproj.io";
const ARGO_VERSION: &str = "v1alpha1";
const APPLICATION_KIND: &str = "Application";
const APPLICATION_PLURAL: &str = "applications";

#[derive(Debug, Clone, Serialize)]
pub struct ApplicationSummary {
    pub name: String,
    pub namespace: String,
    pub project: String,
    /// Synced / OutOfSync / Unknown. Free-form from upstream so we
    /// pass it through; the UI renders pills for the canonical values.
    pub sync_status: String,
    /// Healthy / Degraded / Progressing / Missing / Suspended / Unknown.
    pub health_status: String,
    pub repo_url: String,
    pub path: String,
    pub target_revision: String,
    pub destination_namespace: String,
    pub destination_server: String,
    pub age_seconds: i64,
    /// Number of K8s resources this Application currently manages.
    pub resource_count: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplicationResource {
    pub group: String,
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
    pub sync_status: Option<String>,
    pub health_status: Option<String>,
    pub health_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperationState {
    pub phase: Option<String>,
    pub message: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub revision: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplicationDetail {
    pub summary: ApplicationSummary,
    pub resources: Vec<ApplicationResource>,
    pub operation_state: Option<OperationState>,
    pub sync_message: Option<String>,
    pub auto_sync: bool,
    pub self_heal: bool,
    /// Recent revision history (newest-first), capped at 10 to keep
    /// payload small. Each entry is just a revision/timestamp pair.
    pub history: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryEntry {
    pub revision: String,
    pub deployed_at: Option<String>,
    pub source_path: Option<String>,
}

fn application_api_resource() -> ApiResource {
    let gvk = GroupVersionKind::gvk(ARGO_GROUP, ARGO_VERSION, APPLICATION_KIND);
    ApiResource::from_gvk_with_plural(&gvk, APPLICATION_PLURAL)
}

/// Returns true when the cluster has the ArgoCD Application CRD
/// registered. Cheap discovery probe — we list at most one item to
/// confirm the API serves it. A 404 / NotFound is the "no" answer.
pub async fn detect(client: &Client) -> AppResult<bool> {
    let ar = application_api_resource();
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let lp = ListParams::default().limit(1);
    match api.list(&lp).await {
        Ok(_) => Ok(true),
        Err(kube::Error::Api(e)) if e.code == 404 => Ok(false),
        Err(kube::Error::Api(e)) if e.reason == "NotFound" => Ok(false),
        // Any other error (RBAC, network) we surface — we'd rather
        // tell the user "couldn't probe" than lie that ArgoCD isn't
        // installed.
        Err(e) => Err(AppError::K8s(e.to_string())),
    }
}

pub async fn list_applications(
    client: &Client,
    namespace: Option<&str>,
) -> AppResult<Vec<ApplicationSummary>> {
    let ar = application_api_resource();
    let api: Api<DynamicObject> = match namespace {
        Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    };
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let mut out = Vec::with_capacity(list.items.len());
    for item in list.items {
        out.push(summarize(&item));
    }
    out.sort_by(|a, b| {
        a.namespace
            .cmp(&b.namespace)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

pub async fn get_application(
    client: &Client,
    namespace: &str,
    name: &str,
) -> AppResult<ApplicationDetail> {
    let ar = application_api_resource();
    let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &ar);
    let obj = api
        .get(name)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(detail(&obj))
}

/// Sync options — mirrors the canonical surface of `argocd app sync` so
/// the wizard in the UI can offer parity with the CLI without us
/// inventing new vocabulary.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SyncOptions {
    /// Override `spec.source.targetRevision` for this one sync only.
    /// Empty / None means "use what's in the spec".
    pub revision: Option<String>,
    pub prune: bool,
    pub dry_run: bool,
    /// Force apply (apply `--force`, ignores conflicts).
    pub force: bool,
    /// `Replace=true` sync option — uses `kubectl replace` semantics.
    pub replace: bool,
    /// `ServerSideApply=true` sync option.
    pub server_side_apply: bool,
    /// `ApplyOutOfSyncOnly=true` sync option.
    pub apply_out_of_sync_only: bool,
    /// `RespectIgnoreDifferences=true` sync option.
    pub respect_ignore_differences: bool,
    /// `PruneLast=true` sync option (prune at the end of the wave).
    pub prune_last: bool,
    /// Optional retry-on-failure limit. None means no retry.
    pub retry_limit: Option<u32>,
    /// Optional resource subset to sync. Empty / None means "all".
    pub resources: Option<Vec<ResourceRef>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRef {
    pub group: String,
    pub kind: String,
    pub namespace: Option<String>,
    pub name: String,
}

/// Build the Application `.operation` patch from a SyncOptions struct.
/// Pure — split out from `sync_application` so we can unit-test the
/// translation rules without a live cluster.
pub(crate) fn build_sync_operation(opts: &SyncOptions) -> Value {
    let mut sync_options: Vec<&str> = Vec::new();
    if opts.replace {
        sync_options.push("Replace=true");
    }
    if opts.server_side_apply {
        sync_options.push("ServerSideApply=true");
    }
    if opts.apply_out_of_sync_only {
        sync_options.push("ApplyOutOfSyncOnly=true");
    }
    if opts.respect_ignore_differences {
        sync_options.push("RespectIgnoreDifferences=true");
    }
    if opts.prune_last {
        sync_options.push("PruneLast=true");
    }

    let mut sync = json!({
        "syncStrategy": { "apply": { "force": opts.force } }
    });
    if opts.prune {
        sync["prune"] = Value::Bool(true);
    }
    if opts.dry_run {
        sync["dryRun"] = Value::Bool(true);
    }
    if let Some(rev) = opts.revision.as_deref() {
        let trimmed = rev.trim();
        if !trimmed.is_empty() {
            sync["revision"] = Value::String(trimmed.to_string());
        }
    }
    if !sync_options.is_empty() {
        sync["syncOptions"] = Value::Array(
            sync_options
                .into_iter()
                .map(|s| Value::String(s.into()))
                .collect(),
        );
    }
    if let Some(limit) = opts.retry_limit {
        sync["retry"] = json!({
            "limit": limit,
            "backoff": {
                "duration": "5s",
                "factor": 2,
                "maxDuration": "3m"
            }
        });
    }
    if let Some(resources) = opts.resources.as_deref() {
        let cleaned: Vec<Value> = resources
            .iter()
            .filter(|r| !r.kind.is_empty() && !r.name.is_empty())
            .map(|r| {
                let mut entry = json!({
                    "group": r.group,
                    "kind": r.kind,
                    "name": r.name,
                });
                if let Some(ns) = r.namespace.as_deref() {
                    if !ns.is_empty() {
                        entry["namespace"] = Value::String(ns.into());
                    }
                }
                entry
            })
            .collect();
        if !cleaned.is_empty() {
            sync["resources"] = Value::Array(cleaned);
        }
    }

    json!({
        "operation": {
            "initiatedBy": { "username": "lumen" },
            "sync": sync,
        }
    })
}

/// Trigger a sync with the given options. Sets `.operation.sync` on
/// the Application — same field the ArgoCD controller picks up when
/// `argocd app sync` is invoked.
pub async fn sync_application(
    client: &Client,
    namespace: &str,
    name: &str,
    opts: &SyncOptions,
) -> AppResult<()> {
    let ar = application_api_resource();
    let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &ar);
    let body = build_sync_operation(opts);
    let pp = PatchParams::default();
    api.patch(name, &pp, &Patch::Merge(&body))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(())
}

/// Trigger a refresh — annotation-based, exactly matching the upstream
/// CLI behavior. `hard=true` re-clones the repo; otherwise it just
/// re-renders manifests against the cached repo.
pub async fn refresh_application(
    client: &Client,
    namespace: &str,
    name: &str,
    hard: bool,
) -> AppResult<()> {
    let ar = application_api_resource();
    let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &ar);
    let value = if hard { "hard" } else { "normal" };
    let body = json!({
        "metadata": {
            "annotations": {
                "argocd.argoproj.io/refresh": value
            }
        }
    });
    let pp = PatchParams::default();
    api.patch(name, &pp, &Patch::Merge(&body))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(())
}

/// Cancel a running sync. We patch `.operation` to null — the ArgoCD
/// controller treats a clear-while-running as a terminate. This is
/// the same path the upstream UI uses when the user clicks "Terminate".
pub async fn terminate_operation(client: &Client, namespace: &str, name: &str) -> AppResult<()> {
    let ar = application_api_resource();
    let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &ar);
    let body = json!({ "operation": Value::Null });
    let pp = PatchParams::default();
    api.patch(name, &pp, &Patch::Merge(&body))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(())
}

// ─── Summarization helpers (pure, unit-tested) ────────────────────────────

fn summarize(obj: &DynamicObject) -> ApplicationSummary {
    let name = obj.metadata.name.clone().unwrap_or_default();
    let namespace = obj.metadata.namespace.clone().unwrap_or_default();
    let age_seconds = time::age_seconds(obj.metadata.creation_timestamp.as_ref());
    let data = &obj.data;
    let spec = data.get("spec").cloned().unwrap_or(Value::Null);
    let status = data.get("status").cloned().unwrap_or(Value::Null);

    let project = string_at(&spec, &["project"]).unwrap_or_else(|| "default".into());
    let repo_url = string_at(&spec, &["source", "repoURL"]).unwrap_or_default();
    let path = string_at(&spec, &["source", "path"]).unwrap_or_default();
    let target_revision = string_at(&spec, &["source", "targetRevision"]).unwrap_or_default();
    let destination_namespace = string_at(&spec, &["destination", "namespace"]).unwrap_or_default();
    let destination_server = string_at(&spec, &["destination", "server"]).unwrap_or_default();

    let sync_status = string_at(&status, &["sync", "status"]).unwrap_or_else(|| "Unknown".into());
    let health_status =
        string_at(&status, &["health", "status"]).unwrap_or_else(|| "Unknown".into());

    let resource_count = status
        .get("resources")
        .and_then(|v| v.as_array())
        .map(|a| a.len() as u32)
        .unwrap_or(0);

    ApplicationSummary {
        name,
        namespace,
        project,
        sync_status,
        health_status,
        repo_url,
        path,
        target_revision,
        destination_namespace,
        destination_server,
        age_seconds,
        resource_count,
    }
}

fn detail(obj: &DynamicObject) -> ApplicationDetail {
    let summary = summarize(obj);
    let data = &obj.data;
    let status = data.get("status").cloned().unwrap_or(Value::Null);
    let spec = data.get("spec").cloned().unwrap_or(Value::Null);

    let resources = status
        .get("resources")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(application_resource)
        .collect::<Vec<_>>();

    let operation_state = status.get("operationState").map(|os| OperationState {
        phase: string_at(os, &["phase"]),
        message: string_at(os, &["message"]),
        started_at: string_at(os, &["startedAt"]),
        finished_at: string_at(os, &["finishedAt"]),
        revision: string_at(os, &["syncResult", "revision"]),
    });

    let sync_message = string_at(&status, &["sync", "comparedTo", "destination", "namespace"])
        .and_then(|_| string_at(&status, &["health", "message"]));

    // Auto-sync + self-heal flags from spec.syncPolicy.automated
    let auto_sync = spec
        .get("syncPolicy")
        .and_then(|v| v.get("automated"))
        .is_some();
    let self_heal = bool_at(&spec, &["syncPolicy", "automated", "selfHeal"]).unwrap_or(false);

    let history = status
        .get("history")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .iter()
        .rev()
        .take(10)
        .map(|h| HistoryEntry {
            revision: string_at(h, &["revision"]).unwrap_or_default(),
            deployed_at: string_at(h, &["deployedAt"]),
            source_path: string_at(h, &["source", "path"]),
        })
        .collect();

    ApplicationDetail {
        summary,
        resources,
        operation_state,
        sync_message,
        auto_sync,
        self_heal,
        history,
    }
}

fn application_resource(value: &Value) -> ApplicationResource {
    ApplicationResource {
        group: string_at(value, &["group"]).unwrap_or_default(),
        kind: string_at(value, &["kind"]).unwrap_or_default(),
        name: string_at(value, &["name"]).unwrap_or_default(),
        namespace: string_at(value, &["namespace"]),
        sync_status: string_at(value, &["status"]),
        health_status: string_at(value, &["health", "status"]),
        health_message: string_at(value, &["health", "message"]),
    }
}

fn string_at(v: &Value, path: &[&str]) -> Option<String> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_str().map(|s| s.to_string())
}

fn bool_at(v: &Value, path: &[&str]) -> Option<bool> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::api::DynamicObject;
    use kube::core::TypeMeta;

    fn dyn_obj(json: Value) -> DynamicObject {
        let mut o = DynamicObject::new(
            "x",
            &ApiResource::from_gvk_with_plural(
                &GroupVersionKind::gvk(ARGO_GROUP, ARGO_VERSION, APPLICATION_KIND),
                APPLICATION_PLURAL,
            ),
        );
        // Stamp metadata + data from the test input.
        if let Some(meta) = json.get("metadata") {
            if let Some(name) = meta.get("name").and_then(|v| v.as_str()) {
                o.metadata.name = Some(name.into());
            }
            if let Some(ns) = meta.get("namespace").and_then(|v| v.as_str()) {
                o.metadata.namespace = Some(ns.into());
            }
        }
        let data: serde_json::Map<String, Value> = json
            .as_object()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|(k, _)| k != "metadata")
            .collect();
        o.data = Value::Object(data);
        o.types = Some(TypeMeta {
            api_version: format!("{ARGO_GROUP}/{ARGO_VERSION}"),
            kind: APPLICATION_KIND.into(),
        });
        o
    }

    #[test]
    fn summarize_pulls_canonical_fields_from_spec_and_status() {
        let obj = dyn_obj(json!({
            "metadata": { "name": "guestbook", "namespace": "argocd" },
            "spec": {
                "project": "default",
                "source": {
                    "repoURL": "https://github.com/example/repo",
                    "path": "manifests",
                    "targetRevision": "HEAD"
                },
                "destination": { "namespace": "guestbook", "server": "https://kubernetes.default.svc" }
            },
            "status": {
                "sync": { "status": "Synced" },
                "health": { "status": "Healthy" },
                "resources": [
                    { "kind": "Deployment", "name": "frontend" },
                    { "kind": "Service", "name": "frontend" }
                ]
            }
        }));
        let s = summarize(&obj);
        assert_eq!(s.name, "guestbook");
        assert_eq!(s.namespace, "argocd");
        assert_eq!(s.project, "default");
        assert_eq!(s.sync_status, "Synced");
        assert_eq!(s.health_status, "Healthy");
        assert_eq!(s.repo_url, "https://github.com/example/repo");
        assert_eq!(s.path, "manifests");
        assert_eq!(s.target_revision, "HEAD");
        assert_eq!(s.destination_namespace, "guestbook");
        assert_eq!(s.destination_server, "https://kubernetes.default.svc");
        assert_eq!(s.resource_count, 2);
    }

    #[test]
    fn summarize_defaults_unknown_when_status_is_absent() {
        let obj = dyn_obj(json!({
            "metadata": { "name": "no-status", "namespace": "argocd" },
            "spec": { "project": "default" }
        }));
        let s = summarize(&obj);
        assert_eq!(s.sync_status, "Unknown");
        assert_eq!(s.health_status, "Unknown");
        assert_eq!(s.resource_count, 0);
    }

    #[test]
    fn detail_extracts_resource_tree_and_history() {
        let obj = dyn_obj(json!({
            "metadata": { "name": "g", "namespace": "argocd" },
            "spec": {
                "project": "default",
                "syncPolicy": { "automated": { "selfHeal": true, "prune": true } }
            },
            "status": {
                "sync": { "status": "OutOfSync" },
                "health": { "status": "Degraded", "message": "pods crashing" },
                "resources": [
                    {
                        "kind": "Deployment",
                        "name": "api",
                        "namespace": "prod",
                        "status": "OutOfSync",
                        "health": { "status": "Degraded", "message": "CrashLoopBackOff" }
                    }
                ],
                "history": [
                    { "revision": "abc111", "deployedAt": "2026-05-01T10:00:00Z" },
                    { "revision": "abc222", "deployedAt": "2026-05-02T10:00:00Z" },
                    { "revision": "abc333", "deployedAt": "2026-05-03T10:00:00Z" }
                ],
                "operationState": {
                    "phase": "Running",
                    "message": "syncing",
                    "syncResult": { "revision": "abc333" }
                }
            }
        }));
        let d = detail(&obj);
        assert!(d.auto_sync);
        assert!(d.self_heal);
        assert_eq!(d.resources.len(), 1);
        assert_eq!(d.resources[0].kind, "Deployment");
        assert_eq!(d.resources[0].health_status.as_deref(), Some("Degraded"));
        // History is reversed — newest entry first.
        assert_eq!(d.history.len(), 3);
        assert_eq!(d.history[0].revision, "abc333");
        assert_eq!(d.history[2].revision, "abc111");
        assert_eq!(
            d.operation_state.as_ref().unwrap().phase.as_deref(),
            Some("Running")
        );
    }

    #[test]
    fn build_sync_operation_minimal_options() {
        let body = build_sync_operation(&SyncOptions::default());
        let sync = &body["operation"]["sync"];
        assert_eq!(sync["syncStrategy"]["apply"]["force"], json!(false));
        assert!(sync.get("prune").is_none());
        assert!(sync.get("dryRun").is_none());
        assert!(sync.get("syncOptions").is_none());
        assert!(sync.get("revision").is_none());
        assert_eq!(body["operation"]["initiatedBy"]["username"], json!("lumen"));
    }

    #[test]
    fn build_sync_operation_translates_each_flag_to_canonical_string() {
        let opts = SyncOptions {
            revision: Some("HEAD~1".into()),
            prune: true,
            dry_run: true,
            force: true,
            replace: true,
            server_side_apply: true,
            apply_out_of_sync_only: true,
            respect_ignore_differences: true,
            prune_last: true,
            retry_limit: Some(3),
            resources: None,
        };
        let body = build_sync_operation(&opts);
        let sync = &body["operation"]["sync"];
        assert_eq!(sync["revision"], json!("HEAD~1"));
        assert_eq!(sync["prune"], json!(true));
        assert_eq!(sync["dryRun"], json!(true));
        assert_eq!(sync["syncStrategy"]["apply"]["force"], json!(true));
        let opts_arr = sync["syncOptions"].as_array().unwrap();
        let names: Vec<&str> = opts_arr.iter().map(|v| v.as_str().unwrap()).collect();
        assert!(names.contains(&"Replace=true"));
        assert!(names.contains(&"ServerSideApply=true"));
        assert!(names.contains(&"ApplyOutOfSyncOnly=true"));
        assert!(names.contains(&"RespectIgnoreDifferences=true"));
        assert!(names.contains(&"PruneLast=true"));
        assert_eq!(sync["retry"]["limit"], json!(3));
    }

    #[test]
    fn build_sync_operation_includes_resource_subset_when_provided() {
        let opts = SyncOptions {
            resources: Some(vec![
                ResourceRef {
                    group: "apps".into(),
                    kind: "Deployment".into(),
                    name: "api".into(),
                    namespace: Some("prod".into()),
                },
                // Garbage entry — empty kind/name should be filtered out.
                ResourceRef {
                    group: "".into(),
                    kind: "".into(),
                    name: "".into(),
                    namespace: None,
                },
            ]),
            ..SyncOptions::default()
        };
        let body = build_sync_operation(&opts);
        let resources = body["operation"]["sync"]["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0]["kind"], json!("Deployment"));
        assert_eq!(resources[0]["name"], json!("api"));
        assert_eq!(resources[0]["namespace"], json!("prod"));
    }

    #[test]
    fn build_sync_operation_blank_revision_is_dropped() {
        let opts = SyncOptions {
            revision: Some("   ".into()),
            ..SyncOptions::default()
        };
        let body = build_sync_operation(&opts);
        assert!(body["operation"]["sync"].get("revision").is_none());
    }
}
