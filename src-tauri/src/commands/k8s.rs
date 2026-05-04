use crate::error::{AppError, AppResult};
use crate::k8s::{
    actions as act, cloudmap, crd as crd_mod, fleet, kubeconfig, metrics, rbac_admin, resources,
    security,
    types::{
        CloudMap, ContainerInfo, ContextInfo, FleetCard, NodeSummary, OwnerRefLite, PodCondition,
        PodDetails, ResourceDetail, SecurityReport, WorkloadKind, WorkloadSummary,
    },
};
use crate::state::AppState;
use k8s_openapi::api::{
    admissionregistration::v1::{MutatingWebhookConfiguration, ValidatingWebhookConfiguration},
    apps::v1::{DaemonSet, Deployment, StatefulSet},
    autoscaling::v2::HorizontalPodAutoscaler,
    batch::v1::{CronJob, Job},
    core::v1::{
        ConfigMap, LimitRange, Namespace, PersistentVolume, PersistentVolumeClaim, Pod,
        ResourceQuota, Secret, Service,
    },
    networking::v1::{Ingress, IngressClass, NetworkPolicy},
    policy::v1::PodDisruptionBudget,
    scheduling::v1::PriorityClass,
    storage::v1::StorageClass,
};
use kube::{api::ListParams, Api};
use tauri::{AppHandle, State};

