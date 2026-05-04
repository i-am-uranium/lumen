//! CloudMap: relationship graph + heatmap across a single cluster.
//!
//! Inspired by K8Studio's CloudMaps — nodes are Kubernetes resources,
//! edges are real selectors / ownerRefs / mounts / ingress backends /
//! HPA targets. The resulting graph is the data the frontend uses to
//! render a force-directed canvas with heat coloring.
//!
//! What we intentionally produce (not a flat list of objects):
//!
//! * Namespace "containers" so the UI can group.
//! * Workload → pod ownership edges, even across ReplicaSet hops.
//! * Service → pod selector edges (real label-selector matching).
//! * Ingress → service backend edges.
//! * HPA → target workload edges.
//! * ConfigMap / Secret / PVC mount edges from pod specs.
//! * `heat`: 0–100 per node, derived from CPU usage (pods) or replica pressure
//!   (workloads).

use crate::error::AppResult;
use crate::k8s::metrics;
use crate::k8s::resources;
use crate::k8s::types::{CloudMap, EdgeKind, Health, MapEdge, MapNode, NodeKind};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Pod, Secret, Service};
use k8s_openapi::api::networking::v1::Ingress;
use kube::{api::ListParams, Api, Client};
use std::collections::{BTreeMap, HashMap};

fn health_of_pod(p: &Pod) -> Health {
    let phase = p
        .status
        .as_ref()
        .and_then(|s| s.phase.as_deref())
        .unwrap_or("");
    let (ready, total) = p
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
        .map(|cs| (cs.iter().filter(|c| c.ready).count(), cs.len()))
        .unwrap_or((0, 0));
    match phase {
        "Running" if total > 0 && ready == total => Health::Healthy,
        "Succeeded" => Health::Healthy,
        "Pending" => Health::Unknown,
        "Failed" => Health::Failed,
        _ => Health::Degraded,
    }
}

fn heat_from_cpu(cpu_milli: Option<i64>, request_milli: i64) -> f32 {
    match cpu_milli {
        Some(used) if request_milli > 0 => {
            ((used as f32 / request_milli as f32) * 100.0).clamp(0.0, 100.0)
        }
        _ => 0.0,
    }
}

fn sum_cpu_request(p: &Pod) -> i64 {
    p.spec
        .as_ref()
        .map(|s| {
            s.containers
                .iter()
                .map(|c| {
                    c.resources
                        .as_ref()
                        .and_then(|r| r.requests.as_ref())
                        .and_then(|m| m.get("cpu"))
                        .and_then(|q| metrics::parse_cpu_milli(&q.0))
                        .unwrap_or(0)
                })
                .sum::<i64>()
        })
        .unwrap_or(0)
}

fn labels_match(selector: &BTreeMap<String, String>, labels: &BTreeMap<String, String>) -> bool {
    if selector.is_empty() {
        return false;
    }
    selector.iter().all(|(k, v)| labels.get(k) == Some(v))
}

fn pod_labels(p: &Pod) -> BTreeMap<String, String> {
    p.metadata
        .labels
        .clone()
        .map(|m| m.into_iter().collect())
        .unwrap_or_default()
}

fn ns_id(ns: &str) -> String {
    format!("ns/{ns}")
}
fn node_id(kind: &str, ns: &str, name: &str) -> String {
    format!("{kind}/{ns}/{name}")
}

