use crate::k8s::types::{ResourceInsightRow, ResourceInsightSection, ResourceInsights};
use k8s_openapi::api::autoscaling::v2::HorizontalPodAutoscaler;
use k8s_openapi::api::core::v1::{LimitRange, ResourceQuota, Service};
use k8s_openapi::api::networking::v1::{Ingress, NetworkPolicy};
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use std::collections::BTreeMap;

fn row(label: impl Into<String>, value: impl Into<String>) -> ResourceInsightRow {
    ResourceInsightRow {
        label: label.into(),
        value: value.into(),
    }
}

fn section(title: impl Into<String>, rows: Vec<ResourceInsightRow>) -> ResourceInsightSection {
    ResourceInsightSection {
        title: title.into(),
        rows,
    }
}

fn labels(labels: &Option<BTreeMap<String, String>>) -> String {
    labels
        .as_ref()
        .filter(|labels| !labels.is_empty())
        .map(|labels| {
            labels
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "-".to_string())
}

fn quantity_map(
    map: &Option<BTreeMap<String, k8s_openapi::apimachinery::pkg::api::resource::Quantity>>,
) -> Vec<ResourceInsightRow> {
    map.as_ref()
        .map(|items| {
            items
                .iter()
                .map(|(key, value)| row(key, &value.0))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub fn service_insights(service: &Service) -> ResourceInsights {
    let spec = service.spec.as_ref();
    let ports = spec
        .and_then(|spec| spec.ports.as_ref())
        .map(|ports| {
            ports
                .iter()
                .map(|port| {
                    format!(
                        "{}:{}/{}",
                        port.name.as_deref().unwrap_or("-"),
                        port.port,
                        port.protocol.as_deref().unwrap_or("TCP")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "-".to_string());
    ResourceInsights {
        sections: vec![section(
            "service",
            vec![
                row(
                    "type",
                    spec.and_then(|spec| spec.type_.clone()).unwrap_or_default(),
                ),
                row(
                    "cluster ip",
                    spec.and_then(|spec| spec.cluster_ip.clone())
                        .unwrap_or_else(|| "-".to_string()),
                ),
                row(
                    "selector",
                    labels(&spec.and_then(|spec| spec.selector.clone())),
                ),
                row("ports", ports),
            ],
        )],
    }
}

pub fn ingress_insights(ingress: &Ingress) -> ResourceInsights {
    let spec = ingress.spec.as_ref();
    let rule_hosts = spec
        .and_then(|spec| spec.rules.as_ref())
        .map(|rules| {
            rules
                .iter()
                .map(|rule| rule.host.clone().unwrap_or_else(|| "*".to_string()))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "-".to_string());
    ResourceInsights {
        sections: vec![section(
            "ingress",
            vec![
                row(
                    "class",
                    spec.and_then(|spec| spec.ingress_class_name.clone())
                        .unwrap_or_else(|| "-".to_string()),
                ),
                row("hosts", rule_hosts),
                row(
                    "rules",
                    spec.and_then(|spec| spec.rules.as_ref())
                        .map(|rules| rules.len().to_string())
                        .unwrap_or_else(|| "0".to_string()),
                ),
                row(
                    "tls",
                    spec.and_then(|spec| spec.tls.as_ref())
                        .map(|tls| tls.len().to_string())
                        .unwrap_or_else(|| "0".to_string()),
                ),
            ],
        )],
    }
}

pub fn network_policy_insights(policy: &NetworkPolicy) -> ResourceInsights {
    let spec = policy.spec.as_ref();
    ResourceInsights {
        sections: vec![section(
            "network policy",
            vec![
                row(
                    "pod selector",
                    spec.and_then(|spec| spec.pod_selector.as_ref())
                        .map(|selector| labels(&selector.match_labels))
                        .unwrap_or_else(|| "-".to_string()),
                ),
                row(
                    "types",
                    spec.and_then(|spec| spec.policy_types.as_ref())
                        .map(|types| types.join(", "))
                        .unwrap_or_else(|| "-".to_string()),
                ),
                row(
                    "ingress rules",
                    spec.and_then(|spec| spec.ingress.as_ref())
                        .map(|rules| rules.len().to_string())
                        .unwrap_or_else(|| "0".to_string()),
                ),
                row(
                    "egress rules",
                    spec.and_then(|spec| spec.egress.as_ref())
                        .map(|rules| rules.len().to_string())
                        .unwrap_or_else(|| "0".to_string()),
                ),
            ],
        )],
    }
}

pub fn hpa_insights(hpa: &HorizontalPodAutoscaler) -> ResourceInsights {
    let spec = hpa.spec.as_ref();
    let status = hpa.status.as_ref();
    ResourceInsights {
        sections: vec![section(
            "autoscaling",
            vec![
                row(
                    "target",
                    spec.map(|spec| {
                        format!(
                            "{}/{}",
                            spec.scale_target_ref.kind, spec.scale_target_ref.name
                        )
                    })
                    .unwrap_or_else(|| "-".to_string()),
                ),
                row(
                    "replicas",
                    status
                        .map(|status| {
                            format!(
                                "{}/{}",
                                status
                                    .current_replicas
                                    .map(|value| value.to_string())
                                    .unwrap_or_else(|| "-".to_string()),
                                status.desired_replicas
                            )
                        })
                        .unwrap_or_else(|| "-".to_string()),
                ),
                row(
                    "min",
                    spec.and_then(|spec| spec.min_replicas)
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "-".to_string()),
                ),
                row(
                    "max",
                    spec.map(|spec| spec.max_replicas.to_string())
                        .unwrap_or_else(|| "-".to_string()),
                ),
                row(
                    "metrics",
                    spec.and_then(|spec| spec.metrics.as_ref())
                        .map(|metrics| metrics.len().to_string())
                        .unwrap_or_else(|| "0".to_string()),
                ),
            ],
        )],
    }
}

pub fn pdb_insights(pdb: &PodDisruptionBudget) -> ResourceInsights {
    let spec = pdb.spec.as_ref();
    let status = pdb.status.as_ref();
    ResourceInsights {
        sections: vec![section(
            "disruption budget",
            vec![
                row(
                    "healthy",
                    status
                        .map(|status| {
                            format!("{}/{}", status.current_healthy, status.desired_healthy)
                        })
                        .unwrap_or_else(|| "-".to_string()),
                ),
                row(
                    "allowed",
                    status
                        .map(|status| status.disruptions_allowed.to_string())
                        .unwrap_or_else(|| "-".to_string()),
                ),
                row(
                    "selector",
                    spec.and_then(|spec| spec.selector.as_ref())
                        .map(|selector| labels(&selector.match_labels))
                        .unwrap_or_else(|| "-".to_string()),
                ),
            ],
        )],
    }
}

pub fn quota_insights(quota: &ResourceQuota) -> ResourceInsights {
    let spec = quota.spec.as_ref();
    let status = quota.status.as_ref();
    ResourceInsights {
        sections: vec![
            section(
                "hard",
                quantity_map(&spec.and_then(|spec| spec.hard.clone())),
            ),
            section(
                "used",
                quantity_map(&status.and_then(|status| status.used.clone())),
            ),
        ],
    }
}

pub fn limit_range_insights(limit_range: &LimitRange) -> ResourceInsights {
    let rows = limit_range
        .spec
        .as_ref()
        .map(|spec| {
            spec.limits
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let limit_type = item.type_.clone();
                    row(format!("item {}", index + 1), limit_type)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    ResourceInsights {
        sections: vec![section("limit range", rows)],
    }
}

#[cfg(test)]
mod tests {
    use super::{hpa_insights, network_policy_insights, service_insights};
    use k8s_openapi::api::autoscaling::v2::{
        CrossVersionObjectReference, HorizontalPodAutoscaler, HorizontalPodAutoscalerSpec,
        HorizontalPodAutoscalerStatus,
    };
    use k8s_openapi::api::core::v1::{Service, ServicePort, ServiceSpec};
    use k8s_openapi::api::networking::v1::{NetworkPolicy, NetworkPolicySpec};
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::LabelSelector;
    use std::collections::BTreeMap;

    #[test]
    fn service_insights_include_type_selector_and_ports() {
        let service = Service {
            spec: Some(ServiceSpec {
                type_: Some("LoadBalancer".into()),
                cluster_ip: Some("10.0.0.1".into()),
                selector: Some(BTreeMap::from([("app".into(), "api".into())])),
                ports: Some(vec![ServicePort {
                    name: Some("http".into()),
                    port: 80,
                    protocol: Some("TCP".into()),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
            ..Default::default()
        };

        let insights = service_insights(&service);

        assert_eq!(insights.sections[0].rows[0].value, "LoadBalancer");
        assert_eq!(insights.sections[0].rows[2].value, "app=api");
        assert_eq!(insights.sections[0].rows[3].value, "http:80/TCP");
    }

    #[test]
    fn network_policy_insights_include_selector_and_rule_counts() {
        let policy = NetworkPolicy {
            spec: Some(NetworkPolicySpec {
                pod_selector: Some(LabelSelector {
                    match_labels: Some(BTreeMap::from([("app".into(), "api".into())])),
                    ..Default::default()
                }),
                policy_types: Some(vec!["Ingress".into(), "Egress".into()]),
                ingress: Some(vec![Default::default()]),
                egress: Some(vec![Default::default(), Default::default()]),
            }),
            ..Default::default()
        };

        let insights = network_policy_insights(&policy);

        assert_eq!(insights.sections[0].rows[0].value, "app=api");
        assert_eq!(insights.sections[0].rows[2].value, "1");
        assert_eq!(insights.sections[0].rows[3].value, "2");
    }

    #[test]
    fn hpa_insights_include_target_replicas_and_bounds() {
        let hpa = HorizontalPodAutoscaler {
            spec: Some(HorizontalPodAutoscalerSpec {
                scale_target_ref: CrossVersionObjectReference {
                    api_version: Some("apps/v1".into()),
                    kind: "Deployment".into(),
                    name: "api".into(),
                },
                min_replicas: Some(2),
                max_replicas: 10,
                metrics: Some(vec![]),
                behavior: None,
            }),
            status: Some(HorizontalPodAutoscalerStatus {
                current_replicas: Some(3),
                desired_replicas: 5,
                ..Default::default()
            }),
            ..Default::default()
        };

        let insights = hpa_insights(&hpa);

        assert_eq!(insights.sections[0].rows[0].value, "Deployment/api");
        assert_eq!(insights.sections[0].rows[1].value, "3/5");
        assert_eq!(insights.sections[0].rows[2].value, "2");
        assert_eq!(insights.sections[0].rows[3].value, "10");
    }
}
