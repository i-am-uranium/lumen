//! Explicit, UID-bound ephemeral debugging using namespace-scoped Pod APIs.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DebugProfile {
    Restricted,
    Baseline,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DebugRequest {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub pod_uid: String,
    pub target_container: String,
    pub name: String,
    pub image: String,
    pub command: Vec<String>,
    pub profile: DebugProfile,
}
use k8s_openapi::api::core::v1::{
    Capabilities, EphemeralContainer, Pod, SeccompProfile, SecurityContext,
};
use kube::{api::PostParams, Api, Client};
use std::time::Duration;
use tokio::time::{timeout_at, Instant};

#[derive(Debug, Clone, Serialize)]
pub struct DebugContainer {
    pub name: String,
    pub image: String,
    pub target_container: Option<String>,
    pub state: String,
    pub message: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct DebugTarget {
    pub context: String,
    pub namespace: String,
    pub pod: String,
    pub pod_uid: String,
    pub phase: String,
    pub deleting: bool,
    pub containers: Vec<String>,
    pub ephemeral_containers: Vec<DebugContainer>,
}
#[derive(Debug, Clone, Serialize)]
pub struct DebugResult {
    pub container: DebugContainer,
    pub reused: bool,
}

fn dns_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
}
fn validate(request: &DebugRequest) -> AppResult<()> {
    if request.context.trim().is_empty()
        || request.pod_uid.trim().is_empty()
        || !dns_label(&request.namespace)
        || request.pod.is_empty()
        || request.pod.len() > 253
        || !request.pod.split('.').all(dns_label)
        || !dns_label(&request.target_container)
        || !dns_label(&request.name)
        || !request.name.starts_with("lumen-debug-")
    {
        return Err(AppError::K8s("A captured context, namespace, pod UID, target container, and lumen-debug-* name are required".into()));
    }
    if request.image.is_empty()
        || request.image.len() > 512
        || request.image.chars().any(char::is_whitespace)
        || request.image.contains('\0')
    {
        return Err(AppError::K8s(
            "Enter a diagnostic image reference without whitespace".into(),
        ));
    }
    if request.command.is_empty()
        || request.command.len() > 64
        || request.command[0].trim().is_empty()
        || request
            .command
            .iter()
            .any(|arg| arg.contains('\0') || arg.len() > 4096)
    {
        return Err(AppError::K8s(
            "Enter a non-empty command argument array (up to 64 arguments)".into(),
        ));
    }
    Ok(())
}
fn desired(request: &DebugRequest) -> EphemeralContainer {
    EphemeralContainer {
        name: request.name.clone(),
        image: Some(request.image.clone()),
        command: Some(request.command.clone()),
        target_container_name: Some(request.target_container.clone()),
        security_context: Some(SecurityContext {
            privileged: Some(false),
            allow_privilege_escalation: Some(false),
            run_as_non_root: Some(true),
            run_as_user: Some(1000),
            capabilities: Some(Capabilities {
                drop: Some(vec!["ALL".into()]),
                ..Default::default()
            }),
            seccomp_profile: Some(SeccompProfile {
                type_: "RuntimeDefault".into(),
                ..Default::default()
            }),
            read_only_root_filesystem: Some(matches!(request.profile, DebugProfile::Restricted)),
            ..Default::default()
        }),
        ..Default::default()
    }
}