/// Build the full cluster map for the given client. `namespace_filter = None`
/// means all namespaces. `ctx` is used as the cache key for metrics-server
/// results — different clusters have independent metrics availability.
pub async fn build(
    client: &Client,
    ctx: &str,
    namespace_filter: Option<String>,
) -> AppResult<CloudMap> {
    let fetched_at_ms = chrono::Utc::now().timestamp_millis();

    // Helper: scope a kube list by optional namespace.
    async fn list_scoped<K>(
        client: kube::Client,
        ns: Option<String>,
    ) -> Result<kube::core::ObjectList<K>, kube::Error>
    where
        K: kube::Resource<Scope = k8s_openapi::NamespaceResourceScope>
            + Clone
            + serde::de::DeserializeOwned
            + std::fmt::Debug,
        <K as kube::Resource>::DynamicType: Default,
    {
        let api = match ns {
            Some(n) => Api::<K>::namespaced(client, &n),
            None => Api::<K>::all(client),
        };
        api.list(&ListParams::default()).await
    }

    let nf = namespace_filter.clone();
    let (c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12) = (
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
        client.clone(),
    );
    let pod_usage_client = client.clone();
    let pod_usage_ctx = ctx.to_string();
    let (n0, n1, n2, n3, n4, n5, n6, n7, n8, n9, n10, n11) = (
        nf.clone(), nf.clone(), nf.clone(), nf.clone(), nf.clone(), nf.clone(),
        nf.clone(), nf.clone(), nf.clone(), nf.clone(), nf.clone(), nf.clone(),
    );

    let (ns, pods, deps, ss, ds, rs, svc, ing, cj, jobs, hpas, cms, secs, pusage) = tokio::join!(
        async move { Api::<Namespace>::all(c0).list(&ListParams::default()).await },
        list_scoped::<Pod>(c1, n0),
        list_scoped::<Deployment>(c2, n1),
        list_scoped::<StatefulSet>(c3, n2),
        list_scoped::<DaemonSet>(c4, n3),
        list_scoped::<ReplicaSet>(c5, n4),
        list_scoped::<Service>(c6, n5),
        list_scoped::<Ingress>(c7, n6),
        list_scoped::<CronJob>(c8, n7),
        list_scoped::<Job>(c9, n8),
        list_scoped::<HorizontalPodAutoscaler>(c10, n9),
        list_scoped::<ConfigMap>(c11, n10),
        list_scoped::<Secret>(c12, n11),
        async move { metrics::pod_usage(&pod_usage_client, &pod_usage_ctx).await },
    );

    let ns = ns.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let pods = pods.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let deps = deps.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let ss = ss.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let ds = ds.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let rs = rs.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let svc = svc.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let ing = ing.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let cj = cj.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let jobs = jobs.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    // HPAs may be unavailable on some managed clusters — don't fail the whole map.
    let hpas_items = hpas.ok().map(|l| l.items).unwrap_or_default();
    let cms = cms.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let secs = secs.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;

    let pod_cpu: HashMap<(String, String), i64> = pusage
        .map(|v| {
            v.into_iter()
                .map(|p| ((p.namespace, p.name), p.cpu_milli))
                .collect()
        })
        .unwrap_or_default();

    let mut nodes: Vec<MapNode> = Vec::new();
    let mut edges: Vec<MapEdge> = Vec::new();

    // Namespaces as container nodes (filtered when requested).
    for n in &ns.items {
        let name = n.metadata.name.clone().unwrap_or_default();
        if let Some(f) = &namespace_filter {
            if &name != f {
                continue;
            }
        }
        nodes.push(MapNode {
            id: ns_id(&name),
            kind: NodeKind::Namespace,
            name: name.clone(),
            namespace: None,
            health: Health::Healthy,
            heat: 0.0,
            ready: None,
            labels: Default::default(),
            replicas: None,
            extra: Default::default(),
        });
    }

    // Deployments.
    for d in &deps.items {
        let sum = resources::deployment_summary(d);
        let replicas = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
        let ready = d
            .status
            .as_ref()
            .and_then(|s| s.ready_replicas)
            .unwrap_or(0);
        let heat = if replicas == 0 {
            0.0
        } else {
            (1.0 - (ready as f32 / replicas as f32)).max(0.0) * 100.0
        };
        let id = node_id("deployment", &sum.namespace, &sum.name);
        edges.push(MapEdge {
            from: id.clone(),
            to: ns_id(&sum.namespace),
            kind: EdgeKind::OwnedBy,
        });
        nodes.push(MapNode {
            id,
            kind: NodeKind::Deployment,
            name: sum.name,
            namespace: Some(sum.namespace),
            health: sum.health,
            heat,
            ready: Some(sum.ready),
            labels: sum.labels,
            replicas: Some(replicas),
            extra: Default::default(),
        });
    }

    for s in &ss.items {
        let sum = resources::statefulset_summary(s);
        let replicas = s.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0);
        let ready = s
            .status
            .as_ref()
            .and_then(|st| st.ready_replicas)
            .unwrap_or(0);
        let heat = if replicas == 0 {
            0.0
        } else {
            (1.0 - (ready as f32 / replicas as f32)).max(0.0) * 100.0
        };
        let id = node_id("statefulset", &sum.namespace, &sum.name);
        edges.push(MapEdge {
            from: id.clone(),
            to: ns_id(&sum.namespace),
            kind: EdgeKind::OwnedBy,
        });
        nodes.push(MapNode {
            id,
            kind: NodeKind::StatefulSet,
            name: sum.name,
            namespace: Some(sum.namespace),
            health: sum.health,
            heat,
            ready: Some(sum.ready),
            labels: sum.labels,
            replicas: Some(replicas),
            extra: Default::default(),
        });
    }

    for d in &ds.items {
        let sum = resources::daemonset_summary(d);
        let desired = d
            .status
            .as_ref()
            .map(|s| s.desired_number_scheduled)
            .unwrap_or(0);
        let ready = d.status.as_ref().map(|s| s.number_ready).unwrap_or(0);
        let heat = if desired == 0 {
            0.0
        } else {
            (1.0 - (ready as f32 / desired as f32)).max(0.0) * 100.0
        };
        let id = node_id("daemonset", &sum.namespace, &sum.name);
        edges.push(MapEdge {
            from: id.clone(),
            to: ns_id(&sum.namespace),
            kind: EdgeKind::OwnedBy,
        });
        nodes.push(MapNode {
            id,
            kind: NodeKind::DaemonSet,
            name: sum.name,
            namespace: Some(sum.namespace),
            health: sum.health,
            heat,
            ready: Some(sum.ready),
            labels: sum.labels,
            replicas: Some(desired),
            extra: Default::default(),
        });
    }

    for c in &cj.items {
        let sum = resources::cronjob_summary(c);
        let schedule = c
            .spec
            .as_ref()
            .map(|s| s.schedule.clone())
            .unwrap_or_default();
        let id = node_id("cronjob", &sum.namespace, &sum.name);
        edges.push(MapEdge {
            from: id.clone(),
            to: ns_id(&sum.namespace),
            kind: EdgeKind::OwnedBy,
        });
        let mut extra = BTreeMap::new();
        extra.insert("schedule".into(), schedule);
        nodes.push(MapNode {
            id,
            kind: NodeKind::CronJob,
            name: sum.name,
            namespace: Some(sum.namespace),
            health: sum.health,
            heat: 0.0,
            ready: None,
            labels: sum.labels,
            replicas: None,
            extra,
        });
    }

    for j in &jobs.items {
        let sum = resources::job_summary(j);
        let id = node_id("job", &sum.namespace, &sum.name);
        edges.push(MapEdge {
            from: id.clone(),
            to: ns_id(&sum.namespace),
            kind: EdgeKind::OwnedBy,
        });
        nodes.push(MapNode {
            id,
            kind: NodeKind::Job,
            name: sum.name,
            namespace: Some(sum.namespace),
            health: sum.health,
            heat: 0.0,
            ready: Some(sum.ready),
            labels: sum.labels,
            replicas: None,
            extra: Default::default(),
        });
    }

    // Services — also record selector for later pod edge construction.
    let mut service_selectors: Vec<(String, String, BTreeMap<String, String>)> = Vec::new();
    for s in &svc.items {
        let name = s.metadata.name.clone().unwrap_or_default();
        let namespace = s.metadata.namespace.clone().unwrap_or_default();
        let id = node_id("service", &namespace, &name);
        edges.push(MapEdge {
            from: id.clone(),
            to: ns_id(&namespace),
            kind: EdgeKind::OwnedBy,
        });
        let selector: BTreeMap<String, String> = s
            .spec
            .as_ref()
            .and_then(|sp| sp.selector.clone())
            .map(|m| m.into_iter().collect())
            .unwrap_or_default();
        let svc_type = s
            .spec
            .as_ref()
            .and_then(|sp| sp.type_.clone())
            .unwrap_or_else(|| "ClusterIP".to_string());
        service_selectors.push((namespace.clone(), name.clone(), selector.clone()));
        let mut extra = BTreeMap::new();
        extra.insert("type".into(), svc_type);
        if !selector.is_empty() {
            extra.insert(
                "selector".into(),
                selector
                    .iter()
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        // Pack service ports for downstream consumers (port-forward dialog
        // uses these as suggestions). Keep it as a comma-separated list of
        // service port numbers.
        if let Some(ports) = s.spec.as_ref().and_then(|sp| sp.ports.as_ref()) {
            let ps: Vec<String> = ports.iter().map(|p| p.port.to_string()).collect();
            if !ps.is_empty() {
                extra.insert("ports".into(), ps.join(","));
            }
        }
        nodes.push(MapNode {
            id,
            kind: NodeKind::Service,
            name,
            namespace: Some(namespace),
            health: Health::Unknown,
            heat: 0.0,
            ready: None,
            labels: Default::default(),
            replicas: None,
            extra,
        });
    }

    // Ingresses → routes → services.
    for i in &ing.items {
        let name = i.metadata.name.clone().unwrap_or_default();
        let namespace = i.metadata.namespace.clone().unwrap_or_default();
        let id = node_id("ingress", &namespace, &name);
        edges.push(MapEdge {
            from: id.clone(),
            to: ns_id(&namespace),
            kind: EdgeKind::OwnedBy,
        });
        if let Some(spec) = &i.spec {
            if let Some(rules) = &spec.rules {
                for rule in rules {
                    if let Some(http) = &rule.http {
                        for path in &http.paths {
                            if let Some(be_svc) = path.backend.service.as_ref() {
                                let svc_id = node_id("service", &namespace, &be_svc.name);
                                edges.push(MapEdge {
                                    from: id.clone(),
                                    to: svc_id,
                                    kind: EdgeKind::Routes,
                                });
                            }
                        }
                    }
                }
            }
        }
        let mut extra = BTreeMap::new();
        if let Some(spec) = &i.spec {
            if let Some(cls) = &spec.ingress_class_name {
                extra.insert("class".into(), cls.clone());
            }
            if let Some(rules) = &spec.rules {
                let hosts: Vec<String> = rules.iter().filter_map(|r| r.host.clone()).collect();
                if !hosts.is_empty() {
                    extra.insert("hosts".into(), hosts.join(","));
                }
            }
        }
        nodes.push(MapNode {
            id,
            kind: NodeKind::Ingress,
            name,
            namespace: Some(namespace),
            health: Health::Unknown,
            heat: 0.0,
            ready: None,
            labels: Default::default(),
            replicas: None,
            extra,
        });
    }

    // HPAs → scale → workloads.
    for h in &hpas_items {
        let name = h.metadata.name.clone().unwrap_or_default();
        let namespace = h.metadata.namespace.clone().unwrap_or_default();
        let id = node_id("hpa", &namespace, &name);
        edges.push(MapEdge {
            from: id.clone(),
            to: ns_id(&namespace),
            kind: EdgeKind::OwnedBy,
        });
        if let Some(spec) = &h.spec {
            let target_kind = spec.scale_target_ref.kind.to_lowercase();
            let target_name = spec.scale_target_ref.name.clone();
            let target_id = node_id(&target_kind, &namespace, &target_name);
            edges.push(MapEdge {
                from: id.clone(),
                to: target_id,
                kind: EdgeKind::Scales,
            });
        }
        let mut extra = BTreeMap::new();
        if let Some(spec) = &h.spec {
            extra.insert("min".into(), spec.min_replicas.unwrap_or(1).to_string());
            extra.insert("max".into(), spec.max_replicas.to_string());
        }
        nodes.push(MapNode {
            id,
            kind: NodeKind::Hpa,
            name,
            namespace: Some(namespace),
            health: Health::Unknown,
            heat: 0.0,
            ready: None,
            labels: Default::default(),
            replicas: None,
            extra,
        });
    }

    // ReplicaSet → owning Deployment lookup for pod ownership resolution.
    let rs_to_deployment: HashMap<String, String> = rs
        .items
        .iter()
        .filter_map(|r| {
            let ns = r.metadata.namespace.clone()?;
            let name = r.metadata.name.clone()?;
            let owner = r
                .metadata
                .owner_references
                .as_ref()
                .and_then(|v| v.iter().find(|o| o.kind == "Deployment"))
                .map(|o| o.name.clone())?;
            Some((format!("{ns}/{name}"), format!("{ns}/{owner}")))
        })
        .collect();

    // Pods: add node, owner edge, service select edges, config/secret mount edges.
    let configmap_names: std::collections::HashSet<(String, String)> = cms
        .items
        .iter()
        .filter_map(|c| {
            Some((
                c.metadata.namespace.clone()?,
                c.metadata.name.clone()?,
            ))
        })
        .collect();
    let secret_names: std::collections::HashSet<(String, String)> = secs
        .items
        .iter()
        .filter_map(|s| {
            Some((
                s.metadata.namespace.clone()?,
                s.metadata.name.clone()?,
            ))
        })
        .collect();

    // ConfigMap / Secret nodes (only those referenced by at least one pod get
    // surfaced — avoids drowning the map in noise).
    let mut referenced_cms: std::collections::HashSet<(String, String)> = Default::default();
    let mut referenced_secs: std::collections::HashSet<(String, String)> = Default::default();

    // Bucket service selectors by namespace once so the per-pod selector loop
    // only scans services in the pod's own namespace — services never cross
    // namespaces, so the cross-ns comparisons in the previous flat loop were
    // pure waste at O(svc_total × pods) scale.
    let mut service_selectors_by_ns: HashMap<&str, Vec<(&str, &BTreeMap<String, String>)>> =
        HashMap::new();
    for (svc_ns, svc_name, sel) in &service_selectors {
        if sel.is_empty() {
            continue;
        }
        service_selectors_by_ns
            .entry(svc_ns.as_str())
            .or_default()
            .push((svc_name.as_str(), sel));
    }

    for p in &pods.items {
        let name = p.metadata.name.clone().unwrap_or_default();
        let namespace = p.metadata.namespace.clone().unwrap_or_default();
        let id = node_id("pod", &namespace, &name);
        let cpu_req = sum_cpu_request(p);
        let cpu_used = pod_cpu.get(&(namespace.clone(), name.clone())).copied();
        let heat = heat_from_cpu(cpu_used, cpu_req);

        // Owner edge.
        if let Some(owners) = &p.metadata.owner_references {
            for o in owners {
                let owner_kind = o.kind.to_lowercase();
                // ReplicaSet → Deployment hop.
                if o.kind == "ReplicaSet" {
                    let rs_key = format!("{namespace}/{}", o.name);
                    if let Some(dep_key) = rs_to_deployment.get(&rs_key) {
                        let dep_id = format!("deployment/{dep_key}");
                        edges.push(MapEdge {
                            from: id.clone(),
                            to: dep_id,
                            kind: EdgeKind::OwnedBy,
                        });
                        continue;
                    }
                }
                edges.push(MapEdge {
                    from: id.clone(),
                    to: node_id(&owner_kind, &namespace, &o.name),
                    kind: EdgeKind::OwnedBy,
                });
            }
        } else {
            edges.push(MapEdge {
                from: id.clone(),
                to: ns_id(&namespace),
                kind: EdgeKind::OwnedBy,
            });
        }

        // Pods ← services via label-selector.
        // service_selectors is bucketed by namespace once before this loop, so
        // each pod only scans services in its own namespace instead of the
        // whole cluster (cuts O(svc_total × pods) → O(svc_in_ns × pods)).
        let p_labels = pod_labels(p);
        if let Some(ns_services) = service_selectors_by_ns.get(namespace.as_str()) {
            for (svc_name, sel) in ns_services {
                if labels_match(sel, &p_labels) {
                    edges.push(MapEdge {
                        from: node_id("service", &namespace, svc_name),
                        to: id.clone(),
                        kind: EdgeKind::Selects,
                    });
                }
            }
        }

        // Mount edges for configmaps, secrets, pvcs.
        if let Some(spec) = &p.spec {
            if let Some(vols) = &spec.volumes {
                for v in vols {
                    if let Some(cm) = &v.config_map {
                        let n = &cm.name;
                        if configmap_names.contains(&(namespace.clone(), n.clone())) {
                            referenced_cms.insert((namespace.clone(), n.clone()));
                            edges.push(MapEdge {
                                from: id.clone(),
                                to: node_id("configmap", &namespace, n),
                                kind: EdgeKind::Mounts,
                            });
                        }
                    }
                    if let Some(se) = &v.secret {
                        if let Some(n) = &se.secret_name {
                            if secret_names.contains(&(namespace.clone(), n.clone())) {
                                referenced_secs.insert((namespace.clone(), n.clone()));
                                edges.push(MapEdge {
                                    from: id.clone(),
                                    to: node_id("secret", &namespace, n),
                                    kind: EdgeKind::Mounts,
                                });
                            }
                        }
                    }
                    if let Some(pvc) = &v.persistent_volume_claim {
                        edges.push(MapEdge {
                            from: id.clone(),
                            to: node_id("pvc", &namespace, &pvc.claim_name),
                            kind: EdgeKind::Mounts,
                        });
                    }
                }
            }
            // envFrom + env.valueFrom for config/secret usage.
            for c in &spec.containers {
                if let Some(envs) = &c.env_from {
                    for e in envs {
                        if let Some(cmr) = &e.config_map_ref {
                            let n = &cmr.name;
                            if configmap_names.contains(&(namespace.clone(), n.clone())) {
                                referenced_cms.insert((namespace.clone(), n.clone()));
                                edges.push(MapEdge {
                                    from: id.clone(),
                                    to: node_id("configmap", &namespace, n),
                                    kind: EdgeKind::Mounts,
                                });
                            }
                        }
                        if let Some(sr) = &e.secret_ref {
                            let n = &sr.name;
                            if secret_names.contains(&(namespace.clone(), n.clone())) {
                                referenced_secs.insert((namespace.clone(), n.clone()));
                                edges.push(MapEdge {
                                    from: id.clone(),
                                    to: node_id("secret", &namespace, n),
                                    kind: EdgeKind::Mounts,
                                });
                            }
                        }
                    }
                }
            }
            // Scheduled on.
            if let Some(node_name) = &spec.node_name {
                edges.push(MapEdge {
                    from: id.clone(),
                    to: format!("node//{node_name}"),
                    kind: EdgeKind::ScheduledOn,
                });
            }
        }

        let mut extra = BTreeMap::new();
        if let Some(restarts) = p
            .status
            .as_ref()
            .and_then(|s| s.container_statuses.as_ref())
            .map(|cs| cs.iter().map(|c| c.restart_count).sum::<i32>())
        {
            extra.insert("restarts".into(), restarts.to_string());
        }
        if let Some(cpu) = cpu_used {
            extra.insert("cpu_milli".into(), cpu.to_string());
        }

        nodes.push(MapNode {
            id,
            kind: NodeKind::Pod,
            name,
            namespace: Some(namespace),
            health: health_of_pod(p),
            heat,
            ready: None,
            labels: p_labels,
            replicas: None,
            extra,
        });
    }

    // Add ConfigMap / Secret nodes only if referenced.
    for (ns, name) in &referenced_cms {
        nodes.push(MapNode {
            id: node_id("configmap", ns, name),
            kind: NodeKind::ConfigMap,
            name: name.clone(),
            namespace: Some(ns.clone()),
            health: Health::Unknown,
            heat: 0.0,
            ready: None,
            labels: Default::default(),
            replicas: None,
            extra: Default::default(),
        });
    }
    for (ns, name) in &referenced_secs {
        nodes.push(MapNode {
            id: node_id("secret", ns, name),
            kind: NodeKind::Secret,
            name: name.clone(),
            namespace: Some(ns.clone()),
            health: Health::Unknown,
            heat: 0.0,
            ready: None,
            labels: Default::default(),
            replicas: None,
            extra: Default::default(),
        });
    }

    // Drop edges pointing at nodes we never created (e.g. owner refs into
    // missing kinds, or PVC / Node references we didn't list). Keeps the graph
    // consistent for the frontend.
    let id_set: std::collections::HashSet<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    let edges: Vec<MapEdge> = edges
        .into_iter()
        .filter(|e| id_set.contains(e.from.as_str()) && id_set.contains(e.to.as_str()))
        .collect();

    Ok(CloudMap {
        context: String::new(),
        nodes,
        edges,
        fetched_at_ms,
    })
}
