//! Tekton Pipelines integration backend.
//!
//! Tekton ships PipelineRun / TaskRun as CRDs in `tekton.dev`. The
//! modern API version is `v1`; older clusters still on `v1beta1` are
//! handled by a fallback at detection time. Once we know which version
//! the cluster serves, every subsequent call (list, get, cancel) uses
//! the same group/version.
//!
//! What we surface in v1:
//!   • PipelineRun list across namespaces with status / pipeline ref /
//!     duration / task count
//!   • One PipelineRun detail (params, workspaces, conditions, per-task
//!     status rolled up from `.status.taskRuns` for v1beta1 or
//!     `.status.childReferences` for v1)
//!   • Cancel — patches `.spec.status: "Cancelled"` (modern Tekton).
//!     For idempotence and older-cluster compatibility we also write
//!     the legacy annotation `tekton.dev/status: PipelineRunCancelled`
//!     in the same patch body.
//!
//! Out of scope for v1 (clean follow-ups):
//!   • Rerun (`tkn pipelinerun start --use-pipelinerun=...`)
//!   • TaskRun-level drilldown view
//!   • Logs streaming for TaskRun pods (Lumen's logs view handles this
//!     via the standard pod path)
//!   • Pipeline / Trigger / EventListener / ApprovalTask views

use crate::error::{AppError, AppResult};
use crate::k8s::time;
use kube::api::{Api, ListParams, Patch, PatchParams};
use kube::core::{ApiResource, DynamicObject, GroupVersionKind};
use kube::Client;
use serde::Serialize;
use serde_json::{json, Value};

const TEKTON_GROUP: &str = "tekton.dev";
const TEKTON_VERSION_V1: &str = "v1";
const TEKTON_VERSION_V1BETA1: &str = "v1beta1";
const PIPELINE_RUN_KIND: &str = "PipelineRun";
const PIPELINE_RUN_PLURAL: &str = "pipelineruns";