pub fn verify_pod(pod: &Pod, uid: &str) -> AppResult<()> {
    if pod.metadata.uid.as_deref() != Some(uid) {
        return Err(AppError::Conflict(
            "The pod was replaced. Close debugging and select the new pod before continuing."
                .into(),
        ));
    }
    if pod.metadata.deletion_timestamp.is_some() {
        return Err(AppError::K8s(
            "The pod is deleting; debugging is unavailable.".into(),
        ));
    }
    if pod
        .status
        .as_ref()
        .and_then(|s| s.phase.as_deref())
        .is_some_and(|phase| phase == "Succeeded" || phase == "Failed")
    {
        return Err(AppError::K8s(
            "The pod has completed; ephemeral containers cannot be started or restarted.".into(),
        ));
    }
    if pod
        .spec
        .as_ref()
        .and_then(|s| s.os.as_ref())
        .is_some_and(|os| os.name == "windows")
    {
        return Err(AppError::K8s(
            "These unprivileged debug profiles support Linux pods only.".into(),
        ));
    }
    Ok(())
}
pub fn verify_terminal(pod: &Pod, uid: &str, container: Option<&str>) -> AppResult<()> {
    verify_pod(pod, uid)?;
    if let Some(container) = container {
        let spec = pod
            .spec
            .as_ref()
            .ok_or_else(|| AppError::K8s("Pod has no specification".into()))?;
        if spec
            .ephemeral_containers
            .as_ref()
            .is_some_and(|cs| cs.iter().any(|c| c.name == container))
        {
            let running = pod
                .status
                .as_ref()
                .and_then(|s| s.ephemeral_container_statuses.as_ref())
                .and_then(|cs| cs.iter().find(|c| c.name == container))
                .and_then(|c| c.state.as_ref())
                .and_then(|s| s.running.as_ref())
                .is_some();
            if !running {
                return Err(AppError::K8s("Diagnostic container is not running. Refresh debug status; terminated ephemeral containers cannot restart.".into()));
            }
        } else if !spec.containers.iter().any(|c| c.name == container) {
            return Err(AppError::K8s(
                "The selected container is unavailable in the captured pod. Refresh debug status."
                    .into(),
            ));
        }
    }
    Ok(())
}

fn container_state(pod: &Pod, container: &EphemeralContainer) -> DebugContainer {
    let state = pod
        .status
        .as_ref()
        .and_then(|s| s.ephemeral_container_statuses.as_ref())
        .and_then(|list| list.iter().find(|s| s.name == container.name))
        .and_then(|s| s.state.as_ref());
    let (phase, message) = if let Some(terminated) = state.and_then(|s| s.terminated.as_ref()) {
        ("terminated", Some(format!("Exited with code {}: {}. Ephemeral containers cannot restart; explicitly create another container if needed.", terminated.exit_code, terminated.reason.as_deref().unwrap_or("process exited"))))
    } else if state.and_then(|s| s.running.as_ref()).is_some() {
        ("running", None)
    } else if let Some(waiting) = state.and_then(|s| s.waiting.as_ref()) {
        (
            "waiting",
            Some(format!(
                "{}: {}",
                waiting.reason.as_deref().unwrap_or("Waiting"),
                waiting
                    .message
                    .as_deref()
                    .unwrap_or("Waiting for the runtime to start the container")
            )),
        )
    } else {
        (
            "waiting",
            Some("Waiting for container status from the kubelet".into()),
        )
    };
    DebugContainer {
        name: container.name.clone(),
        image: container.image.clone().unwrap_or_default(),
        target_container: container.target_container_name.clone(),
        state: phase.into(),
        message,
    }
}
fn summarize(context: &str, pod: &Pod) -> AppResult<DebugTarget> {
    let spec = pod
        .spec
        .as_ref()
        .ok_or_else(|| AppError::K8s("Pod has no specification".into()))?;
    Ok(DebugTarget {
        context: context.into(),
        namespace: pod.metadata.namespace.clone().unwrap_or_default(),
        pod: pod.metadata.name.clone().unwrap_or_default(),
        pod_uid: pod
            .metadata
            .uid
            .clone()
            .ok_or_else(|| AppError::K8s("Pod UID is unavailable; debugging is blocked".into()))?,
        phase: pod
            .status
            .as_ref()
            .and_then(|s| s.phase.clone())
            .unwrap_or_else(|| "Unknown".into()),
        deleting: pod.metadata.deletion_timestamp.is_some(),
        containers: spec.containers.iter().map(|c| c.name.clone()).collect(),
        ephemeral_containers: spec
            .ephemeral_containers
            .as_ref()
            .map(|cs| cs.iter().map(|c| container_state(pod, c)).collect())
            .unwrap_or_default(),
    })
}
fn api_error(error: kube::Error, name: &str) -> AppError {
    let hint = match &error {
        kube::Error::Api(e) if e.code == 403 => "Permission or admission denied. Check pods/get and pods/ephemeralcontainers update RBAC and admission policy.",
        kube::Error::Api(e) if e.code == 404 || e.code == 405 => "Pod or ephemeralcontainers API unavailable. Refresh the pod and check cluster support.",
        kube::Error::Api(e) if e.code == 422 => "The API or admission policy rejected this image, target or security profile.",
        _ => "Request failed. Refresh container status before retrying the same debug container.",
    };
    AppError::K8s(format!("Debug container {name}: {hint} {error}"))
}
fn timed_out(name: &str) -> AppError {
    AppError::K8s(format!("Timed out waiting for debug container {name}. It may still start. Refresh status or retry this same container; do not create another unless intended."))
}
pub async fn get_target(
    client: Client,
    context: &str,
    namespace: &str,
    name: &str,
) -> AppResult<DebugTarget> {
    let api: Api<Pod> = Api::namespaced(client, namespace);
    let pod = tokio::time::timeout(Duration::from_secs(10), api.get(name))
        .await
        .map_err(|_| AppError::Network("Timed out reading pod debug status".into()))?
        .map_err(|e| api_error(e, name))?;
    summarize(context, &pod)
}

