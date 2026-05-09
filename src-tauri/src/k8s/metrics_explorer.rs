use crate::error::{AppError, AppResult};
use crate::k8s::{fleet, metrics};
use k8s_openapi::api::core::v1::Pod;
use kube::{api::ListParams, Api, Client, ResourceExt};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
pub struct ContainerResourceQuantities<'a> {
    pub cpu_request: Option<&'a str>,
    pub cpu_limit: Option<&'a str>,
    pub memory_request: Option<&'a str>,
    pub memory_limit: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceTotals {
    pub cpu_request_milli: Option<i64>,
    pub cpu_limit_milli: Option<i64>,
    pub mem_request_bytes: Option<i64>,
    pub mem_limit_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsExplorerSnapshot {
    pub fetched_at_ms: i64,
    pub errors: Vec<String>,
    pub nodes: Vec<MetricsExplorerNode>,
    pub pods: Vec<MetricsExplorerPod>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsExplorerNode {
    pub name: String,
    pub ready: bool,
    pub cpu_allocatable_milli: i64,
    pub mem_allocatable_bytes: i64,
    pub cpu_usage_milli: Option<i64>,
    pub mem_usage_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsExplorerPod {
    pub namespace: String,
    pub name: String,
    pub node_name: Option<String>,
    pub workload_kind: String,
    pub workload_name: String,
    pub cpu_usage_milli: Option<i64>,
    pub mem_usage_bytes: Option<i64>,
    pub cpu_request_milli: Option<i64>,
    pub cpu_limit_milli: Option<i64>,
    pub mem_request_bytes: Option<i64>,
    pub mem_limit_bytes: Option<i64>,
}

fn sum_option(total: &mut i64, seen: &mut bool, value: Option<i64>) {
    if let Some(value) = value {
        *total += value;
        *seen = true;
    }
}

fn some_if_seen(value: i64, seen: bool) -> Option<i64> {
    if seen {
        Some(value)
    } else {
        None
    }
}

pub fn resource_totals<'a>(
    containers: impl IntoIterator<Item = ContainerResourceQuantities<'a>>,
) -> ResourceTotals {
    let mut cpu_request = 0;
    let mut cpu_limit = 0;
    let mut mem_request = 0;
    let mut mem_limit = 0;
    let mut saw_cpu_request = false;
    let mut saw_cpu_limit = false;
    let mut saw_mem_request = false;
    let mut saw_mem_limit = false;

    for container in containers {
        sum_option(
            &mut cpu_request,
            &mut saw_cpu_request,
            container.cpu_request.and_then(metrics::parse_cpu_milli),
        );
        sum_option(
            &mut cpu_limit,
            &mut saw_cpu_limit,
            container.cpu_limit.and_then(metrics::parse_cpu_milli),
        );
        sum_option(
            &mut mem_request,
            &mut saw_mem_request,
            container
                .memory_request
                .and_then(metrics::parse_memory_bytes),
        );
        sum_option(
            &mut mem_limit,
            &mut saw_mem_limit,
            container.memory_limit.and_then(metrics::parse_memory_bytes),
        );
    }

    ResourceTotals {
        cpu_request_milli: some_if_seen(cpu_request, saw_cpu_request),
        cpu_limit_milli: some_if_seen(cpu_limit, saw_cpu_limit),
        mem_request_bytes: some_if_seen(mem_request, saw_mem_request),
        mem_limit_bytes: some_if_seen(mem_limit, saw_mem_limit),
    }
}

fn pod_workload(pod: &Pod) -> (String, String) {
    let owner = pod.metadata.owner_references.as_ref().and_then(|owners| {
        owners
            .iter()
            .find(|owner| owner.controller.unwrap_or(false))
            .or_else(|| owners.first())
    });
    match owner {
        Some(owner) => (owner.kind.clone(), owner.name.clone()),
        None => ("Pod".to_string(), pod.name_any()),
    }
}

fn pod_resource_totals(pod: &Pod) -> ResourceTotals {
    let containers = pod
        .spec
        .as_ref()
        .map(|spec| {
            spec.containers.iter().map(|container| {
                let resources = container.resources.as_ref();
                let requests = resources.and_then(|res| res.requests.as_ref());
                let limits = resources.and_then(|res| res.limits.as_ref());
                ContainerResourceQuantities {
                    cpu_request: requests
                        .and_then(|values| values.get("cpu"))
                        .map(|quantity| quantity.0.as_str()),
                    cpu_limit: limits
                        .and_then(|values| values.get("cpu"))
                        .map(|quantity| quantity.0.as_str()),
                    memory_request: requests
                        .and_then(|values| values.get("memory"))
                        .map(|quantity| quantity.0.as_str()),
                    memory_limit: limits
                        .and_then(|values| values.get("memory"))
                        .map(|quantity| quantity.0.as_str()),
                }
            })
        })
        .into_iter()
        .flatten();
    resource_totals(containers)
}

pub async fn snapshot(
    client: &Client,
    ctx: &str,
    namespace: Option<&str>,
) -> AppResult<MetricsExplorerSnapshot> {
    let nodes = fleet::list_nodes(client, ctx).await?;
    let node_rows: Vec<MetricsExplorerNode> = nodes
        .iter()
        .map(|node| MetricsExplorerNode {
            name: node.name.clone(),
            ready: node.ready,
            cpu_allocatable_milli: node.cpu_allocatable_milli,
            mem_allocatable_bytes: node.mem_allocatable_bytes,
            cpu_usage_milli: node.cpu_usage_milli,
            mem_usage_bytes: node.mem_usage_bytes,
        })
        .collect();

    let pod_api: Api<Pod> = match namespace.filter(|value| !value.is_empty()) {
        Some(namespace) => Api::namespaced(client.clone(), namespace),
        None => Api::all(client.clone()),
    };
    let pod_list = pod_api
        .list(&ListParams::default())
        .await
        .map_err(|error| AppError::K8s(error.to_string()))?;

    let pod_usage = metrics::pod_usage(client, ctx).await;
    let usage_by_pod: HashMap<(String, String), (i64, i64)> = pod_usage
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|usage| {
            (
                (usage.namespace, usage.name),
                (usage.cpu_milli, usage.mem_bytes),
            )
        })
        .collect();

    let pod_rows: Vec<MetricsExplorerPod> = pod_list
        .items
        .iter()
        .map(|pod| {
            let namespace = pod.namespace().unwrap_or_default();
            let name = pod.name_any();
            let (workload_kind, workload_name) = pod_workload(pod);
            let totals = pod_resource_totals(pod);
            let usage = usage_by_pod
                .get(&(namespace.clone(), name.clone()))
                .copied();
            MetricsExplorerPod {
                namespace,
                name,
                node_name: pod.spec.as_ref().and_then(|spec| spec.node_name.clone()),
                workload_kind,
                workload_name,
                cpu_usage_milli: usage.map(|(cpu, _)| cpu),
                mem_usage_bytes: usage.map(|(_, memory)| memory),
                cpu_request_milli: totals.cpu_request_milli,
                cpu_limit_milli: totals.cpu_limit_milli,
                mem_request_bytes: totals.mem_request_bytes,
                mem_limit_bytes: totals.mem_limit_bytes,
            }
        })
        .collect();

    let mut errors = Vec::new();
    if !node_rows.is_empty()
        && node_rows
            .iter()
            .all(|node| node.cpu_usage_milli.is_none() && node.mem_usage_bytes.is_none())
    {
        errors.push(
            "node metrics unavailable: metrics-server may be missing or RBAC denied".to_string(),
        );
    }
    if pod_usage.is_none() {
        errors.push(
            "pod metrics unavailable: metrics-server may be missing or RBAC denied".to_string(),
        );
    }

    Ok(MetricsExplorerSnapshot {
        fetched_at_ms: chrono::Utc::now().timestamp_millis(),
        errors,
        nodes: node_rows,
        pods: pod_rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_totals_sum_parseable_container_requests_and_limits() {
        let totals = resource_totals([
            ContainerResourceQuantities {
                cpu_request: Some("250m"),
                cpu_limit: Some("1"),
                memory_request: Some("128Mi"),
                memory_limit: Some("256Mi"),
            },
            ContainerResourceQuantities {
                cpu_request: Some("0.5"),
                cpu_limit: None,
                memory_request: Some("1Gi"),
                memory_limit: Some("bad"),
            },
        ]);

        assert_eq!(totals.cpu_request_milli, Some(750));
        assert_eq!(totals.cpu_limit_milli, Some(1000));
        assert_eq!(totals.mem_request_bytes, Some(1_207_959_552));
        assert_eq!(totals.mem_limit_bytes, Some(268_435_456));
    }
}