#[derive(Debug, Clone, Serialize)]
pub struct PipelineRunSummary {
    pub name: String,
    pub namespace: String,
    /// `.spec.pipelineRef.name` — None when the run is built from an
    /// inline PipelineSpec (also valid Tekton).
    pub pipeline_ref: Option<String>,
    /// Canonical: "Running" | "Succeeded" | "Failed" | "Cancelled" |
    /// "Pending" | "Unknown". Free-form upstream conditions get mapped
    /// by `derive_run_status` so the UI can pill on a closed set.
    pub status: String,
    pub started_at: Option<String>,
    pub completion_time: Option<String>,
    pub duration_seconds: Option<i64>,
    /// len(.status.taskRuns) for v1beta1, len(.status.childReferences)
    /// for v1. Both express "how many TaskRuns belong to this PR".
    pub task_count: u32,
    pub age_seconds: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskRunStatus {
    /// Sub-task name (the TaskRun's metadata.name).
    pub name: String,
    /// `.pipelineTaskName` — the human-meaningful name from the
    /// Pipeline spec. Often more useful than the generated TaskRun name.
    pub display_name: Option<String>,
    /// Canonical: "Running" | "Succeeded" | "Failed" | "Cancelled" |
    /// "Pending" | "Unknown". Same mapping as PipelineRun status.
    pub status: String,
    pub started_at: Option<String>,
    pub completion_time: Option<String>,
    pub duration_seconds: Option<i64>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConditionEntry {
    #[serde(rename = "type")]
    pub type_: String,
    pub status: String,
    pub reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PipelineRunDetail {
    pub summary: PipelineRunSummary,
    pub conditions: Vec<ConditionEntry>,
    pub tasks: Vec<TaskRunStatus>,
    /// `.spec.params` flattened to (name, value) pairs. Array values
    /// are JSON-encoded.
    pub params: Vec<(String, String)>,
    /// `.spec.workspaces[].name` — just the names; binding details
    /// (PVC, configmap, etc.) are not surfaced in v1 to keep the panel
    /// scannable.
    pub workspaces: Vec<String>,
}

fn pipeline_run_api_resource(version: &str) -> ApiResource {
    let gvk = GroupVersionKind::gvk(TEKTON_GROUP, version, PIPELINE_RUN_KIND);
    ApiResource::from_gvk_with_plural(&gvk, PIPELINE_RUN_PLURAL)
}

/// Returns true when the cluster registers Tekton's PipelineRun CRD.
/// Tries `tekton.dev/v1` first (modern), then falls back to
/// `tekton.dev/v1beta1`. A 404 / NotFound on both means "no Tekton".
pub async fn detect(client: &Client) -> AppResult<bool> {
    if probe_version(client, TEKTON_VERSION_V1).await? {
        return Ok(true);
    }
    // Some older installs only ship v1beta1. Try it before giving up.
    probe_version(client, TEKTON_VERSION_V1BETA1).await
}

async fn probe_version(client: &Client, version: &str) -> AppResult<bool> {
    let ar = pipeline_run_api_resource(version);
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let lp = ListParams::default().limit(1);
    match api.list(&lp).await {
        Ok(_) => Ok(true),
        Err(kube::Error::Api(e)) if e.code == 404 => Ok(false),
        Err(kube::Error::Api(e)) if e.reason == "NotFound" => Ok(false),
        // Other errors (RBAC, network) we surface — same posture as the
        // ArgoCD module: "couldn't probe" beats lying that it's missing.
        Err(e) => Err(AppError::K8s(e.to_string())),
    }
}

/// Pick the API version this cluster serves. v1 is preferred; if it
/// 404s we use v1beta1. Other errors propagate.
async fn resolve_version(client: &Client) -> AppResult<&'static str> {
    if probe_version(client, TEKTON_VERSION_V1).await? {
        return Ok(TEKTON_VERSION_V1);
    }
    if probe_version(client, TEKTON_VERSION_V1BETA1).await? {
        return Ok(TEKTON_VERSION_V1BETA1);
    }
    Err(AppError::K8s(
        "Tekton PipelineRun CRD is not registered in this cluster".into(),
    ))
}

pub async fn list_pipeline_runs(
    client: &Client,
    namespace: Option<&str>,
) -> AppResult<Vec<PipelineRunSummary>> {
    let version = resolve_version(client).await?;
    let ar = pipeline_run_api_resource(version);
    let api: Api<DynamicObject> = match namespace {
        Some(ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    };
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let mut out: Vec<PipelineRunSummary> = list.items.iter().map(summarize).collect();
    // Newest-first by start time. Runs that haven't started yet sort
    // last (None) so the user sees actively-running entries on top.
    out.sort_by(|a, b| match (&a.started_at, &b.started_at) {
        (Some(x), Some(y)) => y.cmp(x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.namespace.cmp(&b.namespace).then(a.name.cmp(&b.name)),
    });
    Ok(out)
}

pub async fn get_pipeline_run(
    client: &Client,
    namespace: &str,
    name: &str,
) -> AppResult<PipelineRunDetail> {
    let version = resolve_version(client).await?;
    let ar = pipeline_run_api_resource(version);
    let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &ar);
    let obj = api
        .get(name)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(detail(&obj))
}

/// Cancel a PipelineRun. Modern Tekton honors `.spec.status =
/// "Cancelled"`. Older releases watched a `tekton.dev/status:
/// PipelineRunCancelled` annotation. Writing both in one patch is
/// idempotent and covers the long tail without us needing to probe
/// the controller version.
pub async fn cancel_pipeline_run(client: &Client, namespace: &str, name: &str) -> AppResult<()> {
    let version = resolve_version(client).await?;
    let ar = pipeline_run_api_resource(version);
    let api: Api<DynamicObject> = Api::namespaced_with(client.clone(), namespace, &ar);
    let body = json!({
        "metadata": {
            "annotations": {
                "tekton.dev/status": "PipelineRunCancelled"
            }
        },
        "spec": { "status": "Cancelled" }
    });
    let pp = PatchParams::default();
    api.patch(name, &pp, &Patch::Merge(&body))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(())
}

// ─── Summarization helpers (pure, unit-tested) ────────────────────────────

fn summarize(obj: &DynamicObject) -> PipelineRunSummary {
    let name = obj.metadata.name.clone().unwrap_or_default();
    let namespace = obj.metadata.namespace.clone().unwrap_or_default();
    let age_seconds = time::age_seconds(obj.metadata.creation_timestamp.as_ref());
    let data = &obj.data;
    let spec = data.get("spec").cloned().unwrap_or(Value::Null);
    let status = data.get("status").cloned().unwrap_or(Value::Null);

    let pipeline_ref = string_at(&spec, &["pipelineRef", "name"]);
    let started_at = string_at(&status, &["startTime"]);
    let completion_time = string_at(&status, &["completionTime"]);
    let duration_seconds = duration_between(started_at.as_deref(), completion_time.as_deref());

    // v1 reports children via `.status.childReferences`; v1beta1 uses
    // `.status.taskRuns` (a map keyed by TaskRun name). Both expose the
    // count of belonging TaskRuns — that's all we need for the summary.
    let task_count = if let Some(arr) = status.get("childReferences").and_then(|v| v.as_array()) {
        arr.len() as u32
    } else if let Some(map) = status.get("taskRuns").and_then(|v| v.as_object()) {
        map.len() as u32
    } else {
        0
    };

    let conditions = conditions_array(&status);
    let derived = derive_run_status(&conditions, started_at.is_some());

    PipelineRunSummary {
        name,
        namespace,
        pipeline_ref,
        status: derived,
        started_at,
        completion_time,
        duration_seconds,
        task_count,
        age_seconds,
    }
}

fn detail(obj: &DynamicObject) -> PipelineRunDetail {
    let summary = summarize(obj);
    let data = &obj.data;
    let spec = data.get("spec").cloned().unwrap_or(Value::Null);
    let status = data.get("status").cloned().unwrap_or(Value::Null);

    let conditions = conditions_array(&status)
        .iter()
        .map(parse_condition)
        .collect::<Vec<_>>();

    let tasks = extract_tasks(&status);
    let params = extract_params(&spec);
    let workspaces = extract_workspaces(&spec);

    PipelineRunDetail {
        summary,
        conditions,
        tasks,
        params,
        workspaces,
    }
}

fn conditions_array(status: &Value) -> Vec<Value> {
    status
        .get("conditions")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

fn parse_condition(v: &Value) -> ConditionEntry {
    ConditionEntry {
        type_: string_at(v, &["type"]).unwrap_or_default(),
        status: string_at(v, &["status"]).unwrap_or_default(),
        reason: string_at(v, &["reason"]),
        message: string_at(v, &["message"]),
    }
}

/// Map Tekton's `Succeeded` condition to a closed-set status string
/// for the UI. Tekton's controller is single-condition: it sets
/// `Succeeded` to True/False/Unknown with a reason that disambiguates
/// the False case (Cancelled vs genuine failure). When the condition
/// is missing entirely we fall back to "Pending" if the run hasn't
/// started yet, "Unknown" otherwise.
pub fn derive_run_status(conditions: &[Value], has_start_time: bool) -> String {
    let succeeded = conditions
        .iter()
        .find(|c| c.get("type").and_then(|v| v.as_str()) == Some("Succeeded"));
    let Some(c) = succeeded else {
        return if has_start_time { "Unknown" } else { "Pending" }.into();
    };
    let status = c.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let reason = c
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    match status {
        "True" => "Succeeded".into(),
        "False" => {
            // Tekton emits a few canonical reasons here; "Cancelled"
            // and "PipelineRunCancelled" both indicate user-driven
            // cancellation rather than a genuine failure.
            if reason.contains("cancel") {
                "Cancelled".into()
            } else {
                "Failed".into()
            }
        }
        "Unknown" => {
            if has_start_time {
                "Running".into()
            } else {
                "Pending".into()
            }
        }
        _ => "Unknown".into(),
    }
}

fn extract_tasks(status: &Value) -> Vec<TaskRunStatus> {
    // v1beta1 — `.status.taskRuns` is an object keyed by TaskRun name.
    // Each entry has `.pipelineTaskName` and `.status.{conditions,
    // startTime, completionTime}`.
    if let Some(obj) = status.get("taskRuns").and_then(|v| v.as_object()) {
        let mut out: Vec<TaskRunStatus> = obj
            .iter()
            .map(|(name, entry)| task_from_taskruns_entry(name, entry))
            .collect();
        // Sort by start time so tasks read in execution order.
        out.sort_by(|a, b| a.started_at.cmp(&b.started_at));
        return out;
    }
    // v1 — `.status.childReferences[]` lists per-task refs but does NOT
    // embed the TaskRun status. Tekton expects clients to fetch each
    // TaskRun separately. For v1 we surface what's available (the
    // pipelineTaskName + name) with a status of "Unknown" — the v1
    // detail panel works as a directory; deeper drill-down is the
    // explicit follow-up scope.
    if let Some(arr) = status.get("childReferences").and_then(|v| v.as_array()) {
        return arr
            .iter()
            .filter(|c| {
                // Skip non-TaskRun children (e.g. Run/CustomRun) — those
                // would need their own GVK-aware decoding which is
                // outside v1 scope.
                let kind = c.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                kind == "TaskRun"
            })
            .map(|c| TaskRunStatus {
                name: string_at(c, &["name"]).unwrap_or_default(),
                display_name: string_at(c, &["pipelineTaskName"]),
                status: "Unknown".into(),
                started_at: None,
                completion_time: None,
                duration_seconds: None,
                message: None,
            })
            .collect();
    }
    Vec::new()
}

fn task_from_taskruns_entry(name: &str, entry: &Value) -> TaskRunStatus {
    let display_name = string_at(entry, &["pipelineTaskName"]);
    let status = entry.get("status").cloned().unwrap_or(Value::Null);
    let conditions = conditions_array(&status);
    let started_at = string_at(&status, &["startTime"]);
    let completion_time = string_at(&status, &["completionTime"]);
    let derived = derive_run_status(&conditions, started_at.is_some());
    let message = conditions
        .iter()
        .find(|c| c.get("type").and_then(|v| v.as_str()) == Some("Succeeded"))
        .and_then(|c| c.get("message").and_then(|v| v.as_str()).map(String::from));
    TaskRunStatus {
        name: name.to_string(),
        display_name,
        status: derived,
        duration_seconds: duration_between(started_at.as_deref(), completion_time.as_deref()),
        started_at,
        completion_time,
        message,
    }
}

fn extract_params(spec: &Value) -> Vec<(String, String)> {
    spec.get("params")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let name = string_at(p, &["name"])?;
                    // `value` is either a string, an array of strings, or
                    // an object (Tekton's "object" param type). Stringify
                    // the latter two so the UI can render uniformly.
                    let value = match p.get("value") {
                        Some(Value::String(s)) => s.clone(),
                        Some(other) => other.to_string(),
                        None => String::new(),
                    };
                    Some((name, value))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_workspaces(spec: &Value) -> Vec<String> {
    spec.get("workspaces")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|w| string_at(w, &["name"])).collect())
        .unwrap_or_default()
}

fn duration_between(start: Option<&str>, end: Option<&str>) -> Option<i64> {
    let s = chrono::DateTime::parse_from_rfc3339(start?).ok()?;
    let e = chrono::DateTime::parse_from_rfc3339(end?).ok()?;
    Some((e.timestamp() - s.timestamp()).max(0))
}

fn string_at(v: &Value, path: &[&str]) -> Option<String> {
    let mut cur = v;
    for p in path {
        cur = cur.get(*p)?;
    }
    cur.as_str().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kube::core::TypeMeta;

    fn dyn_obj(version: &str, json: Value) -> DynamicObject {
        let ar = pipeline_run_api_resource(version);
        let mut o = DynamicObject::new("x", &ar);
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
            api_version: format!("{TEKTON_GROUP}/{version}"),
            kind: PIPELINE_RUN_KIND.into(),
        });
        o
    }

    #[test]
    fn derive_status_succeeded_when_condition_true() {
        let conds = vec![json!({ "type": "Succeeded", "status": "True" })];
        assert_eq!(derive_run_status(&conds, true), "Succeeded");
    }

    #[test]
    fn derive_status_failed_when_condition_false_without_cancel_reason() {
        let conds = vec![json!({
            "type": "Succeeded",
            "status": "False",
            "reason": "TaskRunFailed"
        })];
        assert_eq!(derive_run_status(&conds, true), "Failed");
    }

    #[test]
    fn derive_status_cancelled_when_reason_says_so() {
        let conds = vec![json!({
            "type": "Succeeded",
            "status": "False",
            "reason": "Cancelled"
        })];
        assert_eq!(derive_run_status(&conds, true), "Cancelled");
        // The legacy reason form should also map to Cancelled.
        let conds2 = vec![json!({
            "type": "Succeeded",
            "status": "False",
            "reason": "PipelineRunCancelled"
        })];
        assert_eq!(derive_run_status(&conds2, true), "Cancelled");
    }

    #[test]
    fn derive_status_running_when_unknown_with_start_time() {
        let conds = vec![json!({ "type": "Succeeded", "status": "Unknown" })];
        assert_eq!(derive_run_status(&conds, true), "Running");
    }

    #[test]
    fn derive_status_pending_when_unknown_without_start_time() {
        let conds = vec![json!({ "type": "Succeeded", "status": "Unknown" })];
        assert_eq!(derive_run_status(&conds, false), "Pending");
    }

    #[test]
    fn derive_status_pending_when_no_conditions_and_not_started() {
        let conds: Vec<Value> = vec![];
        assert_eq!(derive_run_status(&conds, false), "Pending");
    }

    #[test]
    fn summarize_v1_uses_child_references_for_task_count() {
        let obj = dyn_obj(
            TEKTON_VERSION_V1,
            json!({
                "metadata": { "name": "build-and-deploy-abc", "namespace": "ci" },
                "spec": {
                    "pipelineRef": { "name": "build-and-deploy" }
                },
                "status": {
                    "startTime": "2026-05-04T10:00:00Z",
                    "completionTime": "2026-05-04T10:05:00Z",
                    "conditions": [
                        { "type": "Succeeded", "status": "True" }
                    ],
                    "childReferences": [
                        { "kind": "TaskRun", "name": "tr-1", "pipelineTaskName": "fetch" },
                        { "kind": "TaskRun", "name": "tr-2", "pipelineTaskName": "build" }
                    ]
                }
            }),
        );
        let s = summarize(&obj);
        assert_eq!(s.name, "build-and-deploy-abc");
        assert_eq!(s.namespace, "ci");
        assert_eq!(s.pipeline_ref.as_deref(), Some("build-and-deploy"));
        assert_eq!(s.status, "Succeeded");
        assert_eq!(s.task_count, 2);
        assert_eq!(s.duration_seconds, Some(300));
    }

    #[test]
    fn summarize_v1beta1_uses_task_runs_map_for_count_and_status() {
        let obj = dyn_obj(
            TEKTON_VERSION_V1BETA1,
            json!({
                "metadata": { "name": "legacy-run", "namespace": "ci" },
                "spec": { "pipelineRef": { "name": "legacy" } },
                "status": {
                    "startTime": "2026-05-04T10:00:00Z",
                    "conditions": [
                        { "type": "Succeeded", "status": "Unknown", "reason": "Running" }
                    ],
                    "taskRuns": {
                        "tr-a": { "pipelineTaskName": "a", "status": {} },
                        "tr-b": { "pipelineTaskName": "b", "status": {} },
                        "tr-c": { "pipelineTaskName": "c", "status": {} }
                    }
                }
            }),
        );
        let s = summarize(&obj);
        assert_eq!(s.task_count, 3);
        assert_eq!(s.status, "Running");
        // No completion time → no duration.
        assert_eq!(s.duration_seconds, None);
    }

    #[test]
    fn detail_extracts_v1beta1_task_status_from_taskruns_map() {
        let obj = dyn_obj(
            TEKTON_VERSION_V1BETA1,
            json!({
                "metadata": { "name": "pr-1", "namespace": "ci" },
                "spec": {
                    "pipelineRef": { "name": "build" },
                    "params": [
                        { "name": "git-revision", "value": "main" },
                        { "name": "image", "value": "registry/foo:latest" }
                    ],
                    "workspaces": [
                        { "name": "shared-data" },
                        { "name": "creds" }
                    ]
                },
                "status": {
                    "startTime": "2026-05-04T10:00:00Z",
                    "completionTime": "2026-05-04T10:10:00Z",
                    "conditions": [
                        { "type": "Succeeded", "status": "False", "reason": "Failed", "message": "step exited 1" }
                    ],
                    "taskRuns": {
                        "pr-1-fetch": {
                            "pipelineTaskName": "fetch",
                            "status": {
                                "startTime": "2026-05-04T10:00:05Z",
                                "completionTime": "2026-05-04T10:01:00Z",
                                "conditions": [
                                    { "type": "Succeeded", "status": "True" }
                                ]
                            }
                        },
                        "pr-1-build": {
                            "pipelineTaskName": "build",
                            "status": {
                                "startTime": "2026-05-04T10:01:10Z",
                                "completionTime": "2026-05-04T10:09:00Z",
                                "conditions": [
                                    { "type": "Succeeded", "status": "False", "reason": "Failed", "message": "step exited 1" }
                                ]
                            }
                        }
                    }
                }
            }),
        );
        let d = detail(&obj);
        assert_eq!(d.summary.status, "Failed");
        assert_eq!(d.tasks.len(), 2);
        // Sorted by start time → fetch first.
        assert_eq!(d.tasks[0].display_name.as_deref(), Some("fetch"));
        assert_eq!(d.tasks[0].status, "Succeeded");
        assert_eq!(d.tasks[1].display_name.as_deref(), Some("build"));
        assert_eq!(d.tasks[1].status, "Failed");
        assert_eq!(d.tasks[1].message.as_deref(), Some("step exited 1"));
        assert_eq!(d.params.len(), 2);
        assert_eq!(d.params[0].0, "git-revision");
        assert_eq!(d.params[0].1, "main");
        assert_eq!(d.workspaces, vec!["shared-data", "creds"]);
        // Top-level conditions surface in detail.conditions.
        assert_eq!(d.conditions.len(), 1);
        assert_eq!(d.conditions[0].type_, "Succeeded");
    }

    #[test]
    fn detail_extracts_v1_child_references_directory_with_unknown_status() {
        let obj = dyn_obj(
            TEKTON_VERSION_V1,
            json!({
                "metadata": { "name": "v1-run", "namespace": "ci" },
                "spec": { "pipelineRef": { "name": "build" } },
                "status": {
                    "childReferences": [
                        { "kind": "TaskRun", "name": "v1-run-fetch", "pipelineTaskName": "fetch" },
                        { "kind": "TaskRun", "name": "v1-run-build", "pipelineTaskName": "build" }
                    ]
                }
            }),
        );
        let d = detail(&obj);
        // v1 detail surfaces child refs as a directory; deep status
        // would require fetching each TaskRun individually (deferred).
        assert_eq!(d.tasks.len(), 2);
        assert!(d.tasks.iter().all(|t| t.status == "Unknown"));
        assert!(d
            .tasks
            .iter()
            .any(|t| t.display_name.as_deref() == Some("fetch")));
    }

    #[test]
    fn extract_params_handles_string_and_array_values() {
        let spec = json!({
            "params": [
                { "name": "rev", "value": "main" },
                { "name": "tags", "value": ["one", "two"] },
                { "name": "obj", "value": { "k": "v" } },
                { "name": "no-value" }
            ]
        });
        let params = extract_params(&spec);
        assert_eq!(params.len(), 4);
        assert_eq!(params[0], ("rev".into(), "main".into()));
        // Array / object values stringify as JSON.
        assert!(params[1].1.contains("one"));
        assert!(params[2].1.contains("\"k\":"));
        assert_eq!(params[3].1, "");
    }
}