/// `authorize` must recheck the captured context policy immediately before each
/// write, including conflict retries. No server request executes shell code here.
pub async fn create(
    client: Client,
    request: DebugRequest,
    authorize: impl Fn() -> AppResult<()>,
) -> AppResult<DebugResult> {
    create_with_limits(
        client,
        request,
        authorize,
        Duration::from_secs(30),
        Duration::from_millis(500),
    )
    .await
}
async fn create_with_limits(
    client: Client,
    request: DebugRequest,
    authorize: impl Fn() -> AppResult<()>,
    budget: Duration,
    poll: Duration,
) -> AppResult<DebugResult> {
    validate(&request)?;
    let deadline = Instant::now() + budget;
    let api: Api<Pod> = Api::namespaced(client, &request.namespace);
    let expected = desired(&request);
    let mut reused = true;
    let mut writes = 0;
    loop {
        let mut pod = timeout_at(deadline, api.get(&request.pod))
            .await
            .map_err(|_| timed_out(&request.name))?
            .map_err(|e| api_error(e, &request.name))?;
        verify_pod(&pod, &request.pod_uid)?;
        let spec = pod
            .spec
            .as_mut()
            .ok_or_else(|| AppError::K8s("Pod has no specification".into()))?;
        if !spec
            .containers
            .iter()
            .any(|c| c.name == request.target_container)
        {
            return Err(AppError::K8s(
                "The selected target container no longer exists in this pod.".into(),
            ));
        }
        let containers = spec.ephemeral_containers.get_or_insert_with(Vec::new);
        if let Some(existing) = containers.iter().find(|c| c.name == request.name).cloned() {
            // The stable request name provides retry identity; reject name
            // collisions with a different image, command, target, or profile.
            if existing.image != expected.image
                || existing.command != expected.command
                || existing.target_container_name != expected.target_container_name
                || existing.security_context != expected.security_context
                || existing.args != expected.args
            {
                return Err(AppError::Conflict(format!("Debug container {} already exists with a different configuration. It cannot be replaced; explicitly configure a new container.", request.name)));
            }
            let status = container_state(&pod, &existing);
            if status.state == "running" {
                return Ok(DebugResult {
                    container: status,
                    reused,
                });
            }
            if status.state == "terminated" {
                return Err(AppError::K8s(format!(
                    "Debug container {}: {}",
                    request.name,
                    status.message.unwrap_or_default()
                )));
            }
            if status.message.as_deref().is_some_and(|m| {
                [
                    "ErrImagePull",
                    "ImagePullBackOff",
                    "InvalidImageName",
                    "CreateContainerConfigError",
                    "CreateContainerError",
                    "RunContainerError",
                ]
                .iter()
                .any(|reason| m.starts_with(reason))
            }) {
                return Err(AppError::K8s(format!("Debug container {}: {}. Check the image, registry access and profile; refresh or retry the same container after repair.", request.name, status.message.unwrap_or_default())));
            }
            timeout_at(deadline, tokio::time::sleep(poll))
                .await
                .map_err(|_| timed_out(&request.name))?;
            continue;
        }
        if writes >= 3 {
            return Err(AppError::Conflict(format!("Pod changed repeatedly. Refresh and retry debug container {} using the same request.", request.name)));
        }
        if pod.metadata.resource_version.is_none() {
            return Err(AppError::Conflict(
                "Pod resourceVersion is unavailable; refusing an unsafe update".into(),
            ));
        }
        containers.push(expected.clone());
        authorize()?;
        writes += 1;
        match timeout_at(
            deadline,
            api.replace_subresource(
                "ephemeralcontainers",
                &request.pod,
                &PostParams::default(),
                &pod,
            ),
        )
        .await
        {
            Ok(Ok(_)) => {
                reused = false;
            }
            Ok(Err(kube::Error::Api(error))) if error.code == 409 => continue,
            Ok(Err(error)) => return Err(api_error(error, &request.name)),
            Err(_) => return Err(timed_out(&request.name)),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> DebugRequest {
        DebugRequest {
            context: "dev".into(),
            namespace: "apps".into(),
            pod: "api".into(),
            pod_uid: "uid-1".into(),
            target_container: "app".into(),
            name: "lumen-debug-123".into(),
            image: "busybox:1.37".into(),
            command: vec!["sleep".into(), "3600".into()],
            profile: DebugProfile::Restricted,
        }
    }
    #[test]
    fn rejects_empty_identity_command_and_unsupported_privilege() {
        let mut req = request();
        req.command.clear();
        assert!(validate(&req).is_err());
        let mut req = request();
        req.pod_uid.clear();
        assert!(validate(&req).is_err());
        let mut json = serde_json::to_value(request()).unwrap();
        json["profile"] = serde_json::json!("privileged");
        assert!(serde_json::from_value::<DebugRequest>(json).is_err());
        let mut json = serde_json::to_value(request()).unwrap();
        json["privileged"] = serde_json::json!(true);
        assert!(serde_json::from_value::<DebugRequest>(json).is_err());
    }
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };
    fn pod() -> serde_json::Value {
        serde_json::json!({"apiVersion":"v1", "kind":"Pod", "metadata":{"name":"api", "namespace":"apps", "uid":"uid-1", "resourceVersion":"1"}, "spec":{"containers":[{"name":"app", "image":"app"}], "ephemeralContainers":[{"name":"other", "image":"other"}]}, "status":{"phase":"Running"}})
    }
    fn with_requested(mut pod: serde_json::Value, phase: &str) -> serde_json::Value {
        pod["spec"]["ephemeralContainers"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::to_value(desired(&request())).unwrap());
        pod["status"]["ephemeralContainerStatuses"] = serde_json::json!([{"name":"lumen-debug-123", "image":"busybox:1.37", "imageID":"test", "ready":true, "restartCount":0, "state": match phase {
            "running" => serde_json::json!({"running":{}}),
            "terminated" => serde_json::json!({"terminated":{"exitCode":1,"reason":"Error"}}),
            "image" => serde_json::json!({"waiting":{"reason":"ImagePullBackOff", "message":"Cannot pull image"}}),
            _ => serde_json::json!({"waiting":{"reason":"ContainerCreating"}}),
        }}]);
        pod
    }
    fn client(server: &MockServer) -> Client {
        Client::try_from(kube::Config::new(server.uri().parse().unwrap())).unwrap()
    }
    #[tokio::test]
    async fn creates_only_ephemeral_subresource_preserves_additions_and_sets_unprivileged_profile()
    {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let server = MockServer::start().await;
        let stage = Arc::new(AtomicUsize::new(0));
        let read_stage = stage.clone();
        Mock::given(method("GET"))
            .and(path("/api/v1/namespaces/apps/pods/api"))
            .respond_with(move |_: &wiremock::Request| {
                let mut p = pod();
                if read_stage.load(Ordering::SeqCst) > 0 {
                    p["metadata"]["resourceVersion"] = serde_json::json!("2");
                    p["spec"]["ephemeralContainers"]
                        .as_array_mut()
                        .unwrap()
                        .push(serde_json::json!({"name":"concurrent", "image":"other"}));
                }
                if read_stage.load(Ordering::SeqCst) > 1 {
                    p = with_requested(p, "running");
                }
                ResponseTemplate::new(200).set_body_json(p)
            })
            .mount(&server)
            .await;
        let write_stage = stage.clone();
        Mock::given(method("PUT")).and(path("/api/v1/namespaces/apps/pods/api/ephemeralcontainers")).respond_with(move |_: &wiremock::Request| {
            if write_stage.fetch_add(1, Ordering::SeqCst) == 0 { ResponseTemplate::new(409).set_body_json(serde_json::json!({"kind":"Status", "apiVersion":"v1", "status":"Failure", "reason":"Conflict", "message":"changed", "code":409})) }
            else { ResponseTemplate::new(200).set_body_json(with_requested(pod(), "running")) }
        }).expect(2).mount(&server).await;
        let authorized = std::cell::Cell::new(0);
        let result = create(client(&server), request(), || {
            authorized.set(authorized.get() + 1);
            Ok(())
        })
        .await
        .unwrap();
        assert!(!result.reused);
        assert_eq!(result.container.state, "running");
        assert_eq!(authorized.get(), 2);
        let requests = server.received_requests().await.unwrap();
        let writes: Vec<_> = requests.iter().filter(|r| r.method == "PUT").collect();
        let final_body: serde_json::Value = serde_json::from_slice(&writes[1].body).unwrap();
        assert_eq!(final_body["metadata"]["uid"], "uid-1");
        assert_eq!(final_body["metadata"]["resourceVersion"], "2");
        let ephemerals = final_body["spec"]["ephemeralContainers"]
            .as_array()
            .unwrap();
        assert_eq!(
            ephemerals
                .iter()
                .map(|c| c["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["other", "concurrent", "lumen-debug-123"]
        );
        assert_eq!(ephemerals[2]["targetContainerName"], "app");
        assert_eq!(
            ephemerals[2]["command"],
            serde_json::json!(["sleep", "3600"])
        );
        assert_eq!(
            ephemerals[2]["securityContext"],
            serde_json::json!({"privileged":false,"allowPrivilegeEscalation":false,"runAsNonRoot":true,"runAsUser":1000,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]},"seccompProfile":{"type":"RuntimeDefault"}})
        );
    }
    #[tokio::test]
    async fn checks_identity_target_lifecycle_and_protection_before_writing() {
        for variant in ["uid", "target", "completed", "deleting", "locked"] {
            let server = MockServer::start().await;
            let mut p = pod();
            let mut req = request();
            match variant {
                "uid" => req.pod_uid = "replacement".into(),
                "target" => req.target_container = "missing".into(),
                "completed" => p["status"]["phase"] = serde_json::json!("Succeeded"),
                "deleting" => {
                    p["metadata"]["deletionTimestamp"] = serde_json::json!("2026-09-08T00:00:00Z")
                }
                _ => {}
            }
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(200).set_body_json(p))
                .mount(&server)
                .await;
            let error = create(client(&server), req, || {
                if variant == "locked" {
                    Err(AppError::PermissionDenied("locked".into()))
                } else {
                    Ok(())
                }
            })
            .await
            .unwrap_err();
            let expected = match variant {
                "uid" => "replaced",
                "target" => "target container",
                "completed" => "completed",
                "deleting" => "deleting",
                _ => "locked",
            };
            assert!(error.to_string().contains(expected), "{variant}: {error}");
            assert!(
                server
                    .received_requests()
                    .await
                    .unwrap()
                    .iter()
                    .all(|r| r.method == "GET"),
                "{variant} wrote to the pod"
            );
        }
    }
    #[tokio::test]
    async fn lock_during_conflict_retry_stops_the_next_write() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(pod()))
            .mount(&server)
            .await;
        Mock::given(method("PUT")).respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Conflict","message":"changed","code":409}))).expect(1).mount(&server).await;
        let attempts = std::cell::Cell::new(0);
        let error = create(client(&server), request(), || {
            attempts.set(attempts.get() + 1);
            if attempts.get() == 1 {
                Ok(())
            } else {
                Err(AppError::PermissionDenied("expired".into()))
            }
        })
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::PermissionDenied(_)));
    }
    #[tokio::test]
    async fn retry_reuses_matching_container_and_rejects_collision_or_terminated_container() {
        for variant in ["running", "image", "terminated", "collision"] {
            let server = MockServer::start().await;
            let mut p = with_requested(pod(), variant);
            if variant == "collision" {
                p["spec"]["ephemeralContainers"][1]["image"] = serde_json::json!("different");
            }
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(200).set_body_json(p))
                .mount(&server)
                .await;
            let result = create(client(&server), request(), || Ok(())).await;
            if variant == "running" {
                assert!(result.unwrap().reused);
            } else {
                let message = result.unwrap_err().to_string();
                assert!(message.contains("lumen-debug-123"));
            }
            assert!(server
                .received_requests()
                .await
                .unwrap()
                .iter()
                .all(|r| r.method == "GET"));
        }
    }
    #[tokio::test]
    async fn bounded_wait_names_the_existing_container_and_never_adds_another() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(with_requested(pod(), "waiting")),
            )
            .mount(&server)
            .await;
        let error = create_with_limits(
            client(&server),
            request(),
            || Ok(()),
            Duration::from_millis(20),
            Duration::from_millis(5),
        )
        .await
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("lumen-debug-123"));
        assert!(message.contains("same container"));
        assert!(server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .all(|r| r.method == "GET"));
    }
    #[tokio::test]
    async fn namespace_scoped_status_and_forbidden_error_are_actionable() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/namespaces/apps/pods/api"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(with_requested(pod(), "terminated")),
            )
            .mount(&server)
            .await;
        let status = get_target(client(&server), "dev", "apps", "api")
            .await
            .unwrap();
        assert_eq!(status.pod_uid, "uid-1");
        assert_eq!(status.ephemeral_containers[1].state, "terminated");
        Mock::given(method("PUT")).respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","message":"denied","code":403}))).mount(&server).await;
        let mut req = request();
        req.name = "lumen-debug-new".into();
        let error = create(client(&server), req, || Ok(())).await.unwrap_err();
        assert!(error.to_string().contains("pods/ephemeralcontainers"));
    }
    #[test]
    fn terminal_reopen_requires_original_pod_and_running_container() {
        let running: Pod = serde_json::from_value(with_requested(pod(), "running")).unwrap();
        assert!(verify_terminal(&running, "uid-1", Some("lumen-debug-123")).is_ok());
        assert!(verify_terminal(&running, "replacement", Some("lumen-debug-123")).is_err());
        assert!(verify_terminal(&running, "uid-1", Some("lumen-debug-missing")).is_err());
        for phase in ["waiting", "terminated"] {
            let stopped: Pod = serde_json::from_value(with_requested(pod(), phase)).unwrap();
            assert!(verify_terminal(&stopped, "uid-1", Some("lumen-debug-123")).is_err());
        }
    }
}
