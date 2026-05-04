use crate::k8s::types::WorkloadKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceCategory {
    Workloads,
    Network,
    Config,
    Storage,
    Rbac,
    Policy,
    Cluster,
    Extend,
}

#[derive(Debug, Clone)]
pub struct ResourceDefinition {
    pub kind: WorkloadKind,
    pub label: &'static str,
    pub singular_label: &'static str,
    pub slug: &'static str,
    pub api_group: &'static str,
    pub version: &'static str,
    pub plural: &'static str,
    pub namespaced: bool,
    pub category: ResourceCategory,
    pub optional: bool,
    pub supports_logs: bool,
    pub supports_shell: bool,
    pub supports_scale: bool,
    pub supports_restart: bool,
    pub supports_trigger: bool,
}

macro_rules! resource {
    (
        $kind:expr, $label:expr, $singular_label:expr, $slug:expr, $api_group:expr,
        $version:expr, $plural:expr, $namespaced:expr, $category:expr
        $(, optional: $optional:expr)?
        $(, logs: $logs:expr)?
        $(, shell: $shell:expr)?
        $(, scale: $scale:expr)?
        $(, restart: $restart:expr)?
        $(, trigger: $trigger:expr)?
    ) => {
        ResourceDefinition {
            kind: $kind,
            label: $label,
            singular_label: $singular_label,
            slug: $slug,
            api_group: $api_group,
            version: $version,
            plural: $plural,
            namespaced: $namespaced,
            category: $category,
            optional: false $(|| $optional)?,
            supports_logs: false $(|| $logs)?,
            supports_shell: false $(|| $shell)?,
            supports_scale: false $(|| $scale)?,
            supports_restart: false $(|| $restart)?,
            supports_trigger: false $(|| $trigger)?,
        }
    };
}

