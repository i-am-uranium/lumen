//! Write-side operations on workloads.
//!
//! Deliberately narrow surface — every one of these corresponds to a single,
//! well-understood kubectl verb, and the UI wraps them in an explicit
//! confirmation dialog. No bulk edits, no apply-from-yaml — those deserve
//! their own focused skill and risk model.

use crate::error::{AppError, AppResult};
use crate::k8s::{registry, time, types::WorkloadKind};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job, JobSpec};
use k8s_openapi::api::core::v1::{Event, Node, Pod};
use k8s_openapi::api::policy::v1::Eviction;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{
    DeleteOptions, ObjectMeta, OwnerReference, Preconditions,
};
use kube::{
    api::{DeleteParams, ListParams, Patch, PatchParams, PostParams},
    core::{ApiResource, GroupVersionKind},
    Api, Client,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct EventSummary {
    /// Most recent observation (either event_time for newer events or
    /// last_timestamp for legacy). ISO-8601 in UTC.
    pub ts: Option<String>,
    pub type_: String,
    pub reason: String,
    pub message: String,
    pub involved_kind: String,
    pub involved_name: String,
    pub count: Option<i32>,
}

fn event_ts(e: &Event) -> Option<String> {
    if let Some(event_time) = e.event_time.as_ref() {
        Some(time::micro_rfc3339(event_time))
    } else {
        e.last_timestamp
            .as_ref()
            .or(e.first_timestamp.as_ref())
            .map(time::rfc3339)
    }
}

/// Fetch events directly involving `<kind>/<name>` in the given namespace.
/// Uses Kubernetes field selectors so the apiserver does the filtering.
///
/// Sibling resources (e.g. events on pods owned by a deployment) are not
/// included — callers that want them should query per-pod separately.
pub async fn list_events_for(
    client: &Client,
    namespace: &str,
    kind: WorkloadKind,
    name: &str,
) -> AppResult<Vec<EventSummary>> {
    let kind_str = registry::get_resource_definition(&kind)
        .map(|definition| registry::api_kind(&definition.kind))
        .unwrap_or("Unknown");
    let api: Api<Event> = Api::namespaced(client.clone(), namespace);
    let fs = format!("involvedObject.kind={kind_str},involvedObject.name={name}");
    let lp = ListParams::default().fields(&fs);
    let list = api
        .list(&lp)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let mut out: Vec<EventSummary> = list
        .items
        .into_iter()
        .map(|e| EventSummary {
            ts: event_ts(&e),
            type_: e.type_.clone().unwrap_or_default(),
            reason: e.reason.clone().unwrap_or_default(),
            message: e.message.clone().unwrap_or_default(),
            involved_kind: e.involved_object.kind.clone().unwrap_or_default(),
            involved_name: e.involved_object.name.clone().unwrap_or_default(),
            count: e.count,
        })
        .collect();
    // Newest first.
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    Ok(out)
}

/// Trigger a rolling restart the same way `kubectl rollout restart` does:
/// stamp the pod template with a timestamp annotation, which the controller
/// sees as a template change and rolls the pods.
pub async fn rollout_restart(
    client: &Client,
    namespace: &str,
    kind: WorkloadKind,
    name: &str,
) -> AppResult<()> {
    let ts = chrono::Utc::now().to_rfc3339();
    let patch = serde_json::json!({
        "spec": {
            "template": {
                "metadata": {
                    "annotations": {
                        "kubectl.kubernetes.io/restartedAt": ts,
                    }
                }
            }
        }
    });
    let pp = PatchParams::default();
    match kind {
        WorkloadKind::Deployment => Api::<Deployment>::namespaced(client.clone(), namespace)
            .patch(name, &pp, &Patch::Merge(&patch))
            .await
            .map(|_| ()),
        WorkloadKind::StatefulSet => Api::<StatefulSet>::namespaced(client.clone(), namespace)
            .patch(name, &pp, &Patch::Merge(&patch))
            .await
            .map(|_| ()),
        WorkloadKind::DaemonSet => Api::<DaemonSet>::namespaced(client.clone(), namespace)
            .patch(name, &pp, &Patch::Merge(&patch))
            .await
            .map(|_| ()),
        other => {
            return Err(AppError::K8s(format!(
                "rollout restart not supported for {other:?}"
            )))
        }
    }
    .map_err(|e| AppError::K8s(e.to_string()))
}

/// Set the image on a single container of a Deployment / StatefulSet /
/// DaemonSet — equivalent to `kubectl set image
/// deployment/<name> <container>=<image>`. Strategic merge patch matches
/// the existing container by name (the `name` field is the merge key for
/// `containers`), so the rest of the spec — env, volumes, probes, etc. —
/// is preserved untouched. The patch triggers a rolling update through
/// the controller's normal reconciliation loop.
pub async fn set_workload_image(
    client: &Client,
    namespace: &str,
    kind: WorkloadKind,
    name: &str,
    container: &str,
    image: &str,
) -> AppResult<()> {
    if container.is_empty() {
        return Err(AppError::K8s("container name must not be empty".into()));
    }
    if image.is_empty() {
        return Err(AppError::K8s("image must not be empty".into()));
    }
    let patch = serde_json::json!({
        "spec": {
            "template": {
                "spec": {
                    "containers": [
                        { "name": container, "image": image }
                    ]
                }
            }
        }
    });
    let pp = PatchParams::default();
    match kind {
        WorkloadKind::Deployment => Api::<Deployment>::namespaced(client.clone(), namespace)
            .patch(name, &pp, &Patch::Strategic(&patch))
            .await
            .map(|_| ()),
        WorkloadKind::StatefulSet => Api::<StatefulSet>::namespaced(client.clone(), namespace)
            .patch(name, &pp, &Patch::Strategic(&patch))
            .await
            .map(|_| ()),
        WorkloadKind::DaemonSet => Api::<DaemonSet>::namespaced(client.clone(), namespace)
            .patch(name, &pp, &Patch::Strategic(&patch))
            .await
            .map(|_| ()),
        other => {
            return Err(AppError::K8s(format!(
                "set image not supported for {other:?}"
            )))
        }
    }
    .map_err(|e| AppError::K8s(e.to_string()))
}

/// Set replicas via the Scale subresource. Supported for Deployment and
/// StatefulSet; DaemonSet replicas are driven by node count and cannot be
/// scaled.
pub async fn scale(
    client: &Client,
    namespace: &str,
    kind: WorkloadKind,
    name: &str,
    replicas: i32,
) -> AppResult<()> {
    if !(0..=1000).contains(&replicas) {
        return Err(AppError::K8s("replicas must be between 0 and 1000".into()));
    }
    let patch = serde_json::json!({ "spec": { "replicas": replicas } });
    let pp = PatchParams::default();
    match kind {
        WorkloadKind::Deployment => Api::<Deployment>::namespaced(client.clone(), namespace)
            .patch_scale(name, &pp, &Patch::Merge(&patch))
            .await
            .map(|_| ()),
        WorkloadKind::StatefulSet => Api::<StatefulSet>::namespaced(client.clone(), namespace)
            .patch_scale(name, &pp, &Patch::Merge(&patch))
            .await
            .map(|_| ()),
        other => return Err(AppError::K8s(format!("scale not supported for {other:?}"))),
    }
    .map_err(|e| AppError::K8s(e.to_string()))
}

// ─── Node lifecycle (cordon / uncordon / drain) ─────────────────────────

/// Set or clear `spec.unschedulable` on a Node — equivalent to `kubectl
/// cordon` / `kubectl uncordon`. A cordoned node still runs its existing
/// pods; the scheduler simply stops placing new ones on it.
async fn set_unschedulable(client: &Client, name: &str, unschedulable: bool) -> AppResult<()> {
    let api: Api<Node> = Api::all(client.clone());
    let patch = serde_json::json!({ "spec": { "unschedulable": unschedulable } });
    api.patch(name, &PatchParams::default(), &Patch::Merge(&patch))
        .await
        .map(|_| ())
        .map_err(|e| AppError::K8s(format!("patch node {name}: {e}")))
}

pub async fn cordon_node(client: &Client, name: &str) -> AppResult<()> {
    set_unschedulable(client, name, true).await
}

pub async fn uncordon_node(client: &Client, name: &str) -> AppResult<()> {
    set_unschedulable(client, name, false).await
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct DrainSummary {
    pub evicted: u32,
    pub skipped_daemonset: u32,
    pub skipped_mirror: u32,
    /// Pod name + reason — surfaced to the user so they can act on stuck pods
    /// (PDB blocking, finalizer, etc.) without re-running drain blindly.
    pub failed: Vec<DrainFailure>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DrainFailure {
    pub namespace: String,
    pub name: String,
    pub reason: String,
}

const MIRROR_POD_ANNOTATION: &str = "kubernetes.io/config.mirror";

/// Returns true if this pod is owned by a DaemonSet — those should never be
/// evicted by drain; the DS controller would just recreate them on the same
/// node.
fn is_daemonset_pod(pod: &Pod) -> bool {
    pod.metadata
        .owner_references
        .as_ref()
        .map(|refs| {
            refs.iter()
                .any(|r| r.controller.unwrap_or(false) && r.kind == "DaemonSet")
        })
        .unwrap_or(false)
}

/// Mirror pods (static pods reflected by the kubelet into the API) cannot be
/// evicted via the API — they're owned by the kubelet on disk. Skip silently.
fn is_mirror_pod(pod: &Pod) -> bool {
    pod.metadata
        .annotations
        .as_ref()
        .map(|m| m.contains_key(MIRROR_POD_ANNOTATION))
        .unwrap_or(false)
}

/// Try a PDB-respecting eviction first; on the typical "cannot evict" error
/// (which the API server returns as a 429 with a structured cause) the caller
/// can choose to fall back to a plain delete. For v1 we surface the eviction
/// error as a failure rather than auto-overriding PDBs — that's the safer
/// default and matches `kubectl drain` without `--force`.
async fn evict_pod(client: &Client, namespace: &str, name: &str) -> AppResult<()> {
    let pods: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let eviction = Eviction {
        delete_options: Some(DeleteOptions {
            preconditions: Some(Preconditions {
                resource_version: None,
                uid: None,
            }),
            ..Default::default()
        }),
        metadata: ObjectMeta {
            name: Some(name.to_string()),
            namespace: Some(namespace.to_string()),
            ..Default::default()
        },
    };
    let body = serde_json::to_vec(&eviction)
        .map_err(|e| AppError::Internal(format!("serialize eviction: {e}")))?;
    pods.create_subresource::<_, Eviction>("eviction", name, &PostParams::default(), &body)
        .await
        .map(|_| ())
        .map_err(|e| AppError::K8s(e.to_string()))
}

/// Drain a node: cordon, then evict every non-DaemonSet, non-mirror pod
/// scheduled on it. Returns a `DrainSummary` so the UI can show a per-pod
/// breakdown rather than a single boolean. PDB-blocked pods become entries
/// in `failed` — we never force-delete; that's a separate, deliberate action.
pub async fn drain_node(client: &Client, name: &str) -> AppResult<DrainSummary> {
    cordon_node(client, name).await?;

    let pods_api: Api<Pod> = Api::all(client.clone());
    let lp = ListParams::default().fields(&format!("spec.nodeName={name}"));
    let pods = pods_api
        .list(&lp)
        .await
        .map_err(|e| AppError::K8s(format!("list pods on node {name}: {e}")))?;

    let mut summary = DrainSummary::default();
    for pod in pods.items {
        if is_mirror_pod(&pod) {
            summary.skipped_mirror += 1;
            continue;
        }
        if is_daemonset_pod(&pod) {
            summary.skipped_daemonset += 1;
            continue;
        }
        let pod_ns = pod.metadata.namespace.clone().unwrap_or_default();
        let pod_name = pod.metadata.name.clone().unwrap_or_default();
        if pod_name.is_empty() || pod_ns.is_empty() {
            continue;
        }
        match evict_pod(client, &pod_ns, &pod_name).await {
            Ok(()) => summary.evicted += 1,
            Err(e) => summary.failed.push(DrainFailure {
                namespace: pod_ns,
                name: pod_name,
                reason: e.to_string(),
            }),
        }
    }
    Ok(summary)
}

// ─── CronJob manual trigger ─────────────────────────────────────────────

/// Build the name of the one-off Job created for a manual CronJob trigger.
///
/// Job/Pod names are DNS-1123 labels: ≤ 63 chars and they must end in an
/// alphanumeric. We append `-manual-<unix-secs>` (always alphanumeric-tailed)
/// to the cronjob name and truncate the *prefix* if the combined string would
/// exceed 63. If the truncated prefix ends in `-` or `.` we trim it so the
/// boundary char is never an illegal terminator on its own.
fn derive_manual_job_name(cronjob_name: &str, unix_secs: i64) -> String {
    const MAX: usize = 63;
    let suffix = format!("-manual-{unix_secs}");
    let max_prefix = MAX.saturating_sub(suffix.len());
    let mut prefix: String = cronjob_name.chars().take(max_prefix).collect();
    // Strip any trailing non-alphanumeric chars from the truncated prefix so
    // the join point (`<prefix>-manual-...`) starts cleanly.
    while prefix
        .chars()
        .last()
        .map(|c| !c.is_ascii_alphanumeric())
        .unwrap_or(false)
    {
        prefix.pop();
    }
    format!("{prefix}{suffix}")
}

/// Manually trigger a CronJob by creating a one-off Job from its
/// `spec.jobTemplate`. Mirrors `kubectl create job --from=cronjob/<name>`:
/// the new Job's name is `<cronjob>-manual-<unix-secs>`, it carries an
/// ownerReference to the CronJob (so the existing GC and history limits
/// apply), and inherits the cronjob's job-template labels & annotations.
pub async fn trigger_cronjob(client: &Client, namespace: &str, name: &str) -> AppResult<String> {
    let cronjobs: Api<CronJob> = Api::namespaced(client.clone(), namespace);
    let cj = cronjobs
        .get(name)
        .await
        .map_err(|e| AppError::K8s(format!("fetch cronjob {name}: {e}")))?;

    let template = cj
        .spec
        .as_ref()
        .map(|s| &s.job_template)
        .ok_or_else(|| AppError::K8s(format!("cronjob {name} has no spec")))?;

    let job_spec: JobSpec = template
        .spec
        .clone()
        .ok_or_else(|| AppError::K8s(format!("cronjob {name} jobTemplate has no spec")))?;

    let unix_secs = chrono::Utc::now().timestamp();
    let job_name = derive_manual_job_name(name, unix_secs);

    let cj_uid = cj
        .metadata
        .uid
        .clone()
        .ok_or_else(|| AppError::K8s(format!("cronjob {name} has no uid")))?;

    let owner = OwnerReference {
        api_version: "batch/v1".to_string(),
        kind: "CronJob".to_string(),
        name: name.to_string(),
        uid: cj_uid,
        controller: Some(true),
        block_owner_deletion: Some(true),
    };

    // Carry forward labels/annotations from the cronjob's job template, then
    // overlay the standard `cronjob.kubernetes.io/instantiate=manual` marker
    // so the new Job is easy to spot in `kubectl get jobs`.
    let mut labels = template
        .metadata
        .as_ref()
        .and_then(|m| m.labels.clone())
        .unwrap_or_default();
    labels
        .entry("cronjob.kubernetes.io/instantiate".to_string())
        .or_insert_with(|| "manual".to_string());

    let annotations = template
        .metadata
        .as_ref()
        .and_then(|m| m.annotations.clone());

    let job = Job {
        metadata: ObjectMeta {
            name: Some(job_name.clone()),
            namespace: Some(namespace.to_string()),
            labels: Some(labels),
            annotations,
            owner_references: Some(vec![owner]),
            ..Default::default()
        },
        spec: Some(job_spec),
        status: None,
    };

    let jobs: Api<Job> = Api::namespaced(client.clone(), namespace);
    jobs.create(&PostParams::default(), &job)
        .await
        .map(|_| job_name)
        .map_err(|e| AppError::K8s(format!("create job from cronjob {name}: {e}")))
}

/// Delete a single pod. The controller (ReplicaSet / StatefulSet / DaemonSet
/// / Job) recreates it unless it's a bare pod.
pub async fn delete_pod(client: &Client, namespace: &str, name: &str) -> AppResult<()> {
    Api::<Pod>::namespaced(client.clone(), namespace)
        .delete(name, &DeleteParams::default())
        .await
        .map(|_| ())
        .map_err(|e| AppError::K8s(e.to_string()))
}

// ─── CronJob manual-run history (C3) ────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ManualRunSummary {
    pub name: String,
    /// Active / Succeeded / Failed / Pending — collapsed from JobStatus.
    pub status: String,
    /// ISO-8601 in UTC; None for jobs that haven't started or completed yet.
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    /// Pod-level rollup so the UI can render "1/1" or "0/3 succeeded".
    pub succeeded: i32,
    pub failed: i32,
    pub active: i32,
}

const MANUAL_INSTANTIATE_LABEL: &str = "cronjob.kubernetes.io/instantiate";

/// List Jobs that were created by a manual trigger of a given CronJob.
///
/// We filter by both the standard `cronjob.kubernetes.io/instantiate=manual`
/// label (which `trigger_cronjob` stamps on every manual Job) AND by an
/// ownerReference back to the CronJob — owner check is the source of truth
/// since the label can be removed by hand. Results are newest-first.
pub async fn list_manual_cronjob_runs(
    client: &Client,
    namespace: &str,
    cronjob_name: &str,
) -> AppResult<Vec<ManualRunSummary>> {
    let jobs: Api<Job> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default().labels(&format!("{MANUAL_INSTANTIATE_LABEL}=manual"));
    let list = jobs
        .list(&lp)
        .await
        .map_err(|e| AppError::K8s(format!("list manual runs for {cronjob_name}: {e}")))?;

    let mut out: Vec<ManualRunSummary> = list
        .items
        .into_iter()
        .filter(|job| {
            // OwnerRef must point at this exact cronjob — guards against
            // tag-collision when multiple cronjobs use the same label.
            job.metadata
                .owner_references
                .as_ref()
                .map(|refs| {
                    refs.iter()
                        .any(|r| r.kind == "CronJob" && r.name == cronjob_name)
                })
                .unwrap_or(false)
        })
        .map(|job| {
            let status = job.status.as_ref();
            let succeeded = status.and_then(|s| s.succeeded).unwrap_or(0);
            let failed = status.and_then(|s| s.failed).unwrap_or(0);
            let active = status.and_then(|s| s.active).unwrap_or(0);
            // Rolled-up status string for the UI. Match `kubectl get job`'s
            // mental model: Failed > Succeeded > Active > Pending.
            let phase = if failed > 0 {
                "Failed"
            } else if succeeded > 0 && active == 0 {
                "Succeeded"
            } else if active > 0 {
                "Active"
            } else {
                "Pending"
            };
            ManualRunSummary {
                name: job.metadata.name.clone().unwrap_or_default(),
                status: phase.to_string(),
                started_at: status
                    .and_then(|s| s.start_time.as_ref())
                    .map(time::rfc3339),
                completed_at: status
                    .and_then(|s| s.completion_time.as_ref())
                    .map(time::rfc3339),
                succeeded,
                failed,
                active,
            }
        })
        .collect();
    // Newest-first by start time; jobs without a start time sink to the bottom.
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(out)
}

pub async fn delete_resource(
    client: &Client,
    namespace: &str,
    kind: WorkloadKind,
    name: &str,
) -> AppResult<()> {
    let definition = registry::get_resource_definition(&kind)
        .ok_or_else(|| AppError::Internal(format!("resource kind {kind:?} is not registered")))?;
    let ar = api_resource_for(&kind)?;
    let api: Api<kube::api::DynamicObject> = if definition.namespaced {
        Api::namespaced_with(client.clone(), namespace, &ar)
    } else {
        Api::all_with(client.clone(), &ar)
    };
    api.delete(name, &DeleteParams::default())
        .await
        .map(|_| ())
        .map_err(|e| AppError::K8s(e.to_string()))
}

// ─── YAML apply ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ApplyOutcome {
    /// Server-rendered YAML after the apply. For dry-run this is what *would*
    /// end up in the cluster; for live apply it's the actual new state.
    pub yaml: String,
    /// Whether the apply was a dry-run (server-validated, not persisted).
    pub dry_run: bool,
}

fn api_resource_for(kind: &WorkloadKind) -> AppResult<ApiResource> {
    let definition = registry::get_resource_definition(kind)
        .ok_or_else(|| AppError::Internal(format!("resource kind {kind:?} is not registered")))?;
    let gvk = GroupVersionKind::gvk(
        definition.api_group,
        definition.version,
        registry::api_kind(kind),
    );
    Ok(ApiResource::from_gvk_with_plural(&gvk, definition.plural))
}

fn prepare_apply_manifest(
    kind: &WorkloadKind,
    namespace: &str,
    name: &str,
    yaml_text: &str,
) -> AppResult<serde_json::Value> {
    let definition = registry::get_resource_definition(kind)
        .ok_or_else(|| AppError::Internal(format!("resource kind {kind:?} is not registered")))?;
    let mut value: serde_json::Value = serde_yaml::from_str(yaml_text)
        .map_err(|e| AppError::Internal(format!("yaml parse: {e}")))?;

    let obj = value
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("yaml root must be a Kubernetes object".into()))?;
    let meta = obj
        .entry("metadata")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("metadata must be an object".into()))?;

    let body_name = meta.get("name").and_then(|v| v.as_str()).unwrap_or(name);
    if body_name != name {
        return Err(AppError::K8s(format!(
            "refusing to apply: metadata.name '{body_name}' differs from target '{name}'. \
             Renaming a resource needs delete+create, not apply."
        )));
    }

    if definition.namespaced {
        let body_ns = meta.get("namespace").and_then(|v| v.as_str());
        if let Some(body_ns) = body_ns {
            if body_ns != namespace {
                return Err(AppError::K8s(format!(
                    "refusing to apply: metadata.namespace '{body_ns}' differs from target '{namespace}'."
                )));
            }
        }
        meta.insert(
            "namespace".into(),
            serde_json::Value::String(namespace.into()),
        );
    } else {
        meta.remove("namespace");
    }
    meta.insert("name".into(), serde_json::Value::String(name.into()));

    Ok(value)
}

