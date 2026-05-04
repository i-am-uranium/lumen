//! Fleet: parallel, bounded probes across every kubeconfig context.
//!
//! Produces one `FleetCard` per context. A context that fails to connect
//! still produces a card with `reachable = false` and an error string —
//! the UI shows these in an "unreachable" bucket rather than erroring the
//! whole fleet view.

use crate::error::AppResult;
use crate::k8s::client::K8sState;
use crate::k8s::kubeconfig;
use crate::k8s::metrics;
use crate::k8s::types::{ContextInfo, FleetCard, FleetHealth, NodeSummary};
use futures::future::join_all;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Namespace, Node, Pod};
use kube::{api::ListParams, Api, Client};
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;

const NOT_READY: &str = "Ready";

pub fn node_summary(n: &Node) -> NodeSummary {
    let status = n.status.as_ref();
    let roles: Vec<String> = n
        .metadata
        .labels
        .as_ref()
        .map(|m| {
            m.iter()
                .filter_map(|(k, _)| k.strip_prefix("node-role.kubernetes.io/").map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let ready = status
        .and_then(|s| s.conditions.as_ref())
        .map(|cs| {
            cs.iter()
                .any(|c| c.type_ == NOT_READY && c.status == "True")
        })
        .unwrap_or(false);
    let ni = status.and_then(|s| s.node_info.as_ref());
    let version = ni.map(|n| n.kubelet_version.clone()).unwrap_or_default();
    let os_image = ni.map(|n| n.os_image.clone()).unwrap_or_default();
    let arch = ni.map(|n| n.architecture.clone()).unwrap_or_default();
    let capacity = status.and_then(|s| s.capacity.as_ref());
    let allocatable = status.and_then(|s| s.allocatable.as_ref());
    let cpu_cap = capacity
        .and_then(|m| m.get("cpu"))
        .and_then(|q| metrics::parse_cpu_milli(&q.0))
        .unwrap_or(0);
    let mem_cap = capacity
        .and_then(|m| m.get("memory"))
        .and_then(|q| metrics::parse_memory_bytes(&q.0))
        .unwrap_or(0);
    let pods_cap = capacity
        .and_then(|m| m.get("pods"))
        .and_then(|q| q.0.parse::<i64>().ok())
        .unwrap_or(0);
    let cpu_alloc = allocatable
        .and_then(|m| m.get("cpu"))
        .and_then(|q| metrics::parse_cpu_milli(&q.0))
        .unwrap_or(0);
    let mem_alloc = allocatable
        .and_then(|m| m.get("memory"))
        .and_then(|q| metrics::parse_memory_bytes(&q.0))
        .unwrap_or(0);
    let taints = n
        .spec
        .as_ref()
        .and_then(|s| s.taints.as_ref())
        .map(|ts| {
            ts.iter()
                .map(|t| {
                    format!(
                        "{}={}:{}",
                        t.key,
                        t.value.clone().unwrap_or_default(),
                        t.effect
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    NodeSummary {
        name: n.metadata.name.clone().unwrap_or_default(),
        roles,
        version,
        ready,
        os_image,
        arch,
        cpu_capacity_milli: cpu_cap,
        mem_capacity_bytes: mem_cap,
        pods_capacity: pods_cap,
        cpu_allocatable_milli: cpu_alloc,
        mem_allocatable_bytes: mem_alloc,
        taints,
        age_seconds: crate::k8s::resources::age_seconds(&n.metadata),
        cpu_usage_milli: None,
        mem_usage_bytes: None,
    }
}

/// List nodes for a single context, enriched with metrics-server usage where
/// available.
pub async fn list_nodes(client: &Client, ctx: &str) -> AppResult<Vec<NodeSummary>> {
    let api: Api<Node> = Api::all(client.clone());
    let raw = api
        .list(&ListParams::default())
        .await
        .map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let mut nodes: Vec<NodeSummary> = raw.items.iter().map(node_summary).collect();
    if let Some(usages) = metrics::node_usage(client, ctx).await {
        for u in usages {
            if let Some(n) = nodes.iter_mut().find(|n| n.name == u.name) {
                n.cpu_usage_milli = Some(u.cpu_milli);
                n.mem_usage_bytes = Some(u.mem_bytes);
            }
        }
    }
    Ok(nodes)
}

/// Hard upper bound on any single fleet probe. An unreachable cluster would
/// otherwise hang for the TCP connect timeout (often 2 minutes) and block the
/// whole grid.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// Cap concurrent context probes so a kubeconfig with 8+ contexts doesn't
/// fan out to 80+ simultaneous kube list calls (each `probe_one_inner` does
/// 10 internal parallel calls). Beyond ~6 outer probes we mostly see
/// head-of-line blocking from a single slow context starving the others;
/// this Semaphore lets healthy contexts complete promptly while stalled ones
/// run out the 8s probe timeout in the background.
const FLEET_CONCURRENCY: usize = 6;

static FLEET_SEMAPHORE: LazyLock<Arc<Semaphore>> =
    LazyLock::new(|| Arc::new(Semaphore::new(FLEET_CONCURRENCY)));

fn unreachable_card(ctx: ContextInfo, err: String, fetched_at_ms: i64) -> FleetCard {
    FleetCard {
        context: ctx,
        reachable: false,
        error: Some(err),
        server_version: None,
        node_count: 0,
        node_ready: 0,
        namespace_count: 0,
        workload_count: 0,
        health: FleetHealth {
            pods_total: 0,
            pods_ready: 0,
            pods_pending: 0,
            pods_failed: 0,
        },
        cpu_percent: None,
        mem_percent: None,
        fetched_at_ms,
    }
}

async fn probe_one_inner(state: &K8sState, ctx: ContextInfo) -> FleetCard {
    let fetched_at_ms = chrono::Utc::now().timestamp_millis();
    let client = match state.client_for(&ctx.name).await {
        Ok(c) => c,
        Err(e) => {
            // Ensure a fresh client build next tick — the cached one, if any,
            // is known to be broken.
            state.invalidate(&ctx.name).await;
            return unreachable_card(ctx, e.to_string(), fetched_at_ms);
        }
    };

    let c0 = client.clone();
    let c1 = client.clone();
    let c2 = client.clone();
    let c3 = client.clone();
    let c4 = client.clone();
    let c5 = client.clone();
    let c6 = client.clone();
    let c7 = client.clone();
    let c8 = client.clone();
    let ctx_name = ctx.name.clone();

    let (ver, nodes, ns, pods, dep, ss, ds, cj, jobs, node_metrics) = tokio::join!(
        client.apiserver_version(),
        async move { Api::<Node>::all(c0).list(&ListParams::default()).await },
        async move { Api::<Namespace>::all(c1).list(&ListParams::default()).await },
        async move { Api::<Pod>::all(c2).list(&ListParams::default()).await },
        async move { Api::<Deployment>::all(c3).list(&ListParams::default()).await },
        async move { Api::<StatefulSet>::all(c4).list(&ListParams::default()).await },
        async move { Api::<DaemonSet>::all(c5).list(&ListParams::default()).await },
        async move { Api::<CronJob>::all(c6).list(&ListParams::default()).await },
        async move { Api::<Job>::all(c7).list(&ListParams::default()).await },
        async move { metrics::node_usage(&c8, &ctx_name).await },
    );

    // If apiserver_version failed, we haven't actually talked to the cluster —
    // every follow-up list call will have failed for the same reason. Treat as
    // unreachable and evict the cached client so next tick retries from
    // scratch.
    let server_version = match &ver {
        Ok(v) => Some(format!("v{}.{}", v.major, v.minor)),
        Err(e) => {
            state.invalidate(&ctx.name).await;
            return unreachable_card(ctx, e.to_string(), fetched_at_ms);
        }
    };

    let (node_count, node_ready, cpu_cap_milli, mem_cap_bytes) = match &nodes {
        Ok(list) => {
            let mut ready = 0i32;
            let mut cpu_cap = 0i64;
            let mut mem_cap = 0i64;
            for n in &list.items {
                let is_ready = n
                    .status
                    .as_ref()
                    .and_then(|s| s.conditions.as_ref())
                    .map(|cs| cs.iter().any(|c| c.type_ == "Ready" && c.status == "True"))
                    .unwrap_or(false);
                if is_ready {
                    ready += 1;
                }
                if let Some(cap) = n.status.as_ref().and_then(|s| s.allocatable.as_ref()) {
                    cpu_cap += cap
                        .get("cpu")
                        .and_then(|q| metrics::parse_cpu_milli(&q.0))
                        .unwrap_or(0);
                    mem_cap += cap
                        .get("memory")
                        .and_then(|q| metrics::parse_memory_bytes(&q.0))
                        .unwrap_or(0);
                }
            }
            (list.items.len() as i32, ready, cpu_cap, mem_cap)
        }
        Err(_) => (0, 0, 0, 0),
    };

    let namespace_count = ns.as_ref().map(|l| l.items.len() as i32).unwrap_or(0);

    let (pods_total, pods_ready, pods_pending, pods_failed) = match &pods {
        Ok(list) => {
            let mut total = 0i32;
            let mut ready = 0i32;
            let mut pending = 0i32;
            let mut failed = 0i32;
            for p in &list.items {
                total += 1;
                let phase = p
                    .status
                    .as_ref()
                    .and_then(|s| s.phase.as_deref())
                    .unwrap_or("");
                match phase {
                    "Running" | "Succeeded" => {
                        let all_ready = p
                            .status
                            .as_ref()
                            .and_then(|s| s.container_statuses.as_ref())
                            .map(|cs| !cs.is_empty() && cs.iter().all(|c| c.ready))
                            .unwrap_or(phase == "Succeeded");
                        if all_ready {
                            ready += 1;
                        } else {
                            pending += 1;
                        }
                    }
                    "Pending" => pending += 1,
                    "Failed" => failed += 1,
                    _ => {}
                }
            }
            (total, ready, pending, failed)
        }
        Err(_) => (0, 0, 0, 0),
    };

    let workload_count = dep.as_ref().map(|l| l.items.len() as i32).unwrap_or(0)
        + ss.as_ref().map(|l| l.items.len() as i32).unwrap_or(0)
        + ds.as_ref().map(|l| l.items.len() as i32).unwrap_or(0)
        + cj.as_ref().map(|l| l.items.len() as i32).unwrap_or(0)
        + jobs.as_ref().map(|l| l.items.len() as i32).unwrap_or(0);

    let (cpu_percent, mem_percent) = match node_metrics {
        Some(usages) if cpu_cap_milli > 0 && mem_cap_bytes > 0 => {
            let cpu_used: i64 = usages.iter().map(|u| u.cpu_milli).sum();
            let mem_used: i64 = usages.iter().map(|u| u.mem_bytes).sum();
            (
                Some((cpu_used as f32 / cpu_cap_milli as f32 * 100.0).clamp(0.0, 100.0)),
                Some((mem_used as f32 / mem_cap_bytes as f32 * 100.0).clamp(0.0, 100.0)),
            )
        }
        _ => (None, None),
    };

    FleetCard {
        context: ctx,
        reachable: true,
        error: None,
        server_version,
        node_count,
        node_ready,
        namespace_count,
        workload_count,
        health: FleetHealth {
            pods_total,
            pods_ready,
            pods_pending,
            pods_failed,
        },
        cpu_percent,
        mem_percent,
        fetched_at_ms,
    }
}

async fn probe_one(state: &K8sState, ctx: ContextInfo) -> FleetCard {
    let fetched_at_ms = chrono::Utc::now().timestamp_millis();
    let ctx_name = ctx.name.clone();
    // Hold a global concurrency permit across the entire probe (including the
    // timeout wait) so a stuck cluster eats one slot, not many. Acquire is
    // infallible here — the semaphore is never closed.
    let _permit = FLEET_SEMAPHORE.clone().acquire_owned().await.ok();
    match tokio::time::timeout(PROBE_TIMEOUT, probe_one_inner(state, ctx.clone())).await {
        Ok(card) => card,
        Err(_) => {
            state.invalidate(&ctx_name).await;
            unreachable_card(
                ctx,
                format!("probe timed out after {}s", PROBE_TIMEOUT.as_secs()),
                fetched_at_ms,
            )
        }
    }
}

pub async fn probe_all(state: &K8sState) -> AppResult<Vec<FleetCard>> {
    let kc = kubeconfig::load()?;
    let ctxs = kubeconfig::list_contexts_from(&kc);
    let futures = ctxs.into_iter().map(|c| probe_one(state, c));
    let cards = join_all(futures).await;
    Ok(cards)
}

pub async fn probe_context(state: &K8sState, context: &str) -> AppResult<FleetCard> {
    let kc = kubeconfig::load()?;
    let ctx = kubeconfig::list_contexts_from(&kc)
        .into_iter()
        .find(|c| c.name == context)
        .ok_or_else(|| {
            crate::error::AppError::Kubeconfig(format!(
                "context '{}' not in kubeconfig",
                context
            ))
        })?;
    Ok(probe_one(state, ctx).await)
}