pub static ALL_RESOURCE_DEFINITIONS: &[ResourceDefinition] = &[
    resource!(WorkloadKind::Pod, "Pods", "Pod", "pods", "", "v1", "pods", true, ResourceCategory::Workloads, logs: true, shell: true),
    resource!(WorkloadKind::Deployment, "Deployments", "Deployment", "deployments", "apps", "v1", "deployments", true, ResourceCategory::Workloads, scale: true, restart: true),
    resource!(WorkloadKind::StatefulSet, "StatefulSets", "StatefulSet", "statefulsets", "apps", "v1", "statefulsets", true, ResourceCategory::Workloads, logs: true, scale: true, restart: true),
    resource!(WorkloadKind::DaemonSet, "DaemonSets", "DaemonSet", "daemonsets", "apps", "v1", "daemonsets", true, ResourceCategory::Workloads, logs: true, restart: true),
    resource!(WorkloadKind::ReplicaSet, "ReplicaSets", "ReplicaSet", "replicasets", "apps", "v1", "replicasets", true, ResourceCategory::Workloads, logs: true, scale: true),
    resource!(WorkloadKind::ReplicationController, "ReplicationControllers", "ReplicationController", "replicationcontrollers", "", "v1", "replicationcontrollers", true, ResourceCategory::Workloads, logs: true, scale: true),
    resource!(WorkloadKind::Job, "Jobs", "Job", "jobs", "batch", "v1", "jobs", true, ResourceCategory::Workloads, logs: true),
    resource!(WorkloadKind::CronJob, "CronJobs", "CronJob", "cronjobs", "batch", "v1", "cronjobs", true, ResourceCategory::Workloads, trigger: true),
    resource!(
        WorkloadKind::Service,
        "Services",
        "Service",
        "services",
        "",
        "v1",
        "services",
        true,
        ResourceCategory::Network
    ),
    resource!(
        WorkloadKind::Ingress,
        "Ingresses",
        "Ingress",
        "ingresses",
        "networking.k8s.io",
        "v1",
        "ingresses",
        true,
        ResourceCategory::Network
    ),
    resource!(
        WorkloadKind::IngressClass,
        "Ingress Classes",
        "Ingress Class",
        "ingressclasses",
        "networking.k8s.io",
        "v1",
        "ingressclasses",
        false,
        ResourceCategory::Network
    ),
    resource!(
        WorkloadKind::Endpoint,
        "Endpoints",
        "Endpoints",
        "endpoints",
        "",
        "v1",
        "endpoints",
        true,
        ResourceCategory::Network
    ),
    resource!(
        WorkloadKind::EndpointSlice,
        "EndpointSlices",
        "EndpointSlice",
        "endpointslices",
        "discovery.k8s.io",
        "v1",
        "endpointslices",
        true,
        ResourceCategory::Network
    ),
    resource!(
        WorkloadKind::ConfigMap,
        "ConfigMaps",
        "ConfigMap",
        "configmaps",
        "",
        "v1",
        "configmaps",
        true,
        ResourceCategory::Config
    ),
    resource!(
        WorkloadKind::Secret,
        "Secrets",
        "Secret",
        "secrets",
        "",
        "v1",
        "secrets",
        true,
        ResourceCategory::Config
    ),
    resource!(
        WorkloadKind::ServiceAccount,
        "ServiceAccounts",
        "ServiceAccount",
        "serviceaccounts",
        "",
        "v1",
        "serviceaccounts",
        true,
        ResourceCategory::Rbac
    ),
    resource!(
        WorkloadKind::Role,
        "Roles",
        "Role",
        "roles",
        "rbac.authorization.k8s.io",
        "v1",
        "roles",
        true,
        ResourceCategory::Rbac
    ),
    resource!(
        WorkloadKind::RoleBinding,
        "RoleBindings",
        "RoleBinding",
        "rolebindings",
        "rbac.authorization.k8s.io",
        "v1",
        "rolebindings",
        true,
        ResourceCategory::Rbac
    ),
    resource!(
        WorkloadKind::ClusterRole,
        "ClusterRoles",
        "ClusterRole",
        "clusterroles",
        "rbac.authorization.k8s.io",
        "v1",
        "clusterroles",
        false,
        ResourceCategory::Rbac
    ),
    resource!(
        WorkloadKind::ClusterRoleBinding,
        "ClusterRoleBindings",
        "ClusterRoleBinding",
        "clusterrolebindings",
        "rbac.authorization.k8s.io",
        "v1",
        "clusterrolebindings",
        false,
        ResourceCategory::Rbac
    ),
    resource!(
        WorkloadKind::NetworkPolicy,
        "Network Policies",
        "Network Policy",
        "networkpolicies",
        "networking.k8s.io",
        "v1",
        "networkpolicies",
        true,
        ResourceCategory::Policy
    ),
    resource!(
        WorkloadKind::PersistentVolumeClaim,
        "PVCs",
        "PVC",
        "pvcs",
        "",
        "v1",
        "persistentvolumeclaims",
        true,
        ResourceCategory::Storage
    ),
    resource!(
        WorkloadKind::PersistentVolume,
        "Persistent Volumes",
        "Persistent Volume",
        "pvs",
        "",
        "v1",
        "persistentvolumes",
        false,
        ResourceCategory::Storage
    ),
    resource!(
        WorkloadKind::StorageClass,
        "Storage Classes",
        "Storage Class",
        "storageclasses",
        "storage.k8s.io",
        "v1",
        "storageclasses",
        false,
        ResourceCategory::Storage
    ),
    resource!(WorkloadKind::VolumeAttributesClass, "VolumeAttributesClasses", "VolumeAttributesClass", "volumeattributesclasses", "storage.k8s.io", "v1", "volumeattributesclasses", false, ResourceCategory::Storage, optional: true),
    resource!(
        WorkloadKind::ResourceQuota,
        "Resource Quotas",
        "Resource Quota",
        "resourcequotas",
        "",
        "v1",
        "resourcequotas",
        true,
        ResourceCategory::Policy
    ),
    resource!(
        WorkloadKind::HorizontalPodAutoscaler,
        "HPAs",
        "HPA",
        "hpas",
        "autoscaling",
        "v2",
        "horizontalpodautoscalers",
        true,
        ResourceCategory::Policy
    ),
    resource!(WorkloadKind::VerticalPodAutoscaler, "VPAs", "VPA", "vpas", "autoscaling.k8s.io", "v1", "verticalpodautoscalers", true, ResourceCategory::Policy, optional: true),
    resource!(
        WorkloadKind::LimitRange,
        "Limit Ranges",
        "Limit Range",
        "limitranges",
        "",
        "v1",
        "limitranges",
        true,
        ResourceCategory::Policy
    ),
    resource!(
        WorkloadKind::PodDisruptionBudget,
        "PDBs",
        "PDB",
        "pdbs",
        "policy",
        "v1",
        "poddisruptionbudgets",
        true,
        ResourceCategory::Policy
    ),
    resource!(
        WorkloadKind::PriorityClass,
        "Priority Classes",
        "Priority Class",
        "priorityclasses",
        "scheduling.k8s.io",
        "v1",
        "priorityclasses",
        false,
        ResourceCategory::Policy
    ),
    resource!(
        WorkloadKind::RuntimeClass,
        "Runtime Classes",
        "Runtime Class",
        "runtimeclasses",
        "node.k8s.io",
        "v1",
        "runtimeclasses",
        false,
        ResourceCategory::Cluster
    ),
    resource!(
        WorkloadKind::Lease,
        "Leases",
        "Lease",
        "leases",
        "coordination.k8s.io",
        "v1",
        "leases",
        true,
        ResourceCategory::Cluster
    ),
    resource!(
        WorkloadKind::ControllerRevision,
        "ControllerRevisions",
        "ControllerRevision",
        "controllerrevisions",
        "apps",
        "v1",
        "controllerrevisions",
        true,
        ResourceCategory::Cluster
    ),
    resource!(
        WorkloadKind::MutatingWebhookConfiguration,
        "Mutating Webhooks",
        "Mutating Webhook",
        "mutatingwebhooks",
        "admissionregistration.k8s.io",
        "v1",
        "mutatingwebhookconfigurations",
        false,
        ResourceCategory::Cluster
    ),
    resource!(
        WorkloadKind::ValidatingWebhookConfiguration,
        "Validating Webhooks",
        "Validating Webhook",
        "validatingwebhooks",
        "admissionregistration.k8s.io",
        "v1",
        "validatingwebhookconfigurations",
        false,
        ResourceCategory::Cluster
    ),
    resource!(WorkloadKind::GatewayClass, "GatewayClasses", "GatewayClass", "gatewayclasses", "gateway.networking.k8s.io", "v1", "gatewayclasses", false, ResourceCategory::Network, optional: true),
    resource!(WorkloadKind::Gateway, "Gateways", "Gateway", "gateways", "gateway.networking.k8s.io", "v1", "gateways", true, ResourceCategory::Network, optional: true),
    resource!(WorkloadKind::HttpRoute, "HTTPRoutes", "HTTPRoute", "httproutes", "gateway.networking.k8s.io", "v1", "httproutes", true, ResourceCategory::Network, optional: true),
    resource!(WorkloadKind::GrpcRoute, "GRPCRoutes", "GRPCRoute", "grpcroutes", "gateway.networking.k8s.io", "v1", "grpcroutes", true, ResourceCategory::Network, optional: true),
    resource!(WorkloadKind::JobSet, "JobSets", "JobSet", "jobsets", "jobset.x-k8s.io", "v1alpha2", "jobsets", true, ResourceCategory::Workloads, optional: true),
    resource!(
        WorkloadKind::CustomResourceDefinition,
        "CRDs",
        "CRD",
        "crds",
        "apiextensions.k8s.io",
        "v1",
        "customresourcedefinitions",
        false,
        ResourceCategory::Extend
    ),
];

