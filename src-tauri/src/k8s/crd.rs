//! CRD browser backend.
//!
//! Discovery path:
//! 1. List all CRDs via apiextensions.k8s.io/v1.
//! 2. For a specific CRD, list its custom-resource instances through kube's
//!    dynamic API (`DynamicObject`). No per-CRD code required.
//!
//! Read-only — no creates/updates here. If we ever add writes, they will go
//! through a separate command behind an explicit confirmation flow.

use crate::error::{AppError, AppResult};
use k8s_openapi::apiextensions_apiserver::pkg::apis::apiextensions::v1::{
    CustomResourceDefinition, CustomResourceDefinitionVersion,
};
use kube::api::DynamicObject;
use kube::core::{ApiResource, GroupVersionKind};
use kube::{api::ListParams, Api, Client};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CrdSummary {
    pub name: String,
    pub group: String,
    pub kind: String,
    pub plural: String,
    pub short_names: Vec<String>,
    /// "Namespaced" or "Cluster".
    pub scope: String,
    /// All versions known to the cluster.
    pub versions: Vec<String>,
    /// Preferred served+storage version (falls back to first served).
    pub preferred_version: String,
    pub age_seconds: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CrInstance {
    pub name: String,
    pub namespace: Option<String>,
    pub age_seconds: i64,
    /// Small subset of `status` serialized as a short string (when present).
    pub status_hint: Option<String>,
}

fn preferred_version(versions: &[CustomResourceDefinitionVersion]) -> String {
    if let Some(v) = versions.iter().find(|v| v.storage && v.served) {
        return v.name.clone();
    }
    versions
        .iter()
        .find(|v| v.served)
        .map(|v| v.name.clone())
        .or_else(|| versions.first().map(|v| v.name.clone()))
        .unwrap_or_default()
}

pub async fn list_crds(client: &Client) -> AppResult<Vec<CrdSummary>> {
    let api: Api<CustomResourceDefinition> = Api::all(client.clone());
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let mut out: Vec<CrdSummary> = list
        .items
        .into_iter()
        .map(|crd| {
            let spec = crd.spec;
            let name = crd.metadata.name.clone().unwrap_or_default();
            let group = spec.group.clone();
            let kind = spec.names.kind.clone();
            let plural = spec.names.plural.clone();
            let short_names = spec.names.short_names.clone().unwrap_or_default();
            let scope = spec.scope.clone();
            let versions: Vec<String> = spec.versions.iter().map(|v| v.name.clone()).collect();
            let preferred = preferred_version(&spec.versions);
            let age = crd
                .metadata
                .creation_timestamp
                .as_ref()
                .map(|t| (chrono::Utc::now() - t.0).num_seconds().max(0))
                .unwrap_or(0);
            CrdSummary {
                name,
                group,
                kind,
                plural,
                short_names,
                scope,
                versions,
                preferred_version: preferred,
                age_seconds: age,
            }
        })
        .collect();
    out.sort_by(|a, b| a.group.cmp(&b.group).then(a.kind.cmp(&b.kind)));
    Ok(out)
}

fn api_resource(group: &str, version: &str, kind: &str, plural: &str) -> ApiResource {
    let gvk = GroupVersionKind::gvk(group, version, kind);
    ApiResource::from_gvk_with_plural(&gvk, plural)
}

fn status_hint_of(obj: &DynamicObject) -> Option<String> {
    let status = obj.data.get("status")?;
    // Prefer phase → conditions[ready] → just a compact key list.
    if let Some(phase) = status.get("phase").and_then(|v| v.as_str()) {
        return Some(format!("phase={phase}"));
    }
    if let Some(conds) = status.get("conditions").and_then(|v| v.as_array()) {
        if let Some(ready) = conds
            .iter()
            .find(|c| c.get("type").and_then(|t| t.as_str()) == Some("Ready"))
        {
            let s = ready
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown");
            return Some(format!("ready={s}"));
        }
    }
    let keys: Vec<&str> = status
        .as_object()
        .map(|o| o.keys().map(|s| s.as_str()).collect())
        .unwrap_or_default();
    if keys.is_empty() {
        None
    } else {
        Some(keys.join(","))
    }
}

pub async fn list_instances(
    client: &Client,
    group: &str,
    version: &str,
    kind: &str,
    plural: &str,
    namespace: Option<String>,
) -> AppResult<Vec<CrInstance>> {
    let ar = api_resource(group, version, kind, plural);
    let api: Api<DynamicObject> = match namespace {
        Some(ref ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    };
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let mut out: Vec<CrInstance> = list
        .items
        .into_iter()
        .map(|obj| {
            let age = obj
                .metadata
                .creation_timestamp
                .as_ref()
                .map(|t| (chrono::Utc::now() - t.0).num_seconds().max(0))
                .unwrap_or(0);
            let status_hint = status_hint_of(&obj);
            CrInstance {
                name: obj.metadata.name.clone().unwrap_or_default(),
                namespace: obj.metadata.namespace.clone(),
                age_seconds: age,
                status_hint,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        a.namespace
            .clone()
            .unwrap_or_default()
            .cmp(&b.namespace.clone().unwrap_or_default())
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

pub async fn get_instance_yaml(
    client: &Client,
    group: &str,
    version: &str,
    kind: &str,
    plural: &str,
    namespace: Option<String>,
    name: &str,
) -> AppResult<String> {
    let ar = api_resource(group, version, kind, plural);
    let api: Api<DynamicObject> = match namespace {
        Some(ref ns) => Api::namespaced_with(client.clone(), ns, &ar),
        None => Api::all_with(client.clone(), &ar),
    };
    let obj = api
        .get(name)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    serde_yaml::to_string(&obj).map_err(|e| AppError::Internal(e.to_string()))
}
