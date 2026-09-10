//! Read-only, bounded discovery and inventory for Kubernetes device resources.

use std::{collections::HashSet, time::Duration};

use kube::{
    api::{DynamicObject, ListParams},
    core::{ApiResource, GroupVersionKind},
    Api, Client,
};
use serde::Serialize;
use serde_json::{json, Map, Value};

const API_VERSION: &str = "resource.k8s.io/v1";
const PAGE_SIZE: u32 = 500;
const MAX_PAGES: usize = 20;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const SOURCE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceSourceState {
    Available,
    Unsupported,
    Forbidden,
    Error,
}

#[derive(Debug, Serialize)]
pub struct DeviceSource {
    pub state: DeviceSourceState,
    pub items: Vec<Value>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DeviceResourcesSnapshot {
    pub namespace: String,
    /// Collection completion time, not an atomic cross-resource Kubernetes revision.
    pub captured_at: String,
    pub claims: DeviceSource,
    pub templates: DeviceSource,
    pub classes: DeviceSource,
    pub slices: DeviceSource,
    pub pods: DeviceSource,
}

#[derive(Clone, Copy)]
struct Resource {
    kind: &'static str,
    plural: &'static str,
    namespaced: bool,
    pod: bool,
}

const CLAIM: Resource = Resource {
    kind: "ResourceClaim",
    plural: "resourceclaims",
    namespaced: true,
    pod: false,
};
const TEMPLATE: Resource = Resource {
    kind: "ResourceClaimTemplate",
    plural: "resourceclaimtemplates",
    namespaced: true,
    pod: false,
};
const CLASS: Resource = Resource {
    kind: "DeviceClass",
    plural: "deviceclasses",
    namespaced: false,
    pod: false,
};
const SLICE: Resource = Resource {
    kind: "ResourceSlice",
    plural: "resourceslices",
    namespaced: false,
    pod: false,
};
const POD: Resource = Resource {
    kind: "Pod",
    plural: "pods",
    namespaced: true,
    pod: true,
};

impl DeviceSource {
    fn unavailable(state: DeviceSourceState, message: String) -> Self {
        Self {
            state,
            items: Vec::new(),
            message: Some(message),
        }
    }
}

/// Kubernetes namespace DNS labels prevent malformed or unintended API paths.
pub fn valid_namespace(namespace: &str) -> bool {
    namespace.is_empty()
        || (namespace.len() <= 63
            && namespace
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            && namespace.as_bytes()[0].is_ascii_alphanumeric()
            && namespace.as_bytes()[namespace.len() - 1].is_ascii_alphanumeric())
}

/// No context is resolved here: the command supplies the explicitly selected client.
pub async fn snapshot(client: &Client, namespace: &str) -> DeviceResourcesSnapshot {
    // A missing API group/version is unambiguous. Discovery denial/failure is not:
    // attempt resource lists and preserve their independent results in that case.
    let discovery = match tokio::time::timeout(
        DISCOVERY_TIMEOUT,
        client.list_api_group_resources(API_VERSION),
    )
    .await
    {
        Ok(Ok(list)) => Some(
            list.resources
                .into_iter()
                .map(|r| r.name)
                .collect::<HashSet<_>>(),
        ),
        Ok(Err(kube::Error::Api(error))) if error.code == 404 => Some(HashSet::new()),
        _ => None,
    };
    let fetch = |resource: Resource| {
        let discovery = &discovery;
        async move {
            if !resource.pod
                && discovery
                    .as_ref()
                    .is_some_and(|names| !names.contains(resource.plural))
            {
                return DeviceSource::unavailable(
                    DeviceSourceState::Unsupported,
                    format!(
                        "{} is not served by {API_VERSION} on this cluster.",
                        resource.kind
                    ),
                );
            }
            list_source(client, namespace, resource, MAX_PAGES, SOURCE_TIMEOUT).await
        }
    };
    let (claims, templates, classes, slices, pods) = tokio::join!(
        fetch(CLAIM),
        fetch(TEMPLATE),
        fetch(CLASS),
        fetch(SLICE),
        fetch(POD)
    );
    DeviceResourcesSnapshot {
        namespace: namespace.to_owned(),
        captured_at: chrono::Utc::now().to_rfc3339(),
        claims,
        templates,
        classes,
        slices,
        pods,
    }
}

async fn list_source(
    client: &Client,
    namespace: &str,
    resource: Resource,
    max_pages: usize,
    deadline: Duration,
) -> DeviceSource {
    let group = if resource.pod { "" } else { "resource.k8s.io" };
    let gvk = GroupVersionKind::gvk(group, "v1", resource.kind);
    let ar = ApiResource::from_gvk_with_plural(&gvk, resource.plural);
    let api: Api<DynamicObject> = if resource.namespaced && !namespace.is_empty() {
        Api::namespaced_with(client.clone(), namespace, &ar)
    } else {
        Api::all_with(client.clone(), &ar)
    };
    let operation = async {
        let mut result = DeviceSource {
            state: DeviceSourceState::Available,
            items: Vec::new(),
            message: None,
        };
        let mut continuation = String::new();
        for _ in 0..max_pages {
            let mut params = ListParams::default().limit(PAGE_SIZE);
            if !continuation.is_empty() {
                params = params.continue_token(&continuation);
            }
            let page = match api.list(&params).await {
                Ok(page) => page,
                Err(error) => {
                    let (state, reason) = match error {
                        kube::Error::Api(error) if error.code == 403 => (DeviceSourceState::Forbidden, "Permission to list this resource was denied.".to_owned()),
                        kube::Error::Api(error) if error.code == 404 => (DeviceSourceState::Error, "Resource endpoint or namespace was not found; API support could not be confirmed from this response.".to_owned()),
                        kube::Error::Api(error) => (DeviceSourceState::Error, format!("Kubernetes request failed (HTTP {}).", error.code)),
                        _ => (DeviceSourceState::Error, "Kubernetes request failed. Check cluster connectivity and authentication.".to_owned()),
                    };
                    result.state = state;
                    result.message = Some(format!(
                        "{}: {reason} Inventory is incomplete.",
                        resource.kind
                    ));
                    return result;
                }
            };
            // Respect the item budget even if an API server ignores the list limit.
            let capacity = PAGE_SIZE as usize * max_pages;
            let exceeds_budget = page.items.len() > capacity.saturating_sub(result.items.len());
            for object in page
                .items
                .into_iter()
                .take(capacity.saturating_sub(result.items.len()))
            {
                let value = match serde_json::to_value(object) {
                    Ok(value) => value,
                    Err(_) => {
                        result.state = DeviceSourceState::Error;
                        result.message = Some(format!(
                            "{}: Could not decode an object. Inventory is incomplete.",
                            resource.kind
                        ));
                        return result;
                    }
                };
                result.items.push(if resource.pod {
                    project_pod(value)
                } else {
                    sanitize_device(value)
                });
            }
            continuation = page.metadata.continue_.unwrap_or_default();
            if !exceeds_budget && continuation.is_empty() {
                return result;
            }
            if exceeds_budget || result.items.len() >= capacity {
                break;
            }
        }
        result.state = DeviceSourceState::Error;
        result.message = Some(format!("{}: Inventory is incomplete because the request limit was reached. Select a narrower namespace or inspect the resource with kubectl.", resource.kind));
        result
    };
    tokio::time::timeout(deadline, operation).await.unwrap_or_else(|_| DeviceSource::unavailable(
        DeviceSourceState::Error, format!("{}: Inventory request timed out. Results are incomplete; retry when the cluster is reachable.", resource.kind)))
}

fn select(value: &Value, keys: &[&str]) -> Value {
    let mut object = Map::new();
    for &key in keys {
        if let Some(field) = value.get(key) {
            object.insert(key.to_owned(), field.clone());
        }
    }
    Value::Object(object)
}

/// Pods can contain literal environment secrets and annotations. Only fields
/// needed for claim attribution and device health may cross the IPC boundary.
fn project_pod(pod: Value) -> Value {
    let mut out = select(&pod, &["apiVersion", "kind"]);
    out["metadata"] = select(
        &pod["metadata"],
        &["name", "namespace", "uid", "creationTimestamp"],
    );
    out["spec"] = select(&pod["spec"], &["nodeName", "resourceClaims"]);
    out["status"] = select(&pod["status"], &["phase", "resourceClaimStatuses"]);
    for key in ["containers", "initContainers", "ephemeralContainers"] {
        if let Some(containers) = pod["spec"][key].as_array() {
            out["spec"][key] = Value::Array(
                containers
                    .iter()
                    .map(|container| {
                        let mut projected = select(container, &["name"]);
                        projected["resources"] = select(&container["resources"], &["claims"]);
                        projected
                    })
                    .collect(),
            );
        }
    }
    for key in [
        "containerStatuses",
        "initContainerStatuses",
        "ephemeralContainerStatuses",
    ] {
        if let Some(containers) = pod["status"][key].as_array() {
            out["status"][key] = Value::Array(
                containers
                    .iter()
                    .map(|container| select(container, &["name", "allocatedResourcesStatus"]))
                    .collect(),
            );
        }
    }
    out
}

/// Device resources are inspectable but arbitrary driver parameters/status data
/// and annotations may contain credentials. Never return those opaque payloads.
fn sanitize_device(mut value: Value) -> Value {
    fn scrub(value: &mut Value) {
        match value {
            Value::Object(object) => {
                if let Some(metadata) = object.get_mut("metadata").and_then(Value::as_object_mut) {
                    metadata.remove("annotations");
                    metadata.remove("managedFields");
                }
                if let Some(opaque) = object.get_mut("opaque").and_then(Value::as_object_mut) {
                    if opaque.contains_key("parameters") {
                        opaque.insert("parameters".into(), json!({"_redacted": true}));
                    }
                }
                for value in object.values_mut() {
                    scrub(value);
                }
            }
            Value::Array(array) => {
                for value in array {
                    scrub(value);
                }
            }
            _ => {}
        }
    }
    if let Some(devices) = value
        .pointer_mut("/status/devices")
        .and_then(Value::as_array_mut)
    {
        for device in devices {
            if let Some(device) = device.as_object_mut() {
                if device.contains_key("data") {
                    device.insert("data".into(), json!({"_redacted": true}));
                }
            }
        }
    }
    scrub(&mut value);
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::{
        matchers::{method, path, query_param},
        Mock, MockServer, ResponseTemplate,
    };

    fn client(server: &MockServer) -> Client {
        Client::try_from(kube::Config::new(server.uri().parse().unwrap())).unwrap()
    }

    async fn discovery(server: &MockServer) {
        Mock::given(method("GET")).and(path("/apis/resource.k8s.io/v1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "apiVersion":"v1", "kind":"APIResourceList", "groupVersion":"resource.k8s.io/v1",
                "resources": [
                    {"name":"resourceclaims","singularName":"resourceclaim","namespaced":true,"kind":"ResourceClaim","verbs":["list"]},
                    {"name":"resourceclaimtemplates","singularName":"resourceclaimtemplate","namespaced":true,"kind":"ResourceClaimTemplate","verbs":["list"]},
                    {"name":"deviceclasses","singularName":"deviceclass","namespaced":false,"kind":"DeviceClass","verbs":["list"]},
                    {"name":"resourceslices","singularName":"resourceslice","namespaced":false,"kind":"ResourceSlice","verbs":["list"]}
                ]
            }))).mount(server).await;
    }

    fn list(items: Value, next: &str) -> Value {
        json!({"apiVersion":"v1","kind":"List","metadata":{"continue":next},"items":items})
    }

    async fn response(server: &MockServer, route: &str, status: u16, body: Value) {
        Mock::given(method("GET"))
            .and(path(route))
            .respond_with(ResponseTemplate::new(status).set_body_json(body))
            .mount(server)
            .await;
    }

    fn failure(code: u16) -> Value {
        json!({"apiVersion":"v1","kind":"Status","status":"Failure","reason":"Failure","message":"private upstream text","code":code})
    }

    #[test]
    fn namespace_validation_rejects_paths_and_invalid_dns_labels() {
        for namespace in ["", "default", "team-42", "9"] {
            assert!(valid_namespace(namespace));
        }
        assert!(valid_namespace(&"a".repeat(63)));
        for namespace in ["..", "a/b", "A", " team", "team ", "-a", "a-", "a.b", "💻"] {
            assert!(!valid_namespace(namespace), "accepted {namespace}");
        }
        assert!(!valid_namespace(&"a".repeat(64)));
    }

    #[test]
    fn source_state_serialization_is_stable() {
        assert_eq!(
            serde_json::to_value(DeviceSource {
                state: DeviceSourceState::Available,
                items: vec![],
                message: None,
            })
            .unwrap(),
            json!({"state":"available","items":[],"message":null})
        );
        assert_eq!(
            serde_json::to_value(DeviceSourceState::Unsupported).unwrap(),
            "unsupported"
        );
        assert_eq!(
            serde_json::to_value(DeviceSourceState::Forbidden).unwrap(),
            "forbidden"
        );
        assert_eq!(
            serde_json::to_value(DeviceSourceState::Error).unwrap(),
            "error"
        );
    }

    #[tokio::test]
    async fn advertised_group_without_resource_is_unsupported() {
        let server = MockServer::start().await;
        response(&server, "/apis/resource.k8s.io/v1", 200,
            json!({"apiVersion":"v1","kind":"APIResourceList","groupVersion":"resource.k8s.io/v1","resources":[]})).await;
        response(&server, "/api/v1/pods", 200, list(json!([]), "")).await;
        let result = snapshot(&client(&server), "").await;
        assert_eq!(result.claims.state, DeviceSourceState::Unsupported);
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn later_page_failure_preserves_partial_items_and_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/apis/resource.k8s.io/v1/deviceclasses"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(list(json!([{"metadata":{"name":"first"}}]), "next")),
            )
            .with_priority(2)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/apis/resource.k8s.io/v1/deviceclasses"))
            .and(query_param("continue", "next"))
            .respond_with(ResponseTemplate::new(410).set_body_json(failure(410)))
            .with_priority(1)
            .mount(&server)
            .await;
        let result = list_source(&client(&server), "", CLASS, 2, Duration::from_secs(2)).await;
        assert_eq!(result.state, DeviceSourceState::Error);
        assert_eq!(result.items.len(), 1);
        assert!(result.message.unwrap().contains("incomplete"));
    }

    #[tokio::test]
    async fn ignores_server_overrun_beyond_item_budget() {
        let server = MockServer::start().await;
        response(
            &server,
            "/apis/resource.k8s.io/v1/deviceclasses",
            200,
            list(
                Value::Array(
                    (0..=PAGE_SIZE)
                        .map(|i| json!({"metadata":{"name":i.to_string()}}))
                        .collect(),
                ),
                "",
            ),
        )
        .await;
        let result = list_source(&client(&server), "", CLASS, 1, Duration::from_secs(2)).await;
        assert_eq!(result.state, DeviceSourceState::Error);
        assert_eq!(result.items.len(), PAGE_SIZE as usize);
    }

    #[tokio::test]
    async fn snapshot_scopes_sources_and_preserves_independent_failures() {
        let server = MockServer::start().await;
        discovery(&server).await;
        response(
            &server,
            "/apis/resource.k8s.io/v1/namespaces/team/resourceclaims",
            200,
            list(json!([{"metadata":{"name":"gpu","namespace":"team"}}]), ""),
        )
        .await;
        response(
            &server,
            "/apis/resource.k8s.io/v1/namespaces/team/resourceclaimtemplates",
            403,
            failure(403),
        )
        .await;
        response(
            &server,
            "/apis/resource.k8s.io/v1/deviceclasses",
            200,
            list(json!([]), ""),
        )
        .await;
        response(
            &server,
            "/apis/resource.k8s.io/v1/resourceslices",
            500,
            failure(500),
        )
        .await;
        response(&server, "/api/v1/namespaces/team/pods", 404, failure(404)).await;
        let result = snapshot(&client(&server), "team").await;
        assert_eq!(result.claims.state, DeviceSourceState::Available);
        assert_eq!(result.claims.items[0]["metadata"]["name"], "gpu");
        assert_eq!(result.templates.state, DeviceSourceState::Forbidden);
        assert_eq!(result.classes.state, DeviceSourceState::Available);
        assert_eq!(result.slices.state, DeviceSourceState::Error);
        assert_eq!(result.pods.state, DeviceSourceState::Error);
        assert!(!serde_json::to_string(&result)
            .unwrap()
            .contains("private upstream"));
    }

    #[tokio::test]
    async fn missing_api_is_unsupported_but_pods_still_load() {
        let server = MockServer::start().await;
        response(&server, "/apis/resource.k8s.io/v1", 404, failure(404)).await;
        response(&server, "/api/v1/pods", 200, list(json!([]), "")).await;
        let result = snapshot(&client(&server), "").await;
        assert_eq!(result.claims.state, DeviceSourceState::Unsupported);
        assert_eq!(result.templates.state, DeviceSourceState::Unsupported);
        assert_eq!(result.classes.state, DeviceSourceState::Unsupported);
        assert_eq!(result.slices.state, DeviceSourceState::Unsupported);
        assert_eq!(result.pods.state, DeviceSourceState::Available);
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn missing_namespace_is_not_unsupported() {
        let server = MockServer::start().await;
        discovery(&server).await;
        response(
            &server,
            "/apis/resource.k8s.io/v1/namespaces/gone/resourceclaims",
            404,
            failure(404),
        )
        .await;
        let result = snapshot(&client(&server), "gone").await;
        assert_eq!(result.claims.state, DeviceSourceState::Error);
    }

    #[tokio::test]
    async fn denied_discovery_still_allows_authorized_list() {
        let server = MockServer::start().await;
        response(&server, "/apis/resource.k8s.io/v1", 403, failure(403)).await;
        response(
            &server,
            "/apis/resource.k8s.io/v1/resourceclaims",
            200,
            list(json!([]), ""),
        )
        .await;
        response(
            &server,
            "/apis/resource.k8s.io/v1/deviceclasses",
            404,
            failure(404),
        )
        .await;
        let result = snapshot(&client(&server), "").await;
        assert_eq!(result.claims.state, DeviceSourceState::Available);
        assert_eq!(result.classes.state, DeviceSourceState::Error);
    }

    #[tokio::test]
    async fn pagination_follows_token_and_marks_truncation() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/apis/resource.k8s.io/v1/deviceclasses"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(list(json!([{"metadata":{"name":"first"}}]), "next")),
            )
            .with_priority(2)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/apis/resource.k8s.io/v1/deviceclasses"))
            .and(query_param("continue", "next"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(list(json!([{"metadata":{"name":"second"}}]), "")),
            )
            .with_priority(1)
            .mount(&server)
            .await;
        let result = list_source(&client(&server), "", CLASS, 2, Duration::from_secs(2)).await;
        assert_eq!(result.state, DeviceSourceState::Available);
        assert_eq!(result.items.len(), 2);
        let truncated = list_source(&client(&server), "", CLASS, 1, Duration::from_secs(2)).await;
        assert_eq!(truncated.state, DeviceSourceState::Error);
        assert_eq!(truncated.items.len(), 1);
        assert!(truncated.message.unwrap().contains("incomplete"));
    }

    #[tokio::test]
    async fn stalled_source_has_deadline() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(list(json!([]), ""))
                    .set_delay(Duration::from_millis(200)),
            )
            .mount(&server)
            .await;
        let result = list_source(&client(&server), "", CLASS, 1, Duration::from_millis(10)).await;
        assert_eq!(result.state, DeviceSourceState::Error);
        assert!(result.message.unwrap().contains("timed out"));
    }

    #[test]
    fn pod_projection_retains_claim_health_without_secrets() {
        let pod = json!({"apiVersion":"v1","kind":"Pod", "metadata":{"name":"p","namespace":"n","uid":"u","annotations":{"secret":"hidden"}},
            "spec":{"nodeName":"node","serviceAccountName":"private", "resourceClaims":[{"name":"gpu","resourceClaimName":"claim"}],
                "containers":[{"name":"app","image":"private","env":[{"value":"hidden"}],"resources":{"claims":[{"name":"gpu"}],"limits":{"cpu":"1"}}}],
                "initContainers":[{"name":"init","resources":{"claims":[{"name":"gpu"}]}}]},
            "status":{"phase":"Succeeded","podIP":"private","resourceClaimStatuses":[{"name":"gpu","resourceClaimName":"generated"}],
                "containerStatuses":[{"name":"app","imageID":"private","allocatedResourcesStatus":[{"name":"claim:gpu","resources":[{"resourceID":"driver/pool/device","health":"Healthy"}]}]}]}});
        let out = project_pod(pod);
        assert_eq!(out["spec"]["nodeName"], "node");
        assert_eq!(out["status"]["phase"], "Succeeded");
        assert_eq!(
            out["spec"]["containers"][0]["resources"]["claims"][0]["name"],
            "gpu"
        );
        assert_eq!(
            out["status"]["containerStatuses"][0]["allocatedResourcesStatus"][0]["resources"][0]
                ["health"],
            "Healthy"
        );
        assert!(!out.to_string().contains("hidden"));
        assert!(!out.to_string().contains("private"));
    }

    #[test]
    fn yaml_projection_redacts_nested_configuration_and_annotations() {
        let out = sanitize_device(
            json!({"metadata":{"name":"c","annotations":{"secret":"hidden"},"managedFields":[{"secret":"hidden"}]},
            "spec":{"spec":{"devices":{"config":[{"opaque":{"driver":"driver","parameters":{"token":"hidden"}}}]}}},
            "status":{"devices":[{"driver":"driver","data":{"token":"hidden"},"conditions":[{"type":"Ready","status":"True"}]}]}}),
        );
        assert!(!out.to_string().contains("hidden"));
        assert_eq!(
            out["spec"]["spec"]["devices"]["config"][0]["opaque"]["driver"],
            "driver"
        );
        assert_eq!(
            out["status"]["devices"][0]["conditions"][0]["type"],
            "Ready"
        );
    }
}
