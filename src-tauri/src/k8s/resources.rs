use crate::k8s::{
    registry::ResourceDefinition,
    time,
    types::{Health, WorkloadKind, WorkloadSummary},
};
use k8s_openapi::api::admissionregistration::v1::{
    MutatingWebhookConfiguration, ValidatingWebhookConfiguration,
};
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{
    ConfigMap, LimitRange, PersistentVolume, PersistentVolumeClaim, Pod, ResourceQuota, Secret,
    Service,
};
use k8s_openapi::api::networking::v1::{Ingress, IngressClass, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::api::scheduling::v1::PriorityClass;
use k8s_openapi::api::storage::v1::StorageClass;
use kube::api::DynamicObject;
use std::collections::BTreeMap;

#[cfg(test)]
mod generic_tests {
    use super::dynamic_summary;
    use crate::k8s::{registry, types::WorkloadKind};
    use kube::api::DynamicObject;
    use kube::core::{ApiResource, GroupVersionKind};

    #[test]
    fn dynamic_summary_preserves_metadata_for_registered_resources() {
        let definition = registry::get_resource_definition(&WorkloadKind::ClusterRole).unwrap();
        let gvk = GroupVersionKind::gvk(definition.api_group, definition.version, "ClusterRole");
        let ar = ApiResource::from_gvk_with_plural(&gvk, definition.plural);
        let mut obj = DynamicObject::new("view", &ar);
        obj.metadata.labels = Some(
            [("app.kubernetes.io/name".to_string(), "rbac".to_string())]
                .into_iter()
                .collect(),
        );

        let summary = dynamic_summary(&obj, definition);

        assert_eq!(summary.kind, WorkloadKind::ClusterRole);
        assert_eq!(summary.name, "view");
        assert_eq!(summary.namespace, "");
        assert_eq!(summary.ready, "metadata");
        assert_eq!(summary.health, crate::k8s::types::Health::Unknown);
        assert_eq!(summary.labels["app.kubernetes.io/name"], "rbac");
    }
}

pub fn age_seconds(meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta) -> i64 {
    time::age_seconds(meta.creation_timestamp.as_ref())
}

fn labels_of(
    meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta,
) -> BTreeMap<String, String> {
    meta.labels
        .clone()
        .map(|m| m.into_iter().collect::<BTreeMap<_, _>>())
        .unwrap_or_default()
}

pub fn dynamic_summary(obj: &DynamicObject, definition: &ResourceDefinition) -> WorkloadSummary {
    WorkloadSummary {
        kind: definition.kind.clone(),
        name: obj.metadata.name.clone().unwrap_or_default(),
        namespace: obj.metadata.namespace.clone().unwrap_or_default(),
        ready: "metadata".to_string(),
        age_seconds: age_seconds(&obj.metadata),
        health: Health::Unknown,
        labels: labels_of(&obj.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn redact_secret_yaml(yaml: &str) -> Result<String, serde_yaml::Error> {
    let mut value: serde_yaml::Value = serde_yaml::from_str(yaml)?;
    if let serde_yaml::Value::Mapping(root) = &mut value {
        for section in ["data", "stringData", "binaryData"] {
            let key = serde_yaml::Value::String(section.to_string());
            if let Some(serde_yaml::Value::Mapping(entries)) = root.get_mut(&key) {
                for value in entries.values_mut() {
                    *value = serde_yaml::Value::String("<redacted>".to_string());
                }
            }
        }
    }
    serde_yaml::to_string(&value)
}

pub fn deployment_summary(d: &Deployment) -> WorkloadSummary {
    let spec_replicas = d.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let ready_replicas = d
        .status
        .as_ref()
        .and_then(|s| s.ready_replicas)
        .unwrap_or(0);
    let health = match (spec_replicas, ready_replicas) {
        (0, _) => Health::Unknown,
        (s, r) if r == s => Health::Healthy,
        (_, 0) => Health::Failed,
        _ => Health::Degraded,
    };
    WorkloadSummary {
        kind: WorkloadKind::Deployment,
        name: d.metadata.name.clone().unwrap_or_default(),
        namespace: d.metadata.namespace.clone().unwrap_or_default(),
        ready: format!("{ready_replicas}/{spec_replicas}"),
        age_seconds: age_seconds(&d.metadata),
        health,
        labels: labels_of(&d.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn statefulset_summary(s: &StatefulSet) -> WorkloadSummary {
    let spec_replicas = s.spec.as_ref().and_then(|sp| sp.replicas).unwrap_or(0);
    let ready_replicas = s
        .status
        .as_ref()
        .and_then(|st| st.ready_replicas)
        .unwrap_or(0);
    let health = match (spec_replicas, ready_replicas) {
        (0, _) => Health::Unknown,
        (sp, r) if r == sp => Health::Healthy,
        (_, 0) => Health::Failed,
        _ => Health::Degraded,
    };
    WorkloadSummary {
        kind: WorkloadKind::StatefulSet,
        name: s.metadata.name.clone().unwrap_or_default(),
        namespace: s.metadata.namespace.clone().unwrap_or_default(),
        ready: format!("{ready_replicas}/{spec_replicas}"),
        age_seconds: age_seconds(&s.metadata),
        health,
        labels: labels_of(&s.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn daemonset_summary(d: &DaemonSet) -> WorkloadSummary {
    let (desired, ready) = d
        .status
        .as_ref()
        .map(|s| (s.desired_number_scheduled, s.number_ready))
        .unwrap_or((0, 0));
    let health = match (desired, ready) {
        (0, _) => Health::Unknown,
        (d, r) if r == d => Health::Healthy,
        (_, 0) => Health::Failed,
        _ => Health::Degraded,
    };
    WorkloadSummary {
        kind: WorkloadKind::DaemonSet,
        name: d.metadata.name.clone().unwrap_or_default(),
        namespace: d.metadata.namespace.clone().unwrap_or_default(),
        ready: format!("{ready}/{desired}"),
        age_seconds: age_seconds(&d.metadata),
        health,
        labels: labels_of(&d.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn cronjob_summary(c: &CronJob) -> WorkloadSummary {
    WorkloadSummary {
        kind: WorkloadKind::CronJob,
        name: c.metadata.name.clone().unwrap_or_default(),
        namespace: c.metadata.namespace.clone().unwrap_or_default(),
        ready: "-".into(),
        age_seconds: age_seconds(&c.metadata),
        health: Health::Unknown,
        labels: labels_of(&c.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn job_summary(j: &Job) -> WorkloadSummary {
    let (succeeded, failed) = j
        .status
        .as_ref()
        .map(|s| (s.succeeded.unwrap_or(0), s.failed.unwrap_or(0)))
        .unwrap_or((0, 0));
    let health = if succeeded >= 1 {
        Health::Healthy
    } else if failed > 0 {
        Health::Failed
    } else {
        Health::Unknown
    };
    WorkloadSummary {
        kind: WorkloadKind::Job,
        name: j.metadata.name.clone().unwrap_or_default(),
        namespace: j.metadata.namespace.clone().unwrap_or_default(),
        ready: format!("{succeeded}/{}", succeeded + failed),
        age_seconds: age_seconds(&j.metadata),
        health,
        labels: labels_of(&j.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn pod_summary(p: &Pod) -> WorkloadSummary {
    let phase = p
        .status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_default();
    let (ready_containers, total_containers) = p
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
        .map(|cs| {
            (
                cs.iter().filter(|c| c.ready).count() as i32,
                cs.len() as i32,
            )
        })
        .unwrap_or((0, 0));
    let health = match phase.as_str() {
        "Running" if total_containers > 0 && ready_containers == total_containers => {
            Health::Healthy
        }
        "Succeeded" => Health::Healthy,
        "Pending" => Health::Unknown,
        "Failed" => Health::Failed,
        _ => Health::Degraded,
    };
    // Sum container restart counts.
    let restart_count: i32 = p
        .status
        .as_ref()
        .and_then(|s| s.container_statuses.as_ref())
        .map(|cs| cs.iter().map(|c| c.restart_count).sum())
        .unwrap_or(0);
    // Spec.containers.len() is the authoritative container count (status may
    // be missing for Pending pods).
    let container_count = p
        .spec
        .as_ref()
        .map(|s| s.containers.len() as i32)
        .unwrap_or(total_containers);
    let node_name = p.spec.as_ref().and_then(|s| s.node_name.clone());
    let controlled_by = p
        .metadata
        .owner_references
        .as_ref()
        .and_then(|v| v.first())
        .map(|o| crate::k8s::types::OwnerRefLite {
            kind: o.kind.clone(),
            name: o.name.clone(),
        });
    let qos_class = p.status.as_ref().and_then(|s| s.qos_class.clone());
    let pod_phase = if phase.is_empty() {
        None
    } else {
        Some(phase.clone())
    };
    WorkloadSummary {
        kind: WorkloadKind::Pod,
        name: p.metadata.name.clone().unwrap_or_default(),
        namespace: p.metadata.namespace.clone().unwrap_or_default(),
        ready: format!("{ready_containers}/{total_containers}"),
        age_seconds: age_seconds(&p.metadata),
        health,
        labels: labels_of(&p.metadata),
        restart_count: Some(restart_count),
        container_count: Some(container_count),
        container_ready_count: Some(ready_containers),
        node_name,
        controlled_by,
        qos_class,
        // Filled in by the caller from metrics-server (cached).
        cpu_milli: None,
        mem_bytes: None,
        pod_phase,
    }
}

pub fn service_summary(s: &Service) -> WorkloadSummary {
    WorkloadSummary {
        kind: WorkloadKind::Service,
        name: s.metadata.name.clone().unwrap_or_default(),
        namespace: s.metadata.namespace.clone().unwrap_or_default(),
        ready: "-".into(),
        age_seconds: age_seconds(&s.metadata),
        health: Health::Unknown,
        labels: labels_of(&s.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn ingress_summary(i: &Ingress) -> WorkloadSummary {
    WorkloadSummary {
        kind: WorkloadKind::Ingress,
        name: i.metadata.name.clone().unwrap_or_default(),
        namespace: i.metadata.namespace.clone().unwrap_or_default(),
        ready: "-".into(),
        age_seconds: age_seconds(&i.metadata),
        health: Health::Unknown,
        labels: labels_of(&i.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn configmap_summary(c: &ConfigMap) -> WorkloadSummary {
    WorkloadSummary {
        kind: WorkloadKind::ConfigMap,
        name: c.metadata.name.clone().unwrap_or_default(),
        namespace: c.metadata.namespace.clone().unwrap_or_default(),
        ready: "-".into(),
        age_seconds: age_seconds(&c.metadata),
        health: Health::Unknown,
        labels: labels_of(&c.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn secret_summary(s: &Secret) -> WorkloadSummary {
    // Use the type field as the "ready" cell so users can spot dockercfg /
    // tls / opaque at a glance without opening the YAML.
    let kind_label = s.type_.clone().unwrap_or_else(|| "Opaque".to_string());
    WorkloadSummary {
        kind: WorkloadKind::Secret,
        name: s.metadata.name.clone().unwrap_or_default(),
        namespace: s.metadata.namespace.clone().unwrap_or_default(),
        ready: kind_label,
        age_seconds: age_seconds(&s.metadata),
        health: Health::Unknown,
        labels: labels_of(&s.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn networkpolicy_summary(n: &NetworkPolicy) -> WorkloadSummary {
    WorkloadSummary {
        kind: WorkloadKind::NetworkPolicy,
        name: n.metadata.name.clone().unwrap_or_default(),
        namespace: n.metadata.namespace.clone().unwrap_or_default(),
        ready: "-".into(),
        age_seconds: age_seconds(&n.metadata),
        health: Health::Unknown,
        labels: labels_of(&n.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn pv_summary(p: &PersistentVolume) -> WorkloadSummary {
    let phase = p
        .status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_default();
    let health = match phase.as_str() {
        "Bound" | "Available" => Health::Healthy,
        "Released" => Health::Unknown,
        "Failed" => Health::Failed,
        _ => Health::Unknown,
    };
    WorkloadSummary {
        kind: WorkloadKind::PersistentVolume,
        name: p.metadata.name.clone().unwrap_or_default(),
        namespace: String::new(),
        ready: if phase.is_empty() { "-".into() } else { phase },
        age_seconds: age_seconds(&p.metadata),
        health,
        labels: labels_of(&p.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn storage_class_summary(s: &StorageClass) -> WorkloadSummary {
    // Surface the provisioner in the Ready column — the most diagnostic
    // single field for a StorageClass at a glance (kubernetes.io/aws-ebs,
    // disk.csi.azure.com, etc.).
    let provisioner = s.provisioner.clone();
    WorkloadSummary {
        kind: WorkloadKind::StorageClass,
        name: s.metadata.name.clone().unwrap_or_default(),
        namespace: String::new(),
        ready: provisioner,
        age_seconds: age_seconds(&s.metadata),
        health: Health::Unknown,
        labels: labels_of(&s.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn ingress_class_summary(i: &IngressClass) -> WorkloadSummary {
    let controller = i
        .spec
        .as_ref()
        .and_then(|s| s.controller.clone())
        .unwrap_or_default();
    WorkloadSummary {
        kind: WorkloadKind::IngressClass,
        name: i.metadata.name.clone().unwrap_or_default(),
        namespace: String::new(),
        ready: controller,
        age_seconds: age_seconds(&i.metadata),
        health: Health::Unknown,
        labels: labels_of(&i.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn resource_quota_summary(r: &ResourceQuota) -> WorkloadSummary {
    // Show how many tracked resources have hard limits set — quick signal
    // for "is this quota actively enforcing anything."
    let hard_count = r
        .spec
        .as_ref()
        .and_then(|s| s.hard.as_ref())
        .map(|m| m.len() as i32)
        .unwrap_or(0);
    WorkloadSummary {
        kind: WorkloadKind::ResourceQuota,
        name: r.metadata.name.clone().unwrap_or_default(),
        namespace: r.metadata.namespace.clone().unwrap_or_default(),
        ready: format!("{hard_count} limits"),
        age_seconds: age_seconds(&r.metadata),
        health: Health::Unknown,
        labels: labels_of(&r.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn hpa_summary(h: &HorizontalPodAutoscaler) -> WorkloadSummary {
    // ready column: "{current}/{min}-{max}" — at-a-glance autoscaler state.
    let min = h.spec.as_ref().and_then(|s| s.min_replicas).unwrap_or(0);
    let max = h.spec.as_ref().map(|s| s.max_replicas).unwrap_or(0);
    let current = h
        .status
        .as_ref()
        .and_then(|s| s.current_replicas)
        .unwrap_or(0);
    let desired = h.status.as_ref().map(|s| s.desired_replicas).unwrap_or(0);
    let health = if desired > max {
        Health::Degraded
    } else if current == desired {
        Health::Healthy
    } else {
        Health::Unknown
    };
    WorkloadSummary {
        kind: WorkloadKind::HorizontalPodAutoscaler,
        name: h.metadata.name.clone().unwrap_or_default(),
        namespace: h.metadata.namespace.clone().unwrap_or_default(),
        ready: format!("{current}/{min}-{max}"),
        age_seconds: age_seconds(&h.metadata),
        health,
        labels: labels_of(&h.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn pvc_summary(p: &PersistentVolumeClaim) -> WorkloadSummary {
    // Surface phase (Bound / Pending / Lost) in the ready column and map to
    // health so list views light up red on Lost.
    let phase = p
        .status
        .as_ref()
        .and_then(|s| s.phase.clone())
        .unwrap_or_default();
    let health = match phase.as_str() {
        "Bound" => Health::Healthy,
        "Pending" => Health::Unknown,
        "Lost" => Health::Failed,
        _ => Health::Unknown,
    };
    WorkloadSummary {
        kind: WorkloadKind::PersistentVolumeClaim,
        name: p.metadata.name.clone().unwrap_or_default(),
        namespace: p.metadata.namespace.clone().unwrap_or_default(),
        ready: if phase.is_empty() { "-".into() } else { phase },
        age_seconds: age_seconds(&p.metadata),
        health,
        labels: labels_of(&p.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

// ─── PR D+1: long-tail kinds ─────────────────────────────────────────────

pub fn limit_range_summary(l: &LimitRange) -> WorkloadSummary {
    // Surface the count of distinct limit types (Container/Pod/PVC) in the
    // Ready column — quick "is this enforcing anything" signal.
    let limit_count = l.spec.as_ref().map(|s| s.limits.len() as i32).unwrap_or(0);
    WorkloadSummary {
        kind: WorkloadKind::LimitRange,
        name: l.metadata.name.clone().unwrap_or_default(),
        namespace: l.metadata.namespace.clone().unwrap_or_default(),
        ready: format!("{limit_count} limits"),
        age_seconds: age_seconds(&l.metadata),
        health: Health::Unknown,
        labels: labels_of(&l.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn pdb_summary(p: &PodDisruptionBudget) -> WorkloadSummary {
    // PDB readiness = "{currentHealthy}/{desiredHealthy}". Health flips
    // Failed when below the disruption threshold.
    let current = p.status.as_ref().map(|s| s.current_healthy).unwrap_or(0);
    let desired = p.status.as_ref().map(|s| s.desired_healthy).unwrap_or(0);
    let health = if desired == 0 {
        Health::Unknown
    } else if current >= desired {
        Health::Healthy
    } else {
        Health::Failed
    };
    WorkloadSummary {
        kind: WorkloadKind::PodDisruptionBudget,
        name: p.metadata.name.clone().unwrap_or_default(),
        namespace: p.metadata.namespace.clone().unwrap_or_default(),
        ready: format!("{current}/{desired}"),
        age_seconds: age_seconds(&p.metadata),
        health,
        labels: labels_of(&p.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn priority_class_summary(p: &PriorityClass) -> WorkloadSummary {
    // Surface the integer priority value — diagnostic-relevant for
    // scheduling decisions.
    let value = p.value;
    WorkloadSummary {
        kind: WorkloadKind::PriorityClass,
        name: p.metadata.name.clone().unwrap_or_default(),
        namespace: String::new(),
        ready: format!("priority {value}"),
        age_seconds: age_seconds(&p.metadata),
        health: Health::Unknown,
        labels: labels_of(&p.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn mutating_webhook_summary(m: &MutatingWebhookConfiguration) -> WorkloadSummary {
    let count = m.webhooks.as_ref().map(|v| v.len() as i32).unwrap_or(0);
    WorkloadSummary {
        kind: WorkloadKind::MutatingWebhookConfiguration,
        name: m.metadata.name.clone().unwrap_or_default(),
        namespace: String::new(),
        ready: format!("{count} hooks"),
        age_seconds: age_seconds(&m.metadata),
        health: Health::Unknown,
        labels: labels_of(&m.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

pub fn validating_webhook_summary(v: &ValidatingWebhookConfiguration) -> WorkloadSummary {
    let count = v.webhooks.as_ref().map(|w| w.len() as i32).unwrap_or(0);
    WorkloadSummary {
        kind: WorkloadKind::ValidatingWebhookConfiguration,
        name: v.metadata.name.clone().unwrap_or_default(),
        namespace: String::new(),
        ready: format!("{count} hooks"),
        age_seconds: age_seconds(&v.metadata),
        health: Health::Unknown,
        labels: labels_of(&v.metadata),
        restart_count: None,
        container_count: None,
        container_ready_count: None,
        node_name: None,
        controlled_by: None,
        qos_class: None,
        cpu_milli: None,
        mem_bytes: None,
        pod_phase: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::apps::v1::{
        DaemonSetSpec, DaemonSetStatus, DeploymentSpec, DeploymentStatus, StatefulSetSpec,
        StatefulSetStatus,
    };
    use k8s_openapi::api::batch::v1::{CronJobSpec, JobSpec, JobStatus};
    use k8s_openapi::api::core::v1::{ContainerStatus, PodSpec, PodStatus, ServiceSpec};
    use k8s_openapi::api::networking::v1::IngressSpec;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;

    fn meta(name: &str) -> ObjectMeta {
        ObjectMeta {
            name: Some(name.into()),
            namespace: Some("prod".into()),
            ..Default::default()
        }
    }

    fn d(spec: i32, ready: i32) -> Deployment {
        Deployment {
            metadata: meta("api"),
            spec: Some(DeploymentSpec {
                replicas: Some(spec),
                ..Default::default()
            }),
            status: Some(DeploymentStatus {
                ready_replicas: Some(ready),
                ..Default::default()
            }),
        }
    }

    #[test]
    fn healthy_when_all_ready() {
        let s = deployment_summary(&d(3, 3));
        assert_eq!(s.ready, "3/3");
        assert!(matches!(s.health, Health::Healthy));
    }

    #[test]
    fn degraded_when_partially_ready() {
        let s = deployment_summary(&d(3, 2));
        assert!(matches!(s.health, Health::Degraded));
    }

    #[test]
    fn failed_when_zero_ready() {
        let s = deployment_summary(&d(3, 0));
        assert!(matches!(s.health, Health::Failed));
    }

    #[test]
    fn statefulset_basic() {
        let ss = StatefulSet {
            metadata: meta("db"),
            spec: Some(StatefulSetSpec {
                replicas: Some(3),
                ..Default::default()
            }),
            status: Some(StatefulSetStatus {
                ready_replicas: Some(3),
                replicas: 3,
                ..Default::default()
            }),
        };
        let s = statefulset_summary(&ss);
        assert_eq!(s.name, "db");
        assert_eq!(s.namespace, "prod");
        assert!(matches!(s.health, Health::Healthy));
    }

    #[test]
    fn daemonset_basic() {
        let ds = DaemonSet {
            metadata: meta("node-agent"),
            spec: Some(DaemonSetSpec::default()),
            status: Some(DaemonSetStatus {
                desired_number_scheduled: 4,
                number_ready: 4,
                ..Default::default()
            }),
        };
        let s = daemonset_summary(&ds);
        assert_eq!(s.name, "node-agent");
        assert_eq!(s.namespace, "prod");
        assert!(matches!(s.health, Health::Healthy));
    }

    #[test]
    fn cronjob_basic() {
        let cj = CronJob {
            metadata: meta("nightly"),
            spec: Some(CronJobSpec {
                schedule: "0 0 * * *".into(),
                ..Default::default()
            }),
            status: None,
        };
        let s = cronjob_summary(&cj);
        assert_eq!(s.name, "nightly");
        assert_eq!(s.namespace, "prod");
        assert!(matches!(s.health, Health::Unknown));
    }

    #[test]
    fn job_basic_success() {
        let j = Job {
            metadata: meta("migrate"),
            spec: Some(JobSpec::default()),
            status: Some(JobStatus {
                succeeded: Some(1),
                ..Default::default()
            }),
        };
        let s = job_summary(&j);
        assert_eq!(s.name, "migrate");
        assert_eq!(s.namespace, "prod");
        assert!(matches!(s.health, Health::Healthy));
    }

    #[test]
    fn pod_basic_running() {
        let p = Pod {
            metadata: meta("api-0"),
            spec: Some(PodSpec::default()),
            status: Some(PodStatus {
                phase: Some("Running".into()),
                container_statuses: Some(vec![ContainerStatus {
                    name: "c".into(),
                    ready: true,
                    restart_count: 0,
                    image: "x".into(),
                    image_id: "".into(),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
        };
        let s = pod_summary(&p);
        assert_eq!(s.name, "api-0");
        assert_eq!(s.namespace, "prod");
        assert!(matches!(s.health, Health::Healthy));
    }

    #[test]
    fn service_basic() {
        let sv = Service {
            metadata: meta("api-svc"),
            spec: Some(ServiceSpec::default()),
            status: None,
        };
        let s = service_summary(&sv);
        assert_eq!(s.name, "api-svc");
        assert_eq!(s.namespace, "prod");
    }

    #[test]
    fn ingress_basic() {
        let ig = Ingress {
            metadata: meta("api-ing"),
            spec: Some(IngressSpec::default()),
            status: None,
        };
        let s = ingress_summary(&ig);
        assert_eq!(s.name, "api-ing");
        assert_eq!(s.namespace, "prod");
    }

    #[test]
    fn configmap_basic() {
        let cm = ConfigMap {
            metadata: meta("env"),
            ..Default::default()
        };
        let s = configmap_summary(&cm);
        assert_eq!(s.name, "env");
        assert_eq!(s.namespace, "prod");
    }

    #[test]
    fn redacts_secret_yaml_data_without_dropping_keys() {
        let yaml = r#"
apiVersion: v1
kind: Secret
metadata:
  name: db-creds
data:
  username: YWRtaW4=
  password: c2VjcmV0
stringData:
  token: cleartext
binaryData:
  cert: AQID
"#;

        let redacted = redact_secret_yaml(yaml).unwrap();

        assert!(redacted.contains("username: <redacted>"));
        assert!(redacted.contains("password: <redacted>"));
        assert!(redacted.contains("token: <redacted>"));
        assert!(redacted.contains("cert: <redacted>"));
        assert!(!redacted.contains("YWRtaW4="));
        assert!(!redacted.contains("cleartext"));
        assert!(!redacted.contains("AQID"));
    }
}