/// Server-side apply a user-edited manifest. We parse the incoming YAML,
/// pin the name/namespace from the URL path to keep callers honest (edits
/// that rename or move a resource must go through the wizard, not here),
/// and use `PatchParams::apply("lumen")` so repeated edits cooperate under
/// the same field manager.
pub async fn apply_resource(
    client: &Client,
    namespace: &str,
    kind: WorkloadKind,
    name: &str,
    yaml_text: &str,
    dry_run: bool,
) -> AppResult<ApplyOutcome> {
    let value = prepare_apply_manifest(&kind, namespace, name, yaml_text)?;

    let mut pp = PatchParams::apply("lumen").force();
    if dry_run {
        pp = pp.dry_run();
    }

    // Use the same match arms the read side does, so kube resolves the right
    // API group/version and we get typed errors.
    let patch = Patch::Apply(&value);
    let yaml_out = match kind {
        WorkloadKind::Deployment => {
            let obj = Api::<Deployment>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        WorkloadKind::StatefulSet => {
            let obj = Api::<StatefulSet>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        WorkloadKind::DaemonSet => {
            let obj = Api::<DaemonSet>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        WorkloadKind::CronJob => {
            use k8s_openapi::api::batch::v1::CronJob;
            let obj = Api::<CronJob>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        WorkloadKind::Service => {
            use k8s_openapi::api::core::v1::Service;
            let obj = Api::<Service>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        WorkloadKind::Ingress => {
            use k8s_openapi::api::networking::v1::Ingress;
            let obj = Api::<Ingress>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        WorkloadKind::ConfigMap => {
            use k8s_openapi::api::core::v1::ConfigMap;
            let obj = Api::<ConfigMap>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        WorkloadKind::Secret => {
            use k8s_openapi::api::core::v1::Secret;
            let obj = Api::<Secret>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        WorkloadKind::NetworkPolicy => {
            use k8s_openapi::api::networking::v1::NetworkPolicy;
            let obj = Api::<NetworkPolicy>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        WorkloadKind::PersistentVolumeClaim => {
            use k8s_openapi::api::core::v1::PersistentVolumeClaim;
            let obj = Api::<PersistentVolumeClaim>::namespaced(client.clone(), namespace)
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
        other => {
            let ar = api_resource_for(&other)?;
            let definition = registry::get_resource_definition(&other).ok_or_else(|| {
                AppError::Internal(format!("resource kind {other:?} is not registered"))
            })?;
            let api: Api<kube::api::DynamicObject> = if definition.namespaced {
                Api::namespaced_with(client.clone(), namespace, &ar)
            } else {
                Api::all_with(client.clone(), &ar)
            };
            let obj = api
                .patch(name, &pp, &patch)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?
        }
    };
    Ok(ApplyOutcome {
        yaml: yaml_out,
        dry_run,
    })
}

#[cfg(test)]
mod tests {
    use super::{derive_manual_job_name, prepare_apply_manifest, rollout_restart};
    use crate::k8s::types::WorkloadKind;
    use kube::{Client, Config};
    use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};

    async fn mock_client(server: &MockServer) -> Client {
        let uri = server.uri().parse().unwrap();
        Client::try_from(Config::new(uri)).unwrap()
    }

    #[test]
    fn derive_manual_job_name_short_cronjob_passes_through() {
        let n = derive_manual_job_name("nightly-backup", 1_700_000_000);
        assert_eq!(n, "nightly-backup-manual-1700000000");
        assert!(n.len() <= 63);
    }

    #[test]
    fn derive_manual_job_name_truncates_long_cronjob_to_dns_label_limit() {
        // 60-char name + `-manual-1700000000` (18 chars) would be 78 — must be capped at 63.
        let cj = "a".repeat(60);
        let n = derive_manual_job_name(&cj, 1_700_000_000);
        assert!(n.len() <= 63, "got {} chars: {}", n.len(), n);
        assert!(n.ends_with("-manual-1700000000"));
    }

    #[test]
    fn derive_manual_job_name_strips_dash_at_truncation_boundary() {
        // Truncation lands exactly on a `-`; the trailing dash must be removed
        // so `<prefix>-manual-...` doesn't become `<prefix>--manual-...`.
        let cj = "abcdef-".to_string() + &"x".repeat(60);
        let n = derive_manual_job_name(&cj, 1_700_000_000);
        assert!(!n.contains("--manual"), "got: {n}");
        assert!(n.len() <= 63);
    }

    #[test]
    fn derive_manual_job_name_handles_empty_cronjob_name() {
        // Edge case: should not panic on empty/whitespace input.
        let n = derive_manual_job_name("", 1_700_000_000);
        assert_eq!(n, "-manual-1700000000");
    }

    #[test]
    fn prepare_apply_manifest_pins_namespaced_metadata() {
        let yaml = r#"
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec: {}
"#;

        let prepared =
            prepare_apply_manifest(&WorkloadKind::Deployment, "apps", "api", yaml).unwrap();

        assert_eq!(prepared["metadata"]["name"], "api");
        assert_eq!(prepared["metadata"]["namespace"], "apps");
    }

    #[test]
    fn prepare_apply_manifest_does_not_add_namespace_to_cluster_scoped_resources() {
        let yaml = r#"
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: view-extra
rules: []
"#;

        let prepared =
            prepare_apply_manifest(&WorkloadKind::ClusterRole, "ignored", "view-extra", yaml)
                .unwrap();

        assert_eq!(prepared["metadata"]["name"], "view-extra");
        assert!(prepared["metadata"].get("namespace").is_none());
    }

    #[test]
    fn prepare_apply_manifest_rejects_target_name_changes() {
        let yaml = r#"
apiVersion: v1
kind: ConfigMap
metadata:
  name: other
"#;

        let err =
            prepare_apply_manifest(&WorkloadKind::ConfigMap, "apps", "settings", yaml).unwrap_err();

        assert!(err.to_string().contains("metadata.name 'other' differs"));
    }

    #[tokio::test]
    async fn rollout_restart_sends_merge_patch_without_apply_force() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "apiVersion": "apps/v1",
                "kind": "Deployment",
                "metadata": { "name": "api", "namespace": "apps" }
            })))
            .expect(1)
            .mount(&server)
            .await;

        rollout_restart(
            &mock_client(&server).await,
            "apps",
            WorkloadKind::Deployment,
            "api",
        )
        .await
        .unwrap();

        let requests = server.received_requests().await.unwrap();
        let request = requests
            .first()
            .expect("expected one rollout patch request");

        assert_eq!(
            request.url.path(),
            "/apis/apps/v1/namespaces/apps/deployments/api"
        );
        assert!(request.url.query_pairs().all(|(k, _)| k != "force"));
        assert!(request.url.query_pairs().all(|(k, _)| k != "fieldManager"));
        assert_eq!(
            request.headers["content-type"],
            "application/merge-patch+json"
        );

        let body: serde_json::Value = request.body_json().unwrap();
        assert!(body
            .pointer("/spec/template/metadata/annotations/kubectl.kubernetes.io~1restartedAt")
            .and_then(|v| v.as_str())
            .is_some());
    }
}