fn owner_refs_from(
    meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta,
) -> Vec<OwnerRefLite> {
    meta.owner_references
        .as_ref()
        .map(|v| {
            v.iter()
                .map(|o| OwnerRefLite {
                    kind: o.kind.clone(),
                    name: o.name.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Resolve a kube::Client from either an explicit context (new multi-cluster
/// flows) or the active context (legacy single-cluster flows).
async fn client_for(state: &AppState, context: Option<&str>) -> AppResult<kube::Client> {
    let ctx = state.k8s.resolve_context(context).await?;
    state.k8s.client_for(&ctx).await
}

// ─── Contexts & namespaces ────────────────────────────────────────────────

#[tauri::command]
pub async fn list_contexts() -> AppResult<Vec<ContextInfo>> {
    let kc = kubeconfig::load()?;
    Ok(kubeconfig::list_contexts_from(&kc))
}

#[tauri::command]
pub async fn set_context(name: String, state: State<'_, AppState>) -> AppResult<ContextInfo> {
    state.k8s.set_context(&name).await?;
    let kc = kubeconfig::load()?;
    let ctxs = kubeconfig::list_contexts_from(&kc);
    ctxs.into_iter()
        .find(|c| c.name == name)
        .ok_or_else(|| AppError::Kubeconfig(format!("context '{name}' not found after switch")))
}

#[tauri::command]
pub async fn delete_context(
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    kubeconfig::delete_context(&app, &name)?;
    state.k8s.invalidate(&name).await;
    metrics::invalidate_context(&name);
    Ok(())
}

#[tauri::command]
pub async fn list_deleted_contexts(
    app: AppHandle,
) -> AppResult<Vec<kubeconfig::DeletedContextSummary>> {
    kubeconfig::list_deleted_contexts(&app)
}

#[tauri::command]
pub async fn restore_deleted_context(
    name: String,
    overwrite: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<()> {
    kubeconfig::restore_deleted_context(&app, &name, overwrite)?;
    state.k8s.invalidate(&name).await;
    metrics::invalidate_context(&name);
    Ok(())
}

#[tauri::command]
pub async fn list_namespaces(
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<String>> {
    let client = client_for(&state, context.as_deref()).await?;
    let api: Api<Namespace> = Api::all(client);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(list
        .items
        .into_iter()
        .filter_map(|n| n.metadata.name)
        .collect())
}

// ─── Fleet ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_fleet(state: State<'_, AppState>) -> AppResult<Vec<FleetCard>> {
    fleet::probe_all(&state.k8s).await
}

#[tauri::command]
pub async fn probe_fleet_context(
    context: String,
    state: State<'_, AppState>,
) -> AppResult<FleetCard> {
    fleet::probe_context(&state.k8s, &context).await
}

#[tauri::command]
pub async fn disconnect_context(
    context: String,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.k8s.invalidate(&context).await;
    metrics::invalidate_context(&context);
    Ok(())
}

/// Evict every cached client so the next call rebuilds fresh connections.
/// Useful when a private network route just came up or kubeconfig changed on disk.
#[tauri::command]
pub async fn reconnect_all(state: State<'_, AppState>) -> AppResult<()> {
    state.k8s.invalidate_all().await;
    metrics::invalidate_all();
    Ok(())
}

#[tauri::command]
pub async fn list_nodes(
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<NodeSummary>> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let client = state.k8s.client_for(&ctx).await?;
    fleet::list_nodes(&client, &ctx).await
}

// ─── CloudMap & Security ──────────────────────────────────────────────────

#[tauri::command]
pub async fn cloud_map(
    context: Option<String>,
    namespace: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<CloudMap> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let client = state.k8s.client_for(&ctx).await?;
    let mut m = cloudmap::build(&client, &ctx, namespace).await?;
    m.context = ctx;
    Ok(m)
}

#[tauri::command]
pub async fn security_scan(
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<SecurityReport> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let client = state.k8s.client_for(&ctx).await?;
    security::scan(&client, ctx).await
}

// ─── Workloads ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_workloads(
    namespace: String,
    kind: WorkloadKind,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<WorkloadSummary>> {
    let client = client_for(&state, context.as_deref()).await?;
    let lp = ListParams::default();
    let summaries: Vec<WorkloadSummary> = match kind {
        WorkloadKind::Deployment => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::deployment_summary)
                .collect()
        }
        WorkloadKind::StatefulSet => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::statefulset_summary)
                .collect()
        }
        WorkloadKind::DaemonSet => {
            let api: Api<DaemonSet> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::daemonset_summary)
                .collect()
        }
        WorkloadKind::CronJob => {
            let api: Api<CronJob> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::cronjob_summary)
                .collect()
        }
        WorkloadKind::Job => {
            let api: Api<Job> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::job_summary)
                .collect()
        }
        WorkloadKind::Pod => {
            let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
            let mut summaries: Vec<WorkloadSummary> = api
                .list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::pod_summary)
                .collect();
            // Fold metrics-server data (cached, ~free) into pod rows so the
            // table can show CPU/Memory without N+1 frontend round-trips.
            // Skip silently when metrics-server is unavailable.
            let ctx_name = context.as_deref().unwrap_or("");
            if !ctx_name.is_empty() {
                if let Some(usage) = crate::k8s::metrics::pod_usage(&client, ctx_name).await {
                    let mut by_key: std::collections::HashMap<(String, String), (i64, i64)> =
                        std::collections::HashMap::with_capacity(usage.len());
                    for u in usage {
                        by_key.insert((u.namespace, u.name), (u.cpu_milli, u.mem_bytes));
                    }
                    for s in summaries.iter_mut() {
                        if let Some((cpu, mem)) =
                            by_key.get(&(s.namespace.clone(), s.name.clone()))
                        {
                            s.cpu_milli = Some(*cpu);
                            s.mem_bytes = Some(*mem);
                        }
                    }
                }
            }
            summaries
        }
        WorkloadKind::Service => {
            let api: Api<Service> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::service_summary)
                .collect()
        }
        WorkloadKind::Ingress => {
            let api: Api<Ingress> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::ingress_summary)
                .collect()
        }
        WorkloadKind::ConfigMap => {
            let api: Api<ConfigMap> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::configmap_summary)
                .collect()
        }
        WorkloadKind::Secret => {
            let api: Api<Secret> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::secret_summary)
                .collect()
        }
        WorkloadKind::NetworkPolicy => {
            let api: Api<NetworkPolicy> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::networkpolicy_summary)
                .collect()
        }
        WorkloadKind::PersistentVolumeClaim => {
            let api: Api<PersistentVolumeClaim> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::pvc_summary)
                .collect()
        }
        // Cluster-scoped — namespace arg ignored, use Api::all.
        WorkloadKind::PersistentVolume => {
            let api: Api<PersistentVolume> = Api::all(client);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::pv_summary)
                .collect()
        }
        WorkloadKind::StorageClass => {
            let api: Api<StorageClass> = Api::all(client);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::storage_class_summary)
                .collect()
        }
        WorkloadKind::IngressClass => {
            let api: Api<IngressClass> = Api::all(client);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::ingress_class_summary)
                .collect()
        }
        WorkloadKind::ResourceQuota => {
            let api: Api<ResourceQuota> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::resource_quota_summary)
                .collect()
        }
        WorkloadKind::HorizontalPodAutoscaler => {
            let api: Api<HorizontalPodAutoscaler> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::hpa_summary)
                .collect()
        }
        // PR D+1 long-tail kinds.
        WorkloadKind::LimitRange => {
            let api: Api<LimitRange> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::limit_range_summary)
                .collect()
        }
        WorkloadKind::PodDisruptionBudget => {
            let api: Api<PodDisruptionBudget> = Api::namespaced(client, &namespace);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::pdb_summary)
                .collect()
        }
        WorkloadKind::PriorityClass => {
            let api: Api<PriorityClass> = Api::all(client);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::priority_class_summary)
                .collect()
        }
        WorkloadKind::MutatingWebhookConfiguration => {
            let api: Api<MutatingWebhookConfiguration> = Api::all(client);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::mutating_webhook_summary)
                .collect()
        }
        WorkloadKind::ValidatingWebhookConfiguration => {
            let api: Api<ValidatingWebhookConfiguration> = Api::all(client);
            api.list(&lp)
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?
                .items
                .iter()
                .map(resources::validating_webhook_summary)
                .collect()
        }
    };
    Ok(summaries)
}

