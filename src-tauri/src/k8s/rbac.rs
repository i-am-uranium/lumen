use crate::error::{AppError, AppResult};
use crate::k8s::{registry, types::WorkloadKind};
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::{api::PostParams, Api, Client};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct AccessReviewRequest {
    pub kind: WorkloadKind,
    pub verb: String,
    pub namespace: Option<String>,
    pub name: Option<String>,
    pub subresource: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccessReviewResult {
    pub allowed: bool,
    pub denied: bool,
    pub reason: Option<String>,
    pub evaluation_error: Option<String>,
}

pub fn resource_attributes_for(
    kind: &WorkloadKind,
    verb: &str,
    namespace: Option<&str>,
    name: Option<&str>,
    subresource: Option<&str>,
) -> AppResult<ResourceAttributes> {
    let definition = registry::get_resource_definition(kind)
        .ok_or_else(|| AppError::Internal(format!("resource kind {kind:?} is not registered")))?;
    Ok(ResourceAttributes {
        group: Some(definition.api_group.to_string()),
        version: Some(definition.version.to_string()),
        resource: Some(definition.plural.to_string()),
        verb: Some(verb.to_string()),
        namespace: definition
            .namespaced
            .then(|| namespace.unwrap_or("").to_string()),
        name: name.map(ToString::to_string),
        subresource: subresource.map(ToString::to_string),
        ..Default::default()
    })
}

pub async fn check_access(
    client: &Client,
    request: AccessReviewRequest,
) -> AppResult<AccessReviewResult> {
    let attrs = resource_attributes_for(
        &request.kind,
        &request.verb,
        request.namespace.as_deref(),
        request.name.as_deref(),
        request.subresource.as_deref(),
    )?;
    let review = SelfSubjectAccessReview {
        metadata: ObjectMeta::default(),
        spec: SelfSubjectAccessReviewSpec {
            resource_attributes: Some(attrs),
            non_resource_attributes: None,
        },
        status: None,
    };
    let api: Api<SelfSubjectAccessReview> = Api::all(client.clone());
    let response = api
        .create(&PostParams::default(), &review)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let status = response.status.unwrap_or_default();
    Ok(AccessReviewResult {
        allowed: status.allowed,
        denied: status.denied.unwrap_or(false),
        reason: status.reason,
        evaluation_error: status.evaluation_error,
    })
}

#[cfg(test)]
mod tests {
    use super::resource_attributes_for;
    use crate::k8s::types::WorkloadKind;

    #[test]
    fn resource_attributes_use_registry_metadata_and_scope() {
        let attrs = resource_attributes_for(
            &WorkloadKind::ClusterRole,
            "delete",
            Some("ignored"),
            Some("view"),
            None,
        )
        .unwrap();

        assert_eq!(attrs.group.as_deref(), Some("rbac.authorization.k8s.io"));
        assert_eq!(attrs.version.as_deref(), Some("v1"));
        assert_eq!(attrs.resource.as_deref(), Some("clusterroles"));
        assert_eq!(attrs.verb.as_deref(), Some("delete"));
        assert_eq!(attrs.name.as_deref(), Some("view"));
        assert_eq!(attrs.namespace, None);
    }

    #[test]
    fn resource_attributes_keep_namespace_for_namespaced_resources() {
        let attrs = resource_attributes_for(
            &WorkloadKind::Deployment,
            "update",
            Some("apps"),
            None,
            None,
        )
        .unwrap();

        assert_eq!(attrs.group.as_deref(), Some("apps"));
        assert_eq!(attrs.resource.as_deref(), Some("deployments"));
        assert_eq!(attrs.namespace.as_deref(), Some("apps"));
    }
}
