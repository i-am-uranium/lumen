//! metrics-server client.
//!
//! metrics-server exposes a non-generated API (`metrics.k8s.io/v1beta1`). We
//! query it as raw JSON via `kube::Client::request`, parse the Quantity
//! strings ourselves, and return `None` when the API isn't installed instead
//! of erroring the whole call — clusters without metrics-server still need to
//! render fleet cards.
//!
//! Caching: probes hit metrics-server at the tick rate of the calling view
//! (every 30s for fleet, 30s for cloudmap). On clusters where metrics-server
//! is degraded or absent, the request can take hundreds of ms or block until
//! a 2s timeout — multiplied by every fleet context, this is the largest
//! single source of "fleet feels stuck" latency. The cache below short-
//! circuits both the slow path (positive TTL) and the failure path (negative
//! TTL) per context. The keys are context names because metrics-server
//! availability and load are cluster-local.

use http::Request;
use kube::Client;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize)]
struct MetricsUsage {
    cpu: Option<String>,
    memory: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NodeMetricsItem {
    metadata: ItemMeta,
    usage: MetricsUsage,
}

#[derive(Debug, Deserialize)]
struct PodMetricsItem {
    metadata: ItemMeta,
    containers: Vec<ContainerMetrics>,
}

#[derive(Debug, Deserialize)]
struct ContainerMetrics {
    usage: MetricsUsage,
}

#[derive(Debug, Deserialize)]
struct ItemMeta {
    name: String,
    #[serde(default)]
    namespace: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MetricsList<T> {
    items: Vec<T>,
}

/// Parse a Kubernetes Quantity into milli-units for CPU and bytes for memory.
pub fn parse_cpu_milli(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Some(stripped) = s.strip_suffix('n') {
        // nanocores → milli
        stripped.parse::<i64>().ok().map(|v| v / 1_000_000)
    } else if let Some(stripped) = s.strip_suffix('u') {
        stripped.parse::<i64>().ok().map(|v| v / 1_000)
    } else if let Some(stripped) = s.strip_suffix('m') {
        stripped.parse::<i64>().ok()
    } else {
        s.parse::<f64>().ok().map(|v| (v * 1000.0) as i64)
    }
}

pub fn parse_memory_bytes(s: &str) -> Option<i64> {
    let s = s.trim();
    // Binary suffixes first (K vs Ki etc). Kubernetes uses Ki/Mi/Gi/Ti; plain
    // K/M/G are decimal.
    const BINARY: &[(&str, i64)] = &[
        ("Ki", 1024),
        ("Mi", 1024 * 1024),
        ("Gi", 1024 * 1024 * 1024),
        ("Ti", 1024i64.pow(4)),
        ("Pi", 1024i64.pow(5)),
    ];
    const DECIMAL: &[(&str, i64)] = &[
        ("K", 1_000),
        ("M", 1_000_000),
        ("G", 1_000_000_000),
        ("T", 1_000_000_000_000),
        ("P", 1_000_000_000_000_000),
    ];
    for (suf, mul) in BINARY {
        if let Some(v) = s.strip_suffix(suf) {
            return v.parse::<i64>().ok().map(|n| n * mul);
        }
    }
    for (suf, mul) in DECIMAL {
        if let Some(v) = s.strip_suffix(suf) {
            return v.parse::<i64>().ok().map(|n| n * mul);
        }
    }
    s.parse::<i64>().ok()
}

/// Per-node usage. Returns None on every field when metrics-server is not
/// installed or unreachable.
#[derive(Clone)]
pub struct NodeUsage {
    pub name: String,
    pub cpu_milli: i64,
    pub mem_bytes: i64,
}

#[derive(Clone)]
pub struct PodUsage {
    pub name: String,
    pub namespace: String,
    pub cpu_milli: i64,
    pub mem_bytes: i64,
}

// Cache TTLs. Positive (success) is short — metrics churn quickly, but a 10s
// cache is still long enough to absorb the typical fleet/cloudmap refetch
// cadence (30s) plus rapid follow-up reads. Negative (failure) is long —
// once we've confirmed metrics-server is degraded, hitting it again every
// 30s is pure latency tax that the user pays per context.
const POSITIVE_TTL: Duration = Duration::from_secs(10);
const NEGATIVE_TTL: Duration = Duration::from_secs(60);
// Hard cap on a single metrics-server HTTP request. The kube client's default
// timeouts can stall for tens of seconds when the API is reachable but slow.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct CacheEntry<T> {
    /// `None` here is a remembered failure; `Some` is the cached value.
    value: Option<T>,
    fetched_at: Instant,
}

#[derive(Default)]
struct MetricsCache {
    nodes: HashMap<String, CacheEntry<Vec<NodeUsage>>>,
    pods: HashMap<String, CacheEntry<Vec<PodUsage>>>,
}

static CACHE: LazyLock<Mutex<MetricsCache>> = LazyLock::new(|| Mutex::new(MetricsCache::default()));

fn ttl_for(value: &Option<impl Sized>) -> Duration {
    if value.is_some() {
        POSITIVE_TTL
    } else {
        NEGATIVE_TTL
    }
}

async fn get_raw<T: for<'de> Deserialize<'de>>(client: &Client, path: &str) -> Option<T> {
    let req = Request::get(path).body(Vec::new()).ok()?;
    let fut = client.request::<T>(req);
    match tokio::time::timeout(REQUEST_TIMEOUT, fut).await {
        Ok(Ok(v)) => Some(v),
        _ => None,
    }
}

pub async fn node_usage(client: &Client, ctx: &str) -> Option<Vec<NodeUsage>> {
    if let Ok(c) = CACHE.lock() {
        if let Some(entry) = c.nodes.get(ctx) {
            if entry.fetched_at.elapsed() < ttl_for(&entry.value) {
                return entry.value.clone();
            }
        }
    }

    let value: Option<Vec<NodeUsage>> =
        match get_raw::<MetricsList<NodeMetricsItem>>(client, "/apis/metrics.k8s.io/v1beta1/nodes")
            .await
        {
            Some(list) => Some(
                list.items
                    .into_iter()
                    .filter_map(|n| {
                        let cpu = n.usage.cpu.as_deref().and_then(parse_cpu_milli)?;
                        let mem = n.usage.memory.as_deref().and_then(parse_memory_bytes)?;
                        Some(NodeUsage {
                            name: n.metadata.name,
                            cpu_milli: cpu,
                            mem_bytes: mem,
                        })
                    })
                    .collect(),
            ),
            None => None,
        };

    if let Ok(mut c) = CACHE.lock() {
        c.nodes.insert(
            ctx.to_string(),
            CacheEntry {
                value: value.clone(),
                fetched_at: Instant::now(),
            },
        );
    }
    value
}

pub async fn pod_usage(client: &Client, ctx: &str) -> Option<Vec<PodUsage>> {
    if let Ok(c) = CACHE.lock() {
        if let Some(entry) = c.pods.get(ctx) {
            if entry.fetched_at.elapsed() < ttl_for(&entry.value) {
                return entry.value.clone();
            }
        }
    }

    let value: Option<Vec<PodUsage>> =
        match get_raw::<MetricsList<PodMetricsItem>>(client, "/apis/metrics.k8s.io/v1beta1/pods")
            .await
        {
            Some(list) => Some(
                list.items
                    .into_iter()
                    .map(|p| {
                        let (cpu, mem) = p.containers.iter().fold((0i64, 0i64), |(c, m), ctr| {
                            let cpu = ctr
                                .usage
                                .cpu
                                .as_deref()
                                .and_then(parse_cpu_milli)
                                .unwrap_or(0);
                            let mem = ctr
                                .usage
                                .memory
                                .as_deref()
                                .and_then(parse_memory_bytes)
                                .unwrap_or(0);
                            (c + cpu, m + mem)
                        });
                        PodUsage {
                            name: p.metadata.name,
                            namespace: p.metadata.namespace.unwrap_or_default(),
                            cpu_milli: cpu,
                            mem_bytes: mem,
                        }
                    })
                    .collect(),
            ),
            None => None,
        };

    if let Ok(mut c) = CACHE.lock() {
        c.pods.insert(
            ctx.to_string(),
            CacheEntry {
                value: value.clone(),
                fetched_at: Instant::now(),
            },
        );
    }
    value
}

/// Drop every cached metrics result. Called from `reconnect_all` so that
/// "force reconnect" also re-probes metrics-server fresh, instead of serving
/// stale negatives left over from a degraded private network window.
pub fn invalidate_all() {
    if let Ok(mut c) = CACHE.lock() {
        c.nodes.clear();
        c.pods.clear();
    }
}

pub fn invalidate_context(ctx: &str) {
    if let Ok(mut c) = CACHE.lock() {
        c.nodes.remove(ctx);
        c.pods.remove(ctx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_parses_nanocores_micro_milli_and_cores() {
        assert_eq!(parse_cpu_milli("125000000n"), Some(125));
        assert_eq!(parse_cpu_milli("250000u"), Some(250));
        assert_eq!(parse_cpu_milli("500m"), Some(500));
        assert_eq!(parse_cpu_milli("2"), Some(2000));
    }

    #[test]
    fn memory_parses_binary_and_decimal_suffixes() {
        assert_eq!(parse_memory_bytes("512Mi"), Some(512 * 1024 * 1024));
        assert_eq!(parse_memory_bytes("2Gi"), Some(2 * 1024 * 1024 * 1024));
        assert_eq!(parse_memory_bytes("1000M"), Some(1_000_000_000));
        assert_eq!(parse_memory_bytes("1024"), Some(1024));
    }
}