#[tauri::command]
pub async fn get_resource(
    namespace: String,
    kind: WorkloadKind,
    name: String,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<ResourceDetail> {
    let client = client_for(&state, context.as_deref()).await?;
    match kind {
        WorkloadKind::Deployment => {
            let api: Api<Deployment> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::deployment_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::StatefulSet => {
            let api: Api<StatefulSet> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::statefulset_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::DaemonSet => {
            let api: Api<DaemonSet> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::daemonset_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::CronJob => {
            let api: Api<CronJob> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::cronjob_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::Job => {
            let api: Api<Job> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::job_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::Pod => {
            let api: Api<Pod> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::pod_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::Service => {
            let api: Api<Service> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::service_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::Ingress => {
            let api: Api<Ingress> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::ingress_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::ConfigMap => {
            let api: Api<ConfigMap> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::configmap_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::Secret => {
            let api: Api<Secret> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::secret_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::NetworkPolicy => {
            let api: Api<NetworkPolicy> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::networkpolicy_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::PersistentVolumeClaim => {
            let api: Api<PersistentVolumeClaim> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::pvc_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::PersistentVolume => {
            let api: Api<PersistentVolume> = Api::all(client);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::pv_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::StorageClass => {
            let api: Api<StorageClass> = Api::all(client);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::storage_class_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::IngressClass => {
            let api: Api<IngressClass> = Api::all(client);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::ingress_class_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::ResourceQuota => {
            let api: Api<ResourceQuota> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::resource_quota_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::HorizontalPodAutoscaler => {
            let api: Api<HorizontalPodAutoscaler> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::hpa_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::LimitRange => {
            let api: Api<LimitRange> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::limit_range_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::PodDisruptionBudget => {
            let api: Api<PodDisruptionBudget> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::pdb_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::PriorityClass => {
            let api: Api<PriorityClass> = Api::all(client);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::priority_class_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::MutatingWebhookConfiguration => {
            let api: Api<MutatingWebhookConfiguration> = Api::all(client);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::mutating_webhook_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
        WorkloadKind::ValidatingWebhookConfiguration => {
            let api: Api<ValidatingWebhookConfiguration> = Api::all(client);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let summary = resources::validating_webhook_summary(&obj);
            let yaml = serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))?;
            let owner_refs = owner_refs_from(&obj.metadata);
            Ok(ResourceDetail { summary, yaml, owner_refs })
        }
    }
}

// ─── Streams ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn stream_events(
    namespace: Option<String>,
    stream_id: String,
    channel: tauri::ipc::Channel<crate::k8s::events::EventLine>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let client = client_for(&state, context.as_deref()).await?;
    let cancel = tokio_util::sync::CancellationToken::new();
    state
        .k8s
        .streams
        .write()
        .await
        .insert(stream_id.clone(), cancel.clone());
    tokio::spawn(async move {
        let _ = crate::k8s::events::stream_events(client, namespace, channel, cancel).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn watch_nodes(
    stream_id: String,
    channel: tauri::ipc::Channel<crate::k8s::watch::WatchEvent<crate::k8s::types::NodeSummary>>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let client = client_for(&state, context.as_deref()).await?;
    let cancel = tokio_util::sync::CancellationToken::new();
    state
        .k8s
        .streams
        .write()
        .await
        .insert(stream_id.clone(), cancel.clone());
    tokio::spawn(async move {
        let _ = crate::k8s::watch::watch_nodes(client, channel, cancel).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn watch_workloads(
    namespace: Option<String>,
    stream_id: String,
    channel: tauri::ipc::Channel<crate::k8s::watch::WatchEvent<crate::k8s::types::WorkloadSummary>>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let client = client_for(&state, context.as_deref()).await?;
    let cancel = tokio_util::sync::CancellationToken::new();
    state
        .k8s
        .streams
        .write()
        .await
        .insert(stream_id.clone(), cancel.clone());
    tokio::spawn(async move {
        let _ = crate::k8s::watch::watch_workloads(client, namespace, channel, cancel).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn stop_stream(stream_id: String, state: State<'_, AppState>) -> AppResult<()> {
    if let Some(c) = state.k8s.streams.write().await.remove(&stream_id) {
        c.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn stream_logs(
    selector: crate::k8s::logs::LogSelector,
    stream_id: String,
    channel: tauri::ipc::Channel<crate::k8s::logs::LogLine>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let client = client_for(&state, context.as_deref()).await?;
    let cancel = tokio_util::sync::CancellationToken::new();
    state
        .k8s
        .streams
        .write()
        .await
        .insert(stream_id.clone(), cancel.clone());
    tokio::spawn(async move {
        let _ = crate::k8s::logs::stream_logs(client, selector, channel, cancel).await;
    });
    Ok(())
}

fn label_selector_from(labels: &std::collections::BTreeMap<String, String>) -> String {
    labels
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",")
}

#[tauri::command]
pub async fn list_pods_for(
    namespace: String,
    kind: WorkloadKind,
    name: String,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<WorkloadSummary>> {
    let client = client_for(&state, context.as_deref()).await?;
    match kind {
        WorkloadKind::Deployment => {
            let api: Api<Deployment> = Api::namespaced(client.clone(), &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let match_labels = obj
                .spec
                .as_ref()
                .and_then(|s| s.selector.match_labels.clone())
                .unwrap_or_default();
            if match_labels.is_empty() {
                return Ok(vec![]);
            }
            let ls = label_selector_from(
                &match_labels.into_iter().collect::<std::collections::BTreeMap<_, _>>(),
            );
            let pods: Api<Pod> = Api::namespaced(client, &namespace);
            let list = pods
                .list(&ListParams::default().labels(&ls))
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            Ok(list.items.iter().map(resources::pod_summary).collect())
        }
        WorkloadKind::StatefulSet => {
            let api: Api<StatefulSet> = Api::namespaced(client.clone(), &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let match_labels = obj
                .spec
                .as_ref()
                .and_then(|s| s.selector.match_labels.clone())
                .unwrap_or_default();
            if match_labels.is_empty() {
                return Ok(vec![]);
            }
            let ls = label_selector_from(
                &match_labels.into_iter().collect::<std::collections::BTreeMap<_, _>>(),
            );
            let pods: Api<Pod> = Api::namespaced(client, &namespace);
            let list = pods
                .list(&ListParams::default().labels(&ls))
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            Ok(list.items.iter().map(resources::pod_summary).collect())
        }
        WorkloadKind::DaemonSet => {
            let api: Api<DaemonSet> = Api::namespaced(client.clone(), &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            let match_labels = obj
                .spec
                .as_ref()
                .and_then(|s| s.selector.match_labels.clone())
                .unwrap_or_default();
            if match_labels.is_empty() {
                return Ok(vec![]);
            }
            let ls = label_selector_from(
                &match_labels.into_iter().collect::<std::collections::BTreeMap<_, _>>(),
            );
            let pods: Api<Pod> = Api::namespaced(client, &namespace);
            let list = pods
                .list(&ListParams::default().labels(&ls))
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            Ok(list.items.iter().map(resources::pod_summary).collect())
        }
        WorkloadKind::CronJob => {
            let jobs_api: Api<Job> = Api::namespaced(client.clone(), &namespace);
            let jobs_list = jobs_api
                .list(&ListParams::default())
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            let owned_jobs: Vec<String> = jobs_list
                .items
                .iter()
                .filter(|j| {
                    j.metadata
                        .owner_references
                        .as_ref()
                        .map(|v| v.iter().any(|o| o.kind == "CronJob" && o.name == name))
                        .unwrap_or(false)
                })
                .filter_map(|j| j.metadata.name.clone())
                .collect();
            if owned_jobs.is_empty() {
                return Ok(vec![]);
            }
            let pods: Api<Pod> = Api::namespaced(client, &namespace);
            let pod_list = pods
                .list(&ListParams::default())
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            let filtered: Vec<WorkloadSummary> = pod_list
                .items
                .iter()
                .filter(|p| {
                    p.metadata
                        .owner_references
                        .as_ref()
                        .map(|v| {
                            v.iter()
                                .any(|o| o.kind == "Job" && owned_jobs.contains(&o.name))
                        })
                        .unwrap_or(false)
                })
                .map(resources::pod_summary)
                .collect();
            Ok(filtered)
        }
        WorkloadKind::Job => {
            let pods: Api<Pod> = Api::namespaced(client, &namespace);
            let pod_list = pods
                .list(&ListParams::default())
                .await
                .map_err(|e| AppError::K8s(e.to_string()))?;
            let filtered: Vec<WorkloadSummary> = pod_list
                .items
                .iter()
                .filter(|p| {
                    p.metadata
                        .owner_references
                        .as_ref()
                        .map(|v| v.iter().any(|o| o.kind == "Job" && o.name == name))
                        .unwrap_or(false)
                })
                .map(resources::pod_summary)
                .collect();
            Ok(filtered)
        }
        WorkloadKind::Pod => {
            let api: Api<Pod> = Api::namespaced(client, &namespace);
            let obj = api.get(&name).await.map_err(|e| AppError::K8s(e.to_string()))?;
            Ok(vec![resources::pod_summary(&obj)])
        }
        WorkloadKind::Service
        | WorkloadKind::Ingress
        | WorkloadKind::ConfigMap
        | WorkloadKind::Secret
        | WorkloadKind::NetworkPolicy
        | WorkloadKind::PersistentVolumeClaim
        | WorkloadKind::PersistentVolume
        | WorkloadKind::StorageClass
        | WorkloadKind::IngressClass
        | WorkloadKind::ResourceQuota
        | WorkloadKind::HorizontalPodAutoscaler
        | WorkloadKind::LimitRange
        | WorkloadKind::PodDisruptionBudget
        | WorkloadKind::PriorityClass
        | WorkloadKind::MutatingWebhookConfiguration
        | WorkloadKind::ValidatingWebhookConfiguration => Ok(vec![]),
    }
}

// ─── CRD Browser ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_crds(
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<crd_mod::CrdSummary>> {
    let client = client_for(&state, context.as_deref()).await?;
    crd_mod::list_crds(&client).await
}

#[tauri::command]
pub async fn list_cr_instances(
    group: String,
    version: String,
    kind: String,
    plural: String,
    namespace: Option<String>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<crd_mod::CrInstance>> {
    let client = client_for(&state, context.as_deref()).await?;
    crd_mod::list_instances(&client, &group, &version, &kind, &plural, namespace).await
}

#[tauri::command]
pub async fn get_cr_yaml(
    group: String,
    version: String,
    kind: String,
    plural: String,
    namespace: Option<String>,
    name: String,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let client = client_for(&state, context.as_deref()).await?;
    crd_mod::get_instance_yaml(
        &client,
        &group,
        &version,
        &kind,
        &plural,
        namespace,
        &name,
    )
    .await
}

// ─── Team Access (RBAC provisioning) ──────────────────────────────────────

#[tauri::command]
pub async fn provision_team_access(
    request: rbac_admin::TeamAccessRequest,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<rbac_admin::TeamAccessResult> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let client = state.k8s.client_for(&ctx).await?;
    let kc = kubeconfig::load()?;
    rbac_admin::provision(&client, &ctx, &kc, request).await
}

#[tauri::command]
pub async fn revoke_team_access(
    member_id: String,
    namespaces: Vec<String>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<rbac_admin::CreatedObject>> {
    let client = client_for(&state, context.as_deref()).await?;
    rbac_admin::revoke(&client, &member_id, namespaces).await
}

#[tauri::command]
pub async fn list_team_access(
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<rbac_admin::TeamGrant>> {
    let client = client_for(&state, context.as_deref()).await?;
    rbac_admin::list_grants(&client).await
}

#[tauri::command]
pub async fn renew_team_token(
    member_id: String,
    ttl_hours: i64,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<rbac_admin::TeamAccessResult> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let client = state.k8s.client_for(&ctx).await?;
    let kc = kubeconfig::load()?;
    rbac_admin::renew_token(&client, &ctx, &kc, &member_id, ttl_hours).await
}

#[tauri::command]
pub async fn rotate_team_token(
    member_id: String,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<rbac_admin::TeamAccessResult> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let client = state.k8s.client_for(&ctx).await?;
    let kc = kubeconfig::load()?;
    rbac_admin::rotate_long_lived_token(&client, &ctx, &kc, &member_id).await
}

// ─── Workload actions (writes) + events ───────────────────────────────────

#[tauri::command]
pub async fn list_events_for(
    namespace: String,
    kind: WorkloadKind,
    name: String,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<act::EventSummary>> {
    let client = client_for(&state, context.as_deref()).await?;
    act::list_events_for(&client, &namespace, kind, &name).await
}

#[tauri::command]
pub async fn restart_workload(
    namespace: String,
    kind: WorkloadKind,
    name: String,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let client = client_for(&state, context.as_deref()).await?;
    act::rollout_restart(&client, &namespace, kind, &name).await
}

#[tauri::command]
pub async fn scale_workload(
    namespace: String,
    kind: WorkloadKind,
    name: String,
    replicas: i32,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let client = client_for(&state, context.as_deref()).await?;
    act::scale(&client, &namespace, kind, &name, replicas).await
}

#[tauri::command]
pub async fn delete_pod(
    namespace: String,
    name: String,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let client = client_for(&state, context.as_deref()).await?;
    act::delete_pod(&client, &namespace, &name).await
}

// ─── Port-forward ─────────────────────────────────────────────────────────

use crate::k8s::portforward;

#[tauri::command]
pub async fn start_port_forward(
    namespace: String,
    target_kind: portforward::ForwardTargetKind,
    target_name: String,
    local_port: u16,
    remote_port: u16,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<portforward::ForwardSession> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let client = state.k8s.client_for(&ctx).await?;
    portforward::start(
        client,
        state.forwards.clone(),
        portforward::StartForwardRequest {
            context: ctx,
            namespace,
            target_kind,
            target_name,
            local_port,
            remote_port,
        },
    )
    .await
}

#[tauri::command]
pub async fn list_port_forwards(
    state: State<'_, AppState>,
) -> AppResult<Vec<portforward::ForwardSession>> {
    Ok(state.forwards.list().await)
}

#[tauri::command]
pub async fn stop_port_forward(id: String, state: State<'_, AppState>) -> AppResult<bool> {
    Ok(state.forwards.stop(&id).await)
}

// ─── Pod container list (for log picker, future exec) ─────────────────────

#[derive(serde::Serialize)]
pub struct PodContainerInfo {
    pub name: String,
    pub image: String,
    pub is_init: bool,
    pub is_default: bool,
}

#[tauri::command]
pub async fn list_pod_containers(
    namespace: String,
    pod: String,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<PodContainerInfo>> {
    let client = client_for(&state, context.as_deref()).await?;
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let obj = api
        .get(&pod)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let default_name = obj
        .metadata
        .annotations
        .as_ref()
        .and_then(|a| a.get("kubectl.kubernetes.io/default-container"))
        .cloned();
    let spec = obj
        .spec
        .ok_or_else(|| AppError::K8s("pod has no spec".into()))?;
    const SIDECAR: &[&str] = &[
        "istio-proxy",
        "istio-init",
        "linkerd-proxy",
        "linkerd-init",
        "envoy",
        "secret-agent",
        "cloud-sql-proxy",
        "otel-agent",
    ];
    let fallback_default: Option<String> = default_name.clone().or_else(|| {
        spec.containers
            .iter()
            .find(|c| !SIDECAR.iter().any(|s| c.name.contains(s)))
            .map(|c| c.name.clone())
            .or_else(|| spec.containers.first().map(|c| c.name.clone()))
    });
    let mut out: Vec<PodContainerInfo> = Vec::new();
    for c in &spec.containers {
        out.push(PodContainerInfo {
            name: c.name.clone(),
            image: c.image.clone().unwrap_or_default(),
            is_init: false,
            is_default: Some(c.name.clone()) == fallback_default,
        });
    }
    if let Some(inits) = &spec.init_containers {
        for c in inits {
            out.push(PodContainerInfo {
                name: c.name.clone(),
                image: c.image.clone().unwrap_or_default(),
                is_init: true,
                is_default: false,
            });
        }
    }
    Ok(out)
}

// ─── YAML apply ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn apply_resource(
    namespace: String,
    kind: WorkloadKind,
    name: String,
    yaml: String,
    dry_run: bool,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<act::ApplyOutcome> {
    let client = client_for(&state, context.as_deref()).await?;
    act::apply_resource(&client, &namespace, kind, &name, &yaml, dry_run).await
}

// ─── Helm browser (read-only) ─────────────────────────────────────────────

use crate::k8s::helm;

#[tauri::command]
pub async fn list_helm_releases(
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<helm::HelmReleaseSummary>> {
    let client = client_for(&state, context.as_deref()).await?;
    helm::list_releases(&client).await
}

#[tauri::command]
pub async fn get_helm_release(
    namespace: String,
    name: String,
    revision: Option<i32>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<helm::HelmReleaseDetail> {
    let client = client_for(&state, context.as_deref()).await?;
    helm::get_release(&client, &namespace, &name, revision).await
}

#[tauri::command]
pub async fn list_helm_history(
    namespace: String,
    name: String,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<Vec<helm::HelmReleaseSummary>> {
    let client = client_for(&state, context.as_deref()).await?;
    helm::list_history(&client, &namespace, &name).await
}

// ─── Helm write ops via shell-out ─────────────────────────────────────────

use crate::k8s::helm_cli;

async fn register_helm_stream(
    state: &State<'_, AppState>,
    stream_id: &str,
) -> tokio_util::sync::CancellationToken {
    let cancel = tokio_util::sync::CancellationToken::new();
    state
        .k8s
        .streams
        .write()
        .await
        .insert(stream_id.to_string(), cancel.clone());
    cancel
}

#[tauri::command]
pub async fn helm_install(
    request: helm_cli::HelmInstallRequest,
    stream_id: String,
    channel: tauri::ipc::Channel<helm_cli::HelmEvent>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let cancel = register_helm_stream(&state, &stream_id).await;
    tokio::spawn(async move {
        let _ = helm_cli::install(&ctx, request, channel, cancel).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn helm_upgrade(
    request: helm_cli::HelmUpgradeRequest,
    stream_id: String,
    channel: tauri::ipc::Channel<helm_cli::HelmEvent>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let cancel = register_helm_stream(&state, &stream_id).await;
    tokio::spawn(async move {
        let _ = helm_cli::upgrade(&ctx, request, channel, cancel).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn helm_rollback(
    request: helm_cli::HelmRollbackRequest,
    stream_id: String,
    channel: tauri::ipc::Channel<helm_cli::HelmEvent>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let cancel = register_helm_stream(&state, &stream_id).await;
    tokio::spawn(async move {
        let _ = helm_cli::rollback(&ctx, request, channel, cancel).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn helm_uninstall(
    request: helm_cli::HelmUninstallRequest,
    stream_id: String,
    channel: tauri::ipc::Channel<helm_cli::HelmEvent>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    let ctx = state.k8s.resolve_context(context.as_deref()).await?;
    let cancel = register_helm_stream(&state, &stream_id).await;
    tokio::spawn(async move {
        let _ = helm_cli::uninstall(&ctx, request, channel, cancel).await;
    });
    Ok(())
}

// ─── Pod attach (terminal) ────────────────────────────────────────────────

use crate::k8s::exec as attach;

#[tauri::command]
pub async fn start_pod_attach(
    request: attach::StartAttachRequest,
    channel: tauri::ipc::Channel<attach::AttachEvent>,
    context: Option<String>,
    state: State<'_, AppState>,
) -> AppResult<String> {
    let client = client_for(&state, context.as_deref()).await?;
    attach::start(client, state.attachments.clone(), request, channel).await
}

#[tauri::command]
pub async fn pod_attach_stdin(
    id: String,
    bytes: Vec<u8>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.attachments.write_stdin(&id, bytes).await
}

#[tauri::command]
pub async fn pod_attach_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> AppResult<()> {
    state.attachments.resize(&id, cols, rows).await
}

#[tauri::command]
pub async fn pod_attach_close(id: String, state: State<'_, AppState>) -> AppResult<()> {
    state.attachments.close(&id).await;
    Ok(())
}

// ─── Pod details (Lens-style detail drawer) ───────────────────────────────

/// Fetch the rich detail payload for a single pod: metadata, conditions,
/// containers (with resource requests/limits), live cpu/memory from
/// metrics-server cache, and IP/node/QoS metadata. Used by the
/// `ResourceDetailDrawer` Properties tab.
#[tauri::command]
pub async fn get_pod_details(
    ctx: String,
    namespace: String,
    name: String,
    state: State<'_, AppState>,
) -> AppResult<PodDetails> {
    let client = client_for(&state, Some(&ctx)).await?;
    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let pod = api
        .get(&name)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;

    let meta = &pod.metadata;
    let spec = pod.spec.as_ref();
    let status = pod.status.as_ref();

    let phase = status.and_then(|s| s.phase.clone()).unwrap_or_default();
    let qos_class = status
        .and_then(|s| s.qos_class.clone())
        .unwrap_or_else(|| "BestEffort".to_string());
    let node_name = spec.and_then(|s| s.node_name.clone());
    let pod_ip = status.and_then(|s| s.pod_ip.clone());
    let pod_ips: Vec<String> = status
        .and_then(|s| s.pod_ips.as_ref())
        .map(|v| v.iter().map(|p| p.ip.clone()).collect())
        .unwrap_or_default();
    let service_account = spec.and_then(|s| s.service_account_name.clone());
    let tolerations = spec
        .and_then(|s| s.tolerations.as_ref())
        .map(|t| t.len() as i32)
        .unwrap_or(0);
    let conditions: Vec<PodCondition> = status
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| {
            cs.iter()
                .map(|c| PodCondition {
                    r#type: c.type_.clone(),
                    status: c.status.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    let controlled_by = meta
        .owner_references
        .as_ref()
        .and_then(|v| v.first())
        .map(|o| OwnerRefLite {
            kind: o.kind.clone(),
            name: o.name.clone(),
        });

    let labels: std::collections::BTreeMap<String, String> = meta
        .labels
        .clone()
        .map(|m| m.into_iter().collect())
        .unwrap_or_default();
    let annotations: std::collections::BTreeMap<String, String> = meta
        .annotations
        .clone()
        .map(|m| m.into_iter().collect())
        .unwrap_or_default();

    // Build a container_status lookup so we can fold per-container restart
    // count + state into the spec-driven container list.
    let cs_by_name: std::collections::HashMap<String, _> = status
        .and_then(|s| s.container_statuses.as_ref())
        .map(|v| {
            v.iter()
                .map(|cs| (cs.name.clone(), cs.clone()))
                .collect()
        })
        .unwrap_or_default();

    let containers: Vec<ContainerInfo> = spec
        .map(|s| {
            s.containers
                .iter()
                .map(|c| {
                    let cs = cs_by_name.get(&c.name);
                    let ready = cs.map(|s| s.ready).unwrap_or(false);
                    let restart_count = cs.map(|s| s.restart_count).unwrap_or(0);
                    let state = cs
                        .and_then(|s| s.state.as_ref())
                        .map(|st| {
                            if st.running.is_some() {
                                "Running".to_string()
                            } else if let Some(w) = &st.waiting {
                                format!(
                                    "Waiting:{}",
                                    w.reason.clone().unwrap_or_else(|| "Unknown".into())
                                )
                            } else if let Some(t) = &st.terminated {
                                format!(
                                    "Terminated:{}",
                                    t.reason.clone().unwrap_or_else(|| "Unknown".into())
                                )
                            } else {
                                "Unknown".into()
                            }
                        })
                        .unwrap_or_else(|| "Unknown".into());
                    let (cpu_req, cpu_lim, mem_req, mem_lim) = c
                        .resources
                        .as_ref()
                        .map(|r| {
                            let req = r.requests.as_ref();
                            let lim = r.limits.as_ref();
                            (
                                req.and_then(|m| m.get("cpu"))
                                    .and_then(|q| metrics::parse_cpu_milli(&q.0)),
                                lim.and_then(|m| m.get("cpu"))
                                    .and_then(|q| metrics::parse_cpu_milli(&q.0)),
                                req.and_then(|m| m.get("memory"))
                                    .and_then(|q| metrics::parse_memory_bytes(&q.0)),
                                lim.and_then(|m| m.get("memory"))
                                    .and_then(|q| metrics::parse_memory_bytes(&q.0)),
                            )
                        })
                        .unwrap_or((None, None, None, None));
                    ContainerInfo {
                        name: c.name.clone(),
                        image: c.image.clone().unwrap_or_default(),
                        ready,
                        restart_count,
                        state,
                        cpu_request_milli: cpu_req,
                        cpu_limit_milli: cpu_lim,
                        mem_request_bytes: mem_req,
                        mem_limit_bytes: mem_lim,
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // Pull live usage from the metrics-server cache (10s TTL, free).
    let (cpu_usage_milli, mem_usage_bytes) = match metrics::pod_usage(&client, &ctx).await {
        Some(usage) => usage
            .into_iter()
            .find(|u| u.name == name && u.namespace == namespace)
            .map(|u| (Some(u.cpu_milli), Some(u.mem_bytes)))
            .unwrap_or((None, None)),
        None => (None, None),
    };

    let created_at_ms = meta
        .creation_timestamp
        .as_ref()
        .map(|t| t.0.timestamp_millis())
        .unwrap_or(0);
    let age_seconds = if created_at_ms > 0 {
        ((chrono::Utc::now().timestamp_millis() - created_at_ms) / 1000).max(0)
    } else {
        0
    };

    Ok(PodDetails {
        name,
        namespace,
        status: phase,
        qos_class,
        node_name,
        controlled_by,
        service_account,
        pod_ip,
        pod_ips,
        conditions,
        tolerations,
        labels,
        annotations,
        containers,
        cpu_usage_milli,
        mem_usage_bytes,
        age_seconds,
        created_at_ms,
    })
}