pub fn list_resource_definitions() -> &'static [ResourceDefinition] {
    ALL_RESOURCE_DEFINITIONS
}

pub fn get_resource_definition(kind: &WorkloadKind) -> Option<&'static ResourceDefinition> {
    ALL_RESOURCE_DEFINITIONS
        .iter()
        .find(|definition| &definition.kind == kind)
}

pub fn api_kind(kind: &WorkloadKind) -> &'static str {
    match kind {
        WorkloadKind::Deployment => "Deployment",
        WorkloadKind::StatefulSet => "StatefulSet",
        WorkloadKind::DaemonSet => "DaemonSet",
        WorkloadKind::ReplicaSet => "ReplicaSet",
        WorkloadKind::ReplicationController => "ReplicationController",
        WorkloadKind::CronJob => "CronJob",
        WorkloadKind::Job => "Job",
        WorkloadKind::Pod => "Pod",
        WorkloadKind::Service => "Service",
        WorkloadKind::Ingress => "Ingress",
        WorkloadKind::Endpoint => "Endpoints",
        WorkloadKind::EndpointSlice => "EndpointSlice",
        WorkloadKind::ConfigMap => "ConfigMap",
        WorkloadKind::Secret => "Secret",
        WorkloadKind::ServiceAccount => "ServiceAccount",
        WorkloadKind::Role => "Role",
        WorkloadKind::RoleBinding => "RoleBinding",
        WorkloadKind::ClusterRole => "ClusterRole",
        WorkloadKind::ClusterRoleBinding => "ClusterRoleBinding",
        WorkloadKind::NetworkPolicy => "NetworkPolicy",
        WorkloadKind::PersistentVolumeClaim => "PersistentVolumeClaim",
        WorkloadKind::PersistentVolume => "PersistentVolume",
        WorkloadKind::StorageClass => "StorageClass",
        WorkloadKind::VolumeAttributesClass => "VolumeAttributesClass",
        WorkloadKind::IngressClass => "IngressClass",
        WorkloadKind::ResourceQuota => "ResourceQuota",
        WorkloadKind::HorizontalPodAutoscaler => "HorizontalPodAutoscaler",
        WorkloadKind::VerticalPodAutoscaler => "VerticalPodAutoscaler",
        WorkloadKind::LimitRange => "LimitRange",
        WorkloadKind::PodDisruptionBudget => "PodDisruptionBudget",
        WorkloadKind::PriorityClass => "PriorityClass",
        WorkloadKind::RuntimeClass => "RuntimeClass",
        WorkloadKind::Lease => "Lease",
        WorkloadKind::ControllerRevision => "ControllerRevision",
        WorkloadKind::MutatingWebhookConfiguration => "MutatingWebhookConfiguration",
        WorkloadKind::ValidatingWebhookConfiguration => "ValidatingWebhookConfiguration",
        WorkloadKind::GatewayClass => "GatewayClass",
        WorkloadKind::Gateway => "Gateway",
        WorkloadKind::HttpRoute => "HTTPRoute",
        WorkloadKind::GrpcRoute => "GRPCRoute",
        WorkloadKind::JobSet => "JobSet",
        WorkloadKind::CustomResourceDefinition => "CustomResourceDefinition",
    }
}

