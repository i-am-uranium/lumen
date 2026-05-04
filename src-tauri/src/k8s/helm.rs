//! Helm v3 release browser.
//!
//! Helm v3 stores every release revision as a Kubernetes Secret of type
//! `helm.sh/release.v1` in the release's namespace. The interesting payload
//! is in `.data.release`, which is:
//!
//!   base64 ( Secret data layer, handled by kube )
//!     -> base64 ( Helm's own layer )
//!        -> gzip ( deflate )
//!            -> JSON ( Helm release document )
//!
//! This module decodes that chain and projects it into a few compact Serialize
//! shapes for the UI. Read-only for now — install/upgrade/rollback need the
//! Helm library's chart rendering and are out of scope for Lumen's current
//! surface.

use crate::error::{AppError, AppResult};
use base64::Engine;
use flate2::read::GzDecoder;
use k8s_openapi::api::core::v1::Secret;
use kube::{api::ListParams, Api, Client};
use serde::{Deserialize, Serialize};
use std::io::Read;

const HELM_SECRET_TYPE: &str = "helm.sh/release.v1";

/// Raw shape of a Helm v3 release document. Only the fields we actually
/// surface are explicitly named; everything else is ignored via serde's
/// default.
#[derive(Debug, Clone, Deserialize)]
struct RawRelease {
    name: String,
    namespace: String,
    version: i32,
    info: Option<RawInfo>,
    chart: Option<RawChart>,
    #[serde(default)]
    config: serde_json::Value,
    #[serde(default)]
    manifest: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RawInfo {
    #[serde(default)]
    first_deployed: Option<String>,
    #[serde(default)]
    last_deployed: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawChart {
    metadata: Option<RawChartMeta>,
    #[serde(default)]
    values: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
struct RawChartMeta {
    name: Option<String>,
    version: Option<String>,
    #[serde(rename = "appVersion", default)]
    app_version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    home: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    sources: Option<Vec<String>>,
    #[serde(rename = "kubeVersion", default)]
    kube_version: Option<String>,
    #[serde(rename = "apiVersion", default)]
    api_version: Option<String>,
    #[serde(rename = "type", default)]
    chart_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelmReleaseSummary {
    pub name: String,
    pub namespace: String,
    pub revision: i32,
    pub status: String,
    pub chart_name: String,
    pub chart_version: String,
    pub app_version: String,
    pub last_deployed: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HelmReleaseDetail {
    pub summary: HelmReleaseSummary,
    pub first_deployed: Option<String>,
    pub chart_description: Option<String>,
    pub chart_home: Option<String>,
    pub chart_icon: Option<String>,
    pub chart_sources: Vec<String>,
    pub chart_api_version: Option<String>,
    pub chart_type: Option<String>,
    pub chart_kube_version: Option<String>,
    /// User-supplied values (YAML text).
    pub user_values_yaml: String,
    /// Default values baked into the chart (YAML text).
    pub chart_values_yaml: String,
    /// Rendered manifest that Helm sent to the apiserver.
    pub manifest: String,
    /// NOTES.txt content, if any.
    pub notes: Option<String>,
}

fn decode_release_blob(b64: &str) -> AppResult<RawRelease> {
    let engine = base64::engine::general_purpose::STANDARD;
    let once = engine
        .decode(b64.as_bytes())
        .map_err(|e| AppError::Internal(format!("helm outer base64: {e}")))?;
    let mut gz = GzDecoder::new(&once[..]);
    let mut out = Vec::new();
    gz.read_to_end(&mut out)
        .map_err(|e| AppError::Internal(format!("helm gzip decode: {e}")))?;
    serde_json::from_slice::<RawRelease>(&out)
        .map_err(|e| AppError::Internal(format!("helm json: {e}")))
}

fn summarize(r: &RawRelease) -> HelmReleaseSummary {
    let info = r.info.as_ref();
    let meta = r.chart.as_ref().and_then(|c| c.metadata.as_ref());
    HelmReleaseSummary {
        name: r.name.clone(),
        namespace: r.namespace.clone(),
        revision: r.version,
        status: info
            .and_then(|i| i.status.clone())
            .unwrap_or_else(|| "unknown".into()),
        chart_name: meta
            .and_then(|m| m.name.clone())
            .unwrap_or_else(|| "".into()),
        chart_version: meta
            .and_then(|m| m.version.clone())
            .unwrap_or_else(|| "".into()),
        app_version: meta
            .and_then(|m| m.app_version.clone())
            .unwrap_or_else(|| "".into()),
        last_deployed: info.and_then(|i| i.last_deployed.clone()),
        description: info.and_then(|i| i.description.clone()),
    }
}

async fn list_release_secrets(client: &Client) -> AppResult<Vec<Secret>> {
    // `type=helm.sh/release.v1` isn't field-selectable; the apiserver only
    // allows specific keys on Secrets. List all with the standard Helm label
    // `owner=helm` then filter by type client-side.
    let api: Api<Secret> = Api::all(client.clone());
    let lp = ListParams::default().labels("owner=helm");
    let list = api
        .list(&lp)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(list
        .items
        .into_iter()
        .filter(|s| {
            s.type_
                .as_deref()
                .map(|t| t == HELM_SECRET_TYPE)
                .unwrap_or(false)
        })
        .collect())
}

fn raw_release_from_secret(s: &Secret) -> AppResult<RawRelease> {
    // Secrets can store the release payload under either `data` (binary,
    // already-decoded by kube) or `stringData` (rarely in practice). The
    // encoded string we care about lives under the `release` key.
    let payload_b64 = if let Some(d) = s.data.as_ref().and_then(|m| m.get("release")) {
        // kube decoded the Secret's outer base64 for us, so what we have
        // here is the raw ASCII of Helm's base64 layer.
        String::from_utf8(d.0.clone())
            .map_err(|e| AppError::Internal(format!("release not utf8: {e}")))?
    } else {
        return Err(AppError::Internal(
            "helm release secret has no `.data.release`".into(),
        ));
    };
    decode_release_blob(&payload_b64)
}

/// List latest-revision summary per release across all namespaces.
pub async fn list_releases(client: &Client) -> AppResult<Vec<HelmReleaseSummary>> {
    let secrets = list_release_secrets(client).await?;
    use std::collections::HashMap;
    // key = namespace/name; value = highest revision seen
    let mut latest: HashMap<(String, String), HelmReleaseSummary> = HashMap::new();
    for s in &secrets {
        let Ok(r) = raw_release_from_secret(s) else {
            continue;
        };
        let key = (r.namespace.clone(), r.name.clone());
        let sum = summarize(&r);
        latest
            .entry(key)
            .and_modify(|cur| {
                if sum.revision > cur.revision {
                    *cur = sum.clone();
                }
            })
            .or_insert(sum);
    }
    let mut out: Vec<HelmReleaseSummary> = latest.into_values().collect();
    out.sort_by(|a, b| {
        a.namespace
            .cmp(&b.namespace)
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

/// Fetch the full detail for a specific release (optionally pinned to a
/// revision; `None` means "latest observed").
pub async fn get_release(
    client: &Client,
    namespace: &str,
    name: &str,
    revision: Option<i32>,
) -> AppResult<HelmReleaseDetail> {
    let secrets = list_release_secrets(client).await?;
    let mut raws: Vec<RawRelease> = secrets
        .iter()
        .filter_map(|s| raw_release_from_secret(s).ok())
        .filter(|r| r.namespace == namespace && r.name == name)
        .collect();
    if raws.is_empty() {
        return Err(AppError::K8s(format!(
            "no helm release '{namespace}/{name}' found"
        )));
    }
    raws.sort_by_key(|r| r.version);
    let r = match revision {
        Some(v) => raws
            .into_iter()
            .find(|r| r.version == v)
            .ok_or_else(|| AppError::K8s(format!("revision {v} not found")))?,
        None => raws.pop().unwrap(),
    };
    let meta = r.chart.as_ref().and_then(|c| c.metadata.as_ref()).cloned();
    let chart_values_yaml = r
        .chart
        .as_ref()
        .map(|c| serde_yaml::to_string(&c.values).unwrap_or_default())
        .unwrap_or_default();
    Ok(HelmReleaseDetail {
        summary: summarize(&r),
        first_deployed: r.info.as_ref().and_then(|i| i.first_deployed.clone()),
        chart_description: meta.as_ref().and_then(|m| m.description.clone()),
        chart_home: meta.as_ref().and_then(|m| m.home.clone()),
        chart_icon: meta.as_ref().and_then(|m| m.icon.clone()),
        chart_sources: meta
            .as_ref()
            .and_then(|m| m.sources.clone())
            .unwrap_or_default(),
        chart_api_version: meta.as_ref().and_then(|m| m.api_version.clone()),
        chart_type: meta.as_ref().and_then(|m| m.chart_type.clone()),
        chart_kube_version: meta.as_ref().and_then(|m| m.kube_version.clone()),
        user_values_yaml: serde_yaml::to_string(&r.config).unwrap_or_default(),
        chart_values_yaml,
        manifest: r.manifest,
        notes: r.info.and_then(|i| i.notes),
    })
}

/// Every historical revision of a release, oldest-first.
pub async fn list_history(
    client: &Client,
    namespace: &str,
    name: &str,
) -> AppResult<Vec<HelmReleaseSummary>> {
    let secrets = list_release_secrets(client).await?;
    let mut out: Vec<HelmReleaseSummary> = secrets
        .iter()
        .filter_map(|s| raw_release_from_secret(s).ok())
        .filter(|r| r.namespace == namespace && r.name == name)
        .map(|r| summarize(&r))
        .collect();
    out.sort_by_key(|s| s.revision);
    Ok(out)
}
