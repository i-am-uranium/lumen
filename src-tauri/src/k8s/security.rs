//! DevSec rule engine.
//!
//! Pragmatic, high-signal checks that run against live cluster state. Not a
//! replacement for kube-bench / Trivy — these rules surface the findings that
//! operators actually want to see on day one: privileged containers, root
//! users, missing resource limits, over-broad RBAC, missing NetworkPolicy
//! coverage, and default-namespace workloads.
//!
//! Each rule returns zero or more `Finding`s. Rules are pure functions over
//! fetched list objects, which makes them easy to unit test and extend.

use crate::error::AppResult;
use crate::k8s::types::{Finding, SecurityReport, Severity};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::core::v1::{Pod, PodSpec, Service};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use k8s_openapi::api::rbac::v1::{ClusterRole, ClusterRoleBinding, Role, RoleBinding};
use kube::{api::ListParams, Api, Client};
use std::collections::BTreeMap;

fn sev_key(s: Severity) -> &'static str {
    match s {
        Severity::Critical => "critical",
        Severity::High => "high",
        Severity::Medium => "medium",
        Severity::Low => "low",
        Severity::Info => "info",
    }
}

fn pod_spec_findings(
    kind: &str,
    name: &str,
    namespace: &str,
    spec: &PodSpec,
) -> Vec<Finding> {
    let mut out = Vec::new();

    // Host networking / PID / IPC.
    if spec.host_network.unwrap_or(false) {
        out.push(Finding {
            rule_id: "POD-HOSTNET".into(),
            title: "Host networking enabled".into(),
            severity: Severity::High,
            category: "Workload".into(),
            resource_kind: kind.into(),
            resource_name: name.into(),
            namespace: Some(namespace.into()),
            detail: "Pod uses the host network namespace, bypassing CNI isolation.".into(),
            remediation: "Set spec.hostNetwork=false unless the workload is a node-level agent.".into(),
        });
    }
    if spec.host_pid.unwrap_or(false) {
        out.push(Finding {
            rule_id: "POD-HOSTPID".into(),
            title: "Host PID namespace enabled".into(),
            severity: Severity::High,
            category: "Workload".into(),
            resource_kind: kind.into(),
            resource_name: name.into(),
            namespace: Some(namespace.into()),
            detail: "Pod can see all host processes.".into(),
            remediation: "Set spec.hostPID=false.".into(),
        });
    }

    // HostPath volumes.
    if let Some(vols) = &spec.volumes {
        for v in vols {
            if let Some(hp) = &v.host_path {
                out.push(Finding {
                    rule_id: "POD-HOSTPATH".into(),
                    title: "hostPath volume mounted".into(),
                    severity: Severity::High,
                    category: "Workload".into(),
                    resource_kind: kind.into(),
                    resource_name: name.into(),
                    namespace: Some(namespace.into()),
                    detail: format!("Volume '{}' mounts host path '{}'.", v.name, hp.path),
                    remediation: "Replace hostPath with a managed volume (PVC, emptyDir, or CSI).".into(),
                });
            }
        }
    }

    // Containers.
    for c in &spec.containers {
        let cname = &c.name;
        let sc = c.security_context.as_ref();
        let privileged = sc.and_then(|s| s.privileged).unwrap_or(false);
        let allow_priv_esc = sc.and_then(|s| s.allow_privilege_escalation).unwrap_or(true);
        let read_only_rootfs = sc.and_then(|s| s.read_only_root_filesystem).unwrap_or(false);
        let run_as_non_root = sc.and_then(|s| s.run_as_non_root).unwrap_or(false);
        let run_as_user = sc.and_then(|s| s.run_as_user);
        let caps_add = sc
            .and_then(|s| s.capabilities.as_ref())
            .and_then(|c| c.add.as_ref())
            .cloned()
            .unwrap_or_default();

        if privileged {
            out.push(Finding {
                rule_id: "CTR-PRIVILEGED".into(),
                title: format!("Container '{cname}' is privileged"),
                severity: Severity::Critical,
                category: "Workload".into(),
                resource_kind: kind.into(),
                resource_name: name.into(),
                namespace: Some(namespace.into()),
                detail: "Privileged containers have full host access.".into(),
                remediation: "Drop securityContext.privileged. Grant specific capabilities instead.".into(),
            });
        }
        if allow_priv_esc {
            out.push(Finding {
                rule_id: "CTR-ALLOWPRIVESC".into(),
                title: format!("Container '{cname}' allows privilege escalation"),
                severity: Severity::Medium,
                category: "Workload".into(),
                resource_kind: kind.into(),
                resource_name: name.into(),
                namespace: Some(namespace.into()),
                detail: "allowPrivilegeEscalation defaults to true.".into(),
                remediation: "Set securityContext.allowPrivilegeEscalation=false.".into(),
            });
        }
        if !run_as_non_root && run_as_user.map(|u| u == 0).unwrap_or(true) {
            out.push(Finding {
                rule_id: "CTR-RUNASROOT".into(),
                title: format!("Container '{cname}' may run as root"),
                severity: Severity::High,
                category: "Workload".into(),
                resource_kind: kind.into(),
                resource_name: name.into(),
                namespace: Some(namespace.into()),
                detail: "No runAsNonRoot=true and no non-zero runAsUser set.".into(),
                remediation: "Set securityContext.runAsNonRoot=true and a non-zero runAsUser.".into(),
            });
        }
        if !read_only_rootfs {
            out.push(Finding {
                rule_id: "CTR-RWROOTFS".into(),
                title: format!("Container '{cname}' has writable root filesystem"),
                severity: Severity::Low,
                category: "Workload".into(),
                resource_kind: kind.into(),
                resource_name: name.into(),
                namespace: Some(namespace.into()),
                detail: "readOnlyRootFilesystem is not set.".into(),
                remediation: "Set securityContext.readOnlyRootFilesystem=true and use emptyDir for writable paths.".into(),
            });
        }
        if !caps_add.is_empty() {
            out.push(Finding {
                rule_id: "CTR-CAPS".into(),
                title: format!("Container '{cname}' adds Linux capabilities"),
                severity: Severity::Medium,
                category: "Workload".into(),
                resource_kind: kind.into(),
                resource_name: name.into(),
                namespace: Some(namespace.into()),
                detail: format!(
                    "Adds: {}",
                    caps_add
                        .iter()
                        .map(|c| format!("{c:?}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                remediation: "Drop added capabilities unless the workload truly needs them. Drop ALL by default.".into(),
            });
        }

        // Resource limits / requests.
        let res = c.resources.as_ref();
        if res.and_then(|r| r.limits.as_ref()).is_none() {
            out.push(Finding {
                rule_id: "CTR-NOLIMITS".into(),
                title: format!("Container '{cname}' has no resource limits"),
                severity: Severity::Medium,
                category: "Reliability".into(),
                resource_kind: kind.into(),
                resource_name: name.into(),
                namespace: Some(namespace.into()),
                detail: "Missing resource.limits — pod can consume unbounded node resources.".into(),
                remediation: "Set resources.limits.cpu and .memory.".into(),
            });
        }
        if res.and_then(|r| r.requests.as_ref()).is_none() {
            out.push(Finding {
                rule_id: "CTR-NOREQUESTS".into(),
                title: format!("Container '{cname}' has no resource requests"),
                severity: Severity::Low,
                category: "Reliability".into(),
                resource_kind: kind.into(),
                resource_name: name.into(),
                namespace: Some(namespace.into()),
                detail: "Missing resource.requests — scheduler cannot reason about placement.".into(),
                remediation: "Set resources.requests.cpu and .memory.".into(),
            });
        }

        // Probes.
        if c.liveness_probe.is_none() {
            out.push(Finding {
                rule_id: "CTR-NOLIVENESS".into(),
                title: format!("Container '{cname}' has no liveness probe"),
                severity: Severity::Low,
                category: "Reliability".into(),
                resource_kind: kind.into(),
                resource_name: name.into(),
                namespace: Some(namespace.into()),
                detail: "No livenessProbe configured.".into(),
                remediation: "Add livenessProbe so kubelet can restart hung pods.".into(),
            });
        }
        if c.readiness_probe.is_none() {
            out.push(Finding {
                rule_id: "CTR-NOREADINESS".into(),
                title: format!("Container '{cname}' has no readiness probe"),
                severity: Severity::Low,
                category: "Reliability".into(),
                resource_kind: kind.into(),
                resource_name: name.into(),
                namespace: Some(namespace.into()),
                detail: "No readinessProbe configured.".into(),
                remediation: "Add readinessProbe so traffic is only routed to ready pods.".into(),
            });
        }

        // Latest tag.
        if let Some(img) = &c.image {
            if img.ends_with(":latest") || !img.contains(':') {
                out.push(Finding {
                    rule_id: "CTR-LATEST".into(),
                    title: format!("Container '{cname}' uses mutable image tag"),
                    severity: Severity::Medium,
                    category: "Supply Chain".into(),
                    resource_kind: kind.into(),
                    resource_name: name.into(),
                    namespace: Some(namespace.into()),
                    detail: format!("Image '{img}' has no pinned digest or tag."),
                    remediation: "Pin to an immutable digest (@sha256:...) or at least a specific tag.".into(),
                });
            }
        }
    }

    // Default service account automount.
    let automount = spec.automount_service_account_token.unwrap_or(true);
    let uses_default = spec
        .service_account_name
        .as_deref()
        .map(|n| n == "default")
        .unwrap_or(true);
    if automount && uses_default {
        out.push(Finding {
            rule_id: "POD-DEFAULT-SA".into(),
            title: "Pod auto-mounts default ServiceAccount token".into(),
            severity: Severity::Medium,
            category: "RBAC".into(),
            resource_kind: kind.into(),
            resource_name: name.into(),
            namespace: Some(namespace.into()),
            detail: "Default SA is used and its token is auto-mounted.".into(),
            remediation: "Create a dedicated ServiceAccount and set automountServiceAccountToken=false when not needed.".into(),
        });
    }

    out
}

fn rbac_findings(
    cluster_roles: &[ClusterRole],
    cluster_bindings: &[ClusterRoleBinding],
    roles: &[Role],
) -> Vec<Finding> {
    let mut out = Vec::new();

    // cluster-admin bindings.
    for b in cluster_bindings {
        if b.role_ref.name == "cluster-admin" {
            let subjects = b
                .subjects
                .as_ref()
                .map(|ss| {
                    ss.iter()
                        .map(|s| format!("{}:{}", s.kind, s.name))
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            out.push(Finding {
                rule_id: "RBAC-CLUSTERADMIN".into(),
                title: format!(
                    "ClusterRoleBinding '{}' grants cluster-admin",
                    b.metadata.name.clone().unwrap_or_default()
                ),
                severity: Severity::Critical,
                category: "RBAC".into(),
                resource_kind: "ClusterRoleBinding".into(),
                resource_name: b.metadata.name.clone().unwrap_or_default(),
                namespace: None,
                detail: format!("Subjects: {subjects}"),
                remediation: "Narrow to least-privilege. cluster-admin should only belong to break-glass identities.".into(),
            });
        }
    }

    // Wildcard verbs/resources in ClusterRoles.
    for cr in cluster_roles {
        if let Some(rules) = &cr.rules {
            for r in rules {
                let has_wildcard_verb = r.verbs.iter().any(|v| v == "*");
                let has_wildcard_resource = r
                    .resources
                    .as_ref()
                    .map(|rs| rs.iter().any(|r| r == "*"))
                    .unwrap_or(false);
                if has_wildcard_verb && has_wildcard_resource {
                    out.push(Finding {
                        rule_id: "RBAC-WILDCARD".into(),
                        title: format!(
                            "ClusterRole '{}' grants */*",
                            cr.metadata.name.clone().unwrap_or_default()
                        ),
                        severity: Severity::High,
                        category: "RBAC".into(),
                        resource_kind: "ClusterRole".into(),
                        resource_name: cr.metadata.name.clone().unwrap_or_default(),
                        namespace: None,
                        detail: "Rule uses wildcard verbs against wildcard resources.".into(),
                        remediation: "Enumerate only the verbs and resources needed.".into(),
                    });
                    break;
                }
            }
        }
    }

    for r in roles {
        if let Some(rules) = &r.rules {
            for rule in rules {
                let has_wildcard_verb = rule.verbs.iter().any(|v| v == "*");
                let has_wildcard_resource = rule
                    .resources
                    .as_ref()
                    .map(|rs| rs.iter().any(|rr| rr == "*"))
                    .unwrap_or(false);
                if has_wildcard_verb && has_wildcard_resource {
                    out.push(Finding {
                        rule_id: "RBAC-NS-WILDCARD".into(),
                        title: format!(
                            "Role '{}' grants */* in namespace",
                            r.metadata.name.clone().unwrap_or_default()
                        ),
                        severity: Severity::Medium,
                        category: "RBAC".into(),
                        resource_kind: "Role".into(),
                        resource_name: r.metadata.name.clone().unwrap_or_default(),
                        namespace: r.metadata.namespace.clone(),
                        detail: "Rule uses wildcard verbs against wildcard resources.".into(),
                        remediation: "Enumerate only the verbs and resources needed.".into(),
                    });
                    break;
                }
            }
        }
    }

    out
}

fn namespace_coverage_findings(
    netpols: &[NetworkPolicy],
    workload_namespaces: &std::collections::BTreeSet<String>,
) -> Vec<Finding> {
    let netpol_namespaces: std::collections::BTreeSet<String> = netpols
        .iter()
        .filter_map(|n| n.metadata.namespace.clone())
        .collect();
    workload_namespaces
        .difference(&netpol_namespaces)
        .filter(|ns| {
            // Skip system namespaces.
            !matches!(
                ns.as_str(),
                "kube-system" | "kube-public" | "kube-node-lease"
            )
        })
        .map(|ns| Finding {
            rule_id: "NET-NOPOLICY".into(),
            title: format!("Namespace '{ns}' has no NetworkPolicy"),
            severity: Severity::Medium,
            category: "Network".into(),
            resource_kind: "Namespace".into(),
            resource_name: ns.clone(),
            namespace: Some(ns.clone()),
            detail: "Workloads exist in this namespace but no NetworkPolicy is defined.".into(),
            remediation: "Apply a default-deny NetworkPolicy and explicit allow rules.".into(),
        })
        .collect()
}

fn service_exposure_findings(services: &[Service]) -> Vec<Finding> {
    let mut out = Vec::new();
    for s in services {
        let t = s
            .spec
            .as_ref()
            .and_then(|sp| sp.type_.clone())
            .unwrap_or_default();
        if t == "NodePort" {
            out.push(Finding {
                rule_id: "SVC-NODEPORT".into(),
                title: format!(
                    "Service '{}' is type NodePort",
                    s.metadata.name.clone().unwrap_or_default()
                ),
                severity: Severity::Low,
                category: "Network".into(),
                resource_kind: "Service".into(),
                resource_name: s.metadata.name.clone().unwrap_or_default(),
                namespace: s.metadata.namespace.clone(),
                detail: "NodePort exposes the service on every node.".into(),
                remediation: "Prefer ClusterIP + Ingress or LoadBalancer.".into(),
            });
        }
    }
    out
}

fn default_namespace_findings(
    deployments: &[Deployment],
    statefulsets: &[StatefulSet],
    daemonsets: &[DaemonSet],
) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut push = |kind: &str, name: String| {
        out.push(Finding {
            rule_id: "NS-DEFAULT".into(),
            title: format!("{kind} '{name}' runs in 'default' namespace"),
            severity: Severity::Low,
            category: "Hygiene".into(),
            resource_kind: kind.into(),
            resource_name: name.clone(),
            namespace: Some("default".into()),
            detail: "Production workloads should live in a dedicated namespace.".into(),
            remediation: "Create a purpose-specific namespace and move the workload there.".into(),
        });
    };
    for d in deployments {
        if d.metadata.namespace.as_deref() == Some("default") {
            push("Deployment", d.metadata.name.clone().unwrap_or_default());
        }
    }
    for s in statefulsets {
        if s.metadata.namespace.as_deref() == Some("default") {
            push("StatefulSet", s.metadata.name.clone().unwrap_or_default());
        }
    }
    for d in daemonsets {
        if d.metadata.namespace.as_deref() == Some("default") {
            push("DaemonSet", d.metadata.name.clone().unwrap_or_default());
        }
    }
    out
}

pub async fn scan(client: &Client, context: String) -> AppResult<SecurityReport> {
    let scanned_at_ms = chrono::Utc::now().timestamp_millis();

    let c0 = client.clone();
    let c1 = client.clone();
    let c2 = client.clone();
    let c3 = client.clone();
    let c4 = client.clone();
    let c5 = client.clone();
    let c6 = client.clone();
    let c7 = client.clone();
    let c8 = client.clone();
    let c9 = client.clone();

    let (pods, deps, ss, ds, svcs, nps, crs, crbs, rls, _rbs) = tokio::join!(
        async move { Api::<Pod>::all(c0).list(&ListParams::default()).await },
        async move { Api::<Deployment>::all(c1).list(&ListParams::default()).await },
        async move { Api::<StatefulSet>::all(c2).list(&ListParams::default()).await },
        async move { Api::<DaemonSet>::all(c3).list(&ListParams::default()).await },
        async move { Api::<Service>::all(c4).list(&ListParams::default()).await },
        async move { Api::<NetworkPolicy>::all(c5).list(&ListParams::default()).await },
        async move { Api::<ClusterRole>::all(c6).list(&ListParams::default()).await },
        async move { Api::<ClusterRoleBinding>::all(c7).list(&ListParams::default()).await },
        async move { Api::<Role>::all(c8).list(&ListParams::default()).await },
        async move { Api::<RoleBinding>::all(c9).list(&ListParams::default()).await },
    );

    let pods = pods.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let deps = deps.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let ss = ss.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let ds = ds.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let svcs = svcs.map_err(|e| crate::error::AppError::K8s(e.to_string()))?;
    let nps_items = nps.ok().map(|l| l.items).unwrap_or_default();
    let crs_items = crs.ok().map(|l| l.items).unwrap_or_default();
    let crbs_items = crbs.ok().map(|l| l.items).unwrap_or_default();
    let rls_items = rls.ok().map(|l| l.items).unwrap_or_default();

    let mut findings: Vec<Finding> = Vec::new();
    let mut resources_scanned = 0i32;

    for d in &deps.items {
        resources_scanned += 1;
        if let Some(spec) = d
            .spec
            .as_ref()
            .and_then(|s| s.template.spec.as_ref())
        {
            findings.extend(pod_spec_findings(
                "Deployment",
                d.metadata.name.as_deref().unwrap_or(""),
                d.metadata.namespace.as_deref().unwrap_or(""),
                spec,
            ));
        }
    }
    for s in &ss.items {
        resources_scanned += 1;
        if let Some(spec) = s
            .spec
            .as_ref()
            .and_then(|sp| sp.template.spec.as_ref())
        {
            findings.extend(pod_spec_findings(
                "StatefulSet",
                s.metadata.name.as_deref().unwrap_or(""),
                s.metadata.namespace.as_deref().unwrap_or(""),
                spec,
            ));
        }
    }
    for d in &ds.items {
        resources_scanned += 1;
        if let Some(spec) = d
            .spec
            .as_ref()
            .and_then(|sp| sp.template.spec.as_ref())
        {
            findings.extend(pod_spec_findings(
                "DaemonSet",
                d.metadata.name.as_deref().unwrap_or(""),
                d.metadata.namespace.as_deref().unwrap_or(""),
                spec,
            ));
        }
    }
    // Standalone pods not owned by a workload.
    for p in &pods.items {
        let has_owner = p
            .metadata
            .owner_references
            .as_ref()
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        if !has_owner {
            resources_scanned += 1;
            if let Some(spec) = p.spec.as_ref() {
                findings.extend(pod_spec_findings(
                    "Pod",
                    p.metadata.name.as_deref().unwrap_or(""),
                    p.metadata.namespace.as_deref().unwrap_or(""),
                    spec,
                ));
            }
        }
    }

    findings.extend(rbac_findings(&crs_items, &crbs_items, &rls_items));
    findings.extend(service_exposure_findings(&svcs.items));
    findings.extend(default_namespace_findings(&deps.items, &ss.items, &ds.items));

    let mut workload_namespaces = std::collections::BTreeSet::<String>::new();
    for d in &deps.items {
        if let Some(n) = &d.metadata.namespace {
            workload_namespaces.insert(n.clone());
        }
    }
    for s in &ss.items {
        if let Some(n) = &s.metadata.namespace {
            workload_namespaces.insert(n.clone());
        }
    }
    for d in &ds.items {
        if let Some(n) = &d.metadata.namespace {
            workload_namespaces.insert(n.clone());
        }
    }
    findings.extend(namespace_coverage_findings(
        &nps_items,
        &workload_namespaces,
    ));

    // Sort by severity (critical first), then by kind/name for stable output.
    findings.sort_by_key(|f| match f.severity {
        Severity::Critical => 0,
        Severity::High => 1,
        Severity::Medium => 2,
        Severity::Low => 3,
        Severity::Info => 4,
    });

    let mut counts_by_severity: BTreeMap<String, i32> = BTreeMap::new();
    for f in &findings {
        *counts_by_severity.entry(sev_key(f.severity).into()).or_insert(0) += 1;
    }

    Ok(SecurityReport {
        context,
        findings,
        scanned_at_ms,
        counts_by_severity,
        resources_scanned,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::core::v1::{
        Container, HostPathVolumeSource, PodSpec, SecurityContext, Volume,
    };

    fn base_spec() -> PodSpec {
        PodSpec {
            containers: vec![Container {
                name: "app".into(),
                image: Some("nginx:1.25.0".into()),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn flags_privileged_and_hostpath() {
        let mut spec = base_spec();
        spec.host_network = Some(true);
        spec.volumes = Some(vec![Volume {
            name: "data".into(),
            host_path: Some(HostPathVolumeSource {
                path: "/var/data".into(),
                type_: None,
            }),
            ..Default::default()
        }]);
        spec.containers[0].security_context = Some(SecurityContext {
            privileged: Some(true),
            ..Default::default()
        });
        let f = pod_spec_findings("Deployment", "api", "prod", &spec);
        assert!(f.iter().any(|x| x.rule_id == "CTR-PRIVILEGED"));
        assert!(f.iter().any(|x| x.rule_id == "POD-HOSTNET"));
        assert!(f.iter().any(|x| x.rule_id == "POD-HOSTPATH"));
    }

    #[test]
    fn flags_latest_tag() {
        let mut spec = base_spec();
        spec.containers[0].image = Some("nginx:latest".into());
        let f = pod_spec_findings("Deployment", "api", "prod", &spec);
        assert!(f.iter().any(|x| x.rule_id == "CTR-LATEST"));
    }

    #[test]
    fn does_not_flag_pinned_digest() {
        let mut spec = base_spec();
        spec.containers[0].image =
            Some("ghcr.io/org/app@sha256:aaaaaaaaaaaaaaaaaaaa".into());
        let f = pod_spec_findings("Deployment", "api", "prod", &spec);
        assert!(!f.iter().any(|x| x.rule_id == "CTR-LATEST"));
    }
}