#[cfg(test)]
mod tests {
    use super::{get_resource_definition, list_resource_definitions};
    use crate::k8s::types::WorkloadKind;

    #[test]
    fn contains_v1_desktop_parity_resource_kinds() {
        let kinds: Vec<WorkloadKind> = list_resource_definitions()
            .iter()
            .map(|definition| definition.kind.clone())
            .collect();

        assert_eq!(
            kinds,
            vec![
                WorkloadKind::Pod,
                WorkloadKind::Deployment,
                WorkloadKind::StatefulSet,
                WorkloadKind::DaemonSet,
                WorkloadKind::ReplicaSet,
                WorkloadKind::ReplicationController,
                WorkloadKind::Job,
                WorkloadKind::CronJob,
                WorkloadKind::Service,
                WorkloadKind::Ingress,
                WorkloadKind::IngressClass,
                WorkloadKind::Endpoint,
                WorkloadKind::EndpointSlice,
                WorkloadKind::ConfigMap,
                WorkloadKind::Secret,
                WorkloadKind::ServiceAccount,
                WorkloadKind::Role,
                WorkloadKind::RoleBinding,
                WorkloadKind::ClusterRole,
                WorkloadKind::ClusterRoleBinding,
                WorkloadKind::NetworkPolicy,
                WorkloadKind::PersistentVolumeClaim,
                WorkloadKind::PersistentVolume,
                WorkloadKind::StorageClass,
                WorkloadKind::VolumeAttributesClass,
                WorkloadKind::ResourceQuota,
                WorkloadKind::HorizontalPodAutoscaler,
                WorkloadKind::VerticalPodAutoscaler,
                WorkloadKind::LimitRange,
                WorkloadKind::PodDisruptionBudget,
                WorkloadKind::PriorityClass,
                WorkloadKind::RuntimeClass,
                WorkloadKind::Lease,
                WorkloadKind::ControllerRevision,
                WorkloadKind::MutatingWebhookConfiguration,
                WorkloadKind::ValidatingWebhookConfiguration,
                WorkloadKind::GatewayClass,
                WorkloadKind::Gateway,
                WorkloadKind::HttpRoute,
                WorkloadKind::GrpcRoute,
                WorkloadKind::JobSet,
                WorkloadKind::CustomResourceDefinition,
            ]
        );
    }

    #[test]
    fn describes_api_scope_for_representative_resources() {
        let pod = get_resource_definition(&WorkloadKind::Pod).unwrap();
        assert_eq!(pod.api_group, "");
        assert_eq!(pod.version, "v1");
        assert_eq!(pod.plural, "pods");
        assert!(pod.namespaced);
        assert!(pod.supports_logs);
        assert!(pod.supports_shell);

        let cluster_role = get_resource_definition(&WorkloadKind::ClusterRole).unwrap();
        assert_eq!(cluster_role.api_group, "rbac.authorization.k8s.io");
        assert_eq!(cluster_role.version, "v1");
        assert_eq!(cluster_role.plural, "clusterroles");
        assert!(!cluster_role.namespaced);

        let gateway = get_resource_definition(&WorkloadKind::Gateway).unwrap();
        assert_eq!(gateway.api_group, "gateway.networking.k8s.io");
        assert_eq!(gateway.version, "v1");
        assert_eq!(gateway.plural, "gateways");
        assert!(gateway.namespaced);
        assert!(gateway.optional);
    }

    #[test]
    fn maps_display_labels_separately_from_api_kinds() {
        assert_eq!(super::api_kind(&WorkloadKind::IngressClass), "IngressClass");
        assert_eq!(super::api_kind(&WorkloadKind::HttpRoute), "HTTPRoute");
        assert_eq!(super::api_kind(&WorkloadKind::Endpoint), "Endpoints");
    }
}
