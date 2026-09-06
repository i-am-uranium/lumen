use crate::error::{AppError, AppResult};
use k8s_openapi::api::core::v1::Pod;
use kube::{
    api::{Api, ListParams, LogParams},
    Client,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::AsyncBufReadExt;
use tokio_util::compat::FuturesAsyncReadCompatExt;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub pod: String,
    pub container: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LogSelector {
    pub namespace: String,
    pub label_selector: Option<String>,
    pub pod_name: Option<String>,
    pub container: Option<String>,
    pub since_seconds: Option<i64>,
    pub tail_lines: Option<i64>,
    /// When true, request logs from the previously terminated container
    /// (kubectl's `--previous`). Implies `follow=false` and ignores
    /// `since_seconds` — there's nothing to follow on a dead container
    /// and the kubelet only retains a single previous log slice.
    #[serde(default)]
    pub previous: bool,
}

/// Known service-mesh / observability sidecar container names. When a pod has
/// no `kubectl.kubernetes.io/default-container` annotation, we skip these to
/// pick the application container first.
const SIDECAR_NAMES: &[&str] = &[
    "istio-proxy",
    "istio-init",
    "linkerd-proxy",
    "linkerd-init",
    "envoy",
    "secret-agent",
    "cloud-sql-proxy",
    "otel-agent",
];

/// Pick a container for a pod when the caller didn't specify one. Matches
/// `kubectl logs` behaviour: honour the `default-container` annotation, then
/// prefer the first non-sidecar container, falling back to the first.
async fn pick_container(client: &Client, namespace: &str, pod_name: &str) -> Option<String> {
    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pod = api.get(pod_name).await.ok()?;
    if let Some(ann) = pod.metadata.annotations.as_ref() {
        if let Some(v) = ann.get("kubectl.kubernetes.io/default-container") {
            return Some(v.clone());
        }
    }
    let spec = pod.spec?;
    let containers = spec.containers;
    for c in &containers {
        if !SIDECAR_NAMES.iter().any(|s| c.name.contains(s)) {
            return Some(c.name.clone());
        }
    }
    containers.first().map(|c| c.name.clone())
}

/// Lines retain their existing wire shape; status events are separate from log text.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum LogEvent {
    Line(LogLine),
    Status {
        #[serde(rename = "type")]
        event_type: &'static str,
        pod: String,
        status: &'static str,
        message: Option<String>,
    },
}

pub fn emit_status(
    channel: &Channel<LogEvent>,
    pod: &str,
    status: &'static str,
    message: Option<String>,
) {
    let _ = channel.send(LogEvent::Status {
        event_type: "status",
        pod: pod.into(),
        status,
        message,
    });
}

const MAX_RETRIES: u32 = 8;
fn retry_delay(attempt: u32) -> std::time::Duration {
    std::time::Duration::from_secs((1u64 << attempt.min(4)).min(15))
}

fn permanent_error(error: &kube::Error) -> bool {
    matches!(error, kube::Error::Api(response) if matches!(response.code, 401 | 403 | 404 | 422))
}

/// Kubernetes sinceTime is serialized at second precision. Request the start
/// of the last second, then suppress the exact prefix already delivered. Keep
/// only a timestamp and count, so resume bookkeeping cannot grow with logs.
#[derive(Default)]
struct ResumeCursor {
    last: Option<(chrono::DateTime<chrono::Utc>, usize)>,
}
impl ResumeCursor {
    fn apply(&self, params: &mut LogParams) {
        if let Some((time, _)) = self.last {
            let second = chrono::DateTime::from_timestamp(time.timestamp(), 0).unwrap();
            params.since_time = second.to_rfc3339().parse().ok();
            params.since_seconds = None;
            params.tail_lines = None;
        }
    }

    fn accept(
        &mut self,
        text: &str,
        replay: &mut Option<(chrono::DateTime<chrono::Utc>, usize)>,
    ) -> bool {
        let Some(time) = text
            .split_once(' ')
            .and_then(|(ts, _)| chrono::DateTime::parse_from_rfc3339(ts).ok())
            .map(|t| t.with_timezone(&chrono::Utc))
        else {
            return true;
        };
        if let Some((boundary, remaining)) = replay {
            if time < *boundary {
                return false;
            }
            if time == *boundary && *remaining > 0 {
                *remaining -= 1;
                return false;
            }
        }
        match &mut self.last {
            Some((last, count)) if *last == time => *count += 1,
            Some((last, _)) if *last > time => {}
            _ => self.last = Some((time, 1)),
        }
        true
    }
}

async fn tail_one_pod(
    client: Client,
    namespace: String,
    pod: String,
    container: Option<String>,
    mut params: LogParams,
    channel: Channel<LogEvent>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let resolved_container = tokio::select! {
        _ = cancel.cancelled() => return Ok(()),
        container = async {
            match container { Some(c) => Some(c), None => pick_container(&client, &namespace, &pod).await }
        } => container,
    };
    params.container = resolved_container.clone();
    params.timestamps = true;
    let mut cursor = ResumeCursor::default();
    let mut retries = 0;
    loop {
        if cancel.is_cancelled() {
            return Ok(());
        }
        if retries == 0 {
            emit_status(&channel, &pod, "connecting", None);
        }
        let mut request = params.clone();
        cursor.apply(&mut request);
        let opened = tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            result = api.log_stream(&pod, &request) => result,
        };
        if cancel.is_cancelled() {
            return Ok(());
        }
        let failure = match opened {
            Ok(stream) => {
                emit_status(&channel, &pod, "live", None);
                let mut lines = stream.compat().lines();
                let mut replay = cursor.last;
                loop {
                    let line = tokio::select! {
                        _ = cancel.cancelled() => return Ok(()),
                        line = lines.next_line() => line,
                    };
                    match line {
                        Ok(Some(text)) => {
                            let checkpoint = cursor.last;
                            if !cursor.accept(&text, &mut replay) {
                                continue;
                            }
                            if cursor.last != checkpoint {
                                retries = 0;
                            }
                            if channel
                                .send(LogEvent::Line(LogLine {
                                    pod: pod.clone(),
                                    container: resolved_container.clone().unwrap_or_default(),
                                    text,
                                }))
                                .is_err()
                            {
                                return Ok(());
                            }
                        }
                        Ok(None) if !params.follow || params.previous => {
                            emit_status(&channel, &pod, "ended", None);
                            return Ok(());
                        }
                        Ok(None) => {
                            break "Log connection closed; waiting for the container to resume"
                                .to_string()
                        }
                        Err(error) => break format!("Log connection interrupted: {error}"),
                    }
                }
            }
            Err(error) => {
                let message = format!("Could not open logs for {pod}: {error}");
                if permanent_error(&error) || params.previous {
                    emit_status(&channel, &pod, "error", Some(message.clone()));
                    return Err(AppError::K8s(message));
                }
                message
            }
        };
        if !params.follow || params.previous {
            emit_status(&channel, &pod, "error", Some(failure.clone()));
            return Err(AppError::K8s(failure));
        }
        if retries >= MAX_RETRIES {
            let message = format!("{failure}. Reconnect limit reached; reopen logs to try again.");
            emit_status(&channel, &pod, "error", Some(message.clone()));
            return Err(AppError::K8s(message));
        }
        let delay = retry_delay(retries);
        retries += 1;
        emit_status(
            &channel,
            &pod,
            "retrying",
            Some(format!(
                "{failure}. Retry {retries}/{MAX_RETRIES} in {}s",
                delay.as_secs()
            )),
        );
        tokio::select! {
            _ = cancel.cancelled() => return Ok(()),
            _ = tokio::time::sleep(delay) => {},
        }
    }
}

async fn list_pods_by_selector(
    client: &Client,
    namespace: &str,
    label_selector: &str,
) -> AppResult<Vec<(String, String)>> {
    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default().labels(label_selector);
    Ok(api
        .list(&lp)
        .await
        .map_err(|e| {
            if permanent_error(&e) {
                AppError::PermissionDenied(e.to_string())
            } else {
                AppError::K8s(e.to_string())
            }
        })?
        .items
        .into_iter()
        .filter_map(|p| {
            p.metadata
                .name
                .map(|name| (name, p.metadata.uid.unwrap_or_default()))
        })
        .collect())
}

pub async fn stream_logs(
    client: Client,
    selector: LogSelector,
    channel: Channel<LogEvent>,
    cancel: CancellationToken,
) -> AppResult<()> {
    // Previous-pod mode is a one-shot read of the kubelet's retained
    // log slice for the last terminated container. Following makes no
    // sense (nothing is writing), and slicing by since_seconds against
    // a frozen log only confuses operators digging through a crash.
    let params = if selector.previous {
        LogParams {
            previous: true,
            follow: false,
            tail_lines: selector.tail_lines,
            since_seconds: None,
            ..Default::default()
        }
    } else {
        LogParams {
            follow: true,
            tail_lines: selector.tail_lines.or(Some(200)),
            since_seconds: selector.since_seconds,
            ..Default::default()
        }
    };

    // Single-pod path: the reader handles reconnects without selector polling.
    if let Some(pod) = selector.pod_name.clone() {
        return tail_one_pod(
            client,
            selector.namespace.clone(),
            pod,
            selector.container.clone(),
            params,
            channel,
            cancel,
        )
        .await;
    }

    // Label-selector path: fan out + rescan every 5s so rollouts pick up new pods.
    let label_selector = selector
        .label_selector
        .clone()
        .ok_or_else(|| AppError::K8s("log selector requires pod_name or label_selector".into()))?;

    let mut tailed = std::collections::HashMap::<String, (String, CancellationToken)>::new();
    let mut tasks = tokio::task::JoinSet::new();
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    let mut list_failures = 0;
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            result = tasks.join_next(), if !tasks.is_empty() => {
                if let Some(Err(error)) = result {
                    emit_status(&channel, "", "error", Some(format!("Log reader stopped unexpectedly: {error}")));
                }
            },
            _ = interval.tick() => {
                let current = tokio::select! {
                    _ = cancel.cancelled() => break,
                    result = list_pods_by_selector(&client, &selector.namespace, &label_selector) => result,
                };
                let current = match current {
                    Ok(pods) => { list_failures = 0; pods },
                    Err(error) => {
                        list_failures += 1;
                        if list_failures >= MAX_RETRIES || matches!(error, AppError::PermissionDenied(_)) {
                            tasks.abort_all();
                            while tasks.join_next().await.is_some() {}
                            return Err(error);
                        }
                        emit_status(&channel, "", "retrying", Some(format!("Could not discover pods: {error}")));
                        continue;
                    }
                };
                // Stop departed pods; remove their identities so a later replacement
                // with the same name gets its own reader and resume cursor.
                tailed.retain(|pod, (uid, token)| {
                    if current.iter().any(|(name, current_uid)| name == pod && current_uid == uid) { true } else {
                        token.cancel();
                        emit_status(&channel, pod, "ended", None);
                        false
                    }
                });
                emit_status(&channel, "", "connecting", Some(if current.is_empty() {
                    format!("No pods match {label_selector}; watching for new pods")
                } else { "Watching matching pods".into() }));
                for (pod, uid) in current {
                    if tailed.contains_key(&pod) { continue; }
                    let child = cancel.child_token();
                    tailed.insert(pod.clone(), (uid, child.clone()));
                    tasks.spawn(tail_one_pod(
                        client.clone(), selector.namespace.clone(), pod,
                        selector.container.clone(), params.clone(), channel.clone(), child,
                    ));
                }
                if selector.previous {
                    // Previous logs are finite, including selector fan-out.
                    let mut failure = None;
                    while let Some(result) = tasks.join_next().await {
                        match result {
                            Ok(Err(error)) => failure = Some(error),
                            Err(error) => failure = Some(AppError::K8s(error.to_string())),
                            _ => {}
                        }
                    }
                    return failure.map_or(Ok(()), Err);
                }
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    #[tokio::test]
    async fn reconnects_after_eof_and_resumes_without_replaying_history() {
        let server = MockServer::start().await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        Mock::given(method("GET"))
            .and(path("/api/v1/namespaces/ns/pods/api/log"))
            .respond_with(move |_: &wiremock::Request| {
                let attempt = count.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(200).set_body_string(if attempt == 0 {
                    "2026-01-01T00:00:00.123456789Z first\n"
                } else {
                    "2026-01-01T00:00:00.123456789Z first\n2026-01-01T00:00:01Z recovered\n"
                })
            })
            .mount(&server)
            .await;
        let cancel = CancellationToken::new();
        let received = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let output = received.clone();
        let stop = cancel.clone();
        let channel = Channel::new(move |body| {
            let value: serde_json::Value = match body {
                tauri::ipc::InvokeResponseBody::Json(json) => serde_json::from_str(&json).unwrap(),
                _ => panic!("expected JSON"),
            };
            if value["text"]
                .as_str()
                .is_some_and(|s| s.contains("recovered"))
            {
                stop.cancel();
            }
            output.lock().unwrap().push(value);
            Ok(())
        });
        let client = Client::try_from(kube::Config::new(server.uri().parse().unwrap())).unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tail_one_pod(
                client,
                "ns".into(),
                "api".into(),
                Some("app".into()),
                LogParams {
                    follow: true,
                    ..Default::default()
                },
                channel,
                cancel,
            ),
        )
        .await;
        assert!(result.is_ok());
        assert!(
            attempts.load(Ordering::SeqCst) >= 2,
            "EOF must reopen the stream"
        );
        {
            let values = received.lock().unwrap();
            assert_eq!(
                values
                    .iter()
                    .filter(|v| v["text"].as_str().is_some_and(|s| s.contains("first")))
                    .count(),
                1
            );
            assert!(values.iter().any(|v| v["status"] == "retrying"));
        }
        let requests = server.received_requests().await.unwrap();
        assert!(requests[1].url.query_pairs().any(|(k, _)| k == "sinceTime"));
    }
    fn capture_channel() -> (Channel<LogEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = events.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                output
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, events)
    }

    #[tokio::test]
    async fn permission_denied_is_terminal_without_retry() {
        let server = MockServer::start().await;
        Mock::given(method("GET")).respond_with(ResponseTemplate::new(403).set_body_json(serde_json::json!({
            "apiVersion": "v1", "kind": "Status", "status": "Failure", "message": "forbidden", "reason": "Forbidden", "code": 403
        }))).expect(1).mount(&server).await;
        let (channel, events) = capture_channel();
        let client = Client::try_from(kube::Config::new(server.uri().parse().unwrap())).unwrap();
        let result = tail_one_pod(
            client,
            "ns".into(),
            "api".into(),
            Some("app".into()),
            LogParams {
                follow: true,
                ..Default::default()
            },
            channel,
            CancellationToken::new(),
        )
        .await;
        assert!(result.is_err());
        let events = events.lock().unwrap();
        assert_eq!(events.last().unwrap()["status"], "error");
        assert!(!events.iter().any(|event| event["status"] == "retrying"));
    }

    #[tokio::test]
    async fn previous_logs_complete_at_eof_without_retry() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_string("2026-01-01T00:00:00Z previous\n"),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (channel, events) = capture_channel();
        let client = Client::try_from(kube::Config::new(server.uri().parse().unwrap())).unwrap();
        stream_logs(
            client,
            LogSelector {
                namespace: "ns".into(),
                pod_name: Some("api".into()),
                label_selector: None,
                container: Some("app".into()),
                since_seconds: Some(600),
                tail_lines: None,
                previous: true,
            },
            channel,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(events.lock().unwrap().last().unwrap()["status"], "ended");
        let requests = server.received_requests().await.unwrap();
        assert!(requests[0]
            .url
            .query_pairs()
            .any(|(key, value)| key == "previous" && value == "true"));
        assert!(!requests[0]
            .url
            .query_pairs()
            .any(|(key, _)| key == "sinceSeconds" || key == "follow"));
    }

    #[tokio::test]
    async fn cancellation_interrupts_retry_backoff() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_string(""))
            .expect(1)
            .mount(&server)
            .await;
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                let event: serde_json::Value = serde_json::from_str(&json).unwrap();
                if event["status"] == "retrying" {
                    stop.cancel();
                }
            }
            Ok(())
        });
        let client = Client::try_from(kube::Config::new(server.uri().parse().unwrap())).unwrap();
        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            tail_one_pod(
                client,
                "ns".into(),
                "api".into(),
                Some("app".into()),
                LogParams {
                    follow: true,
                    ..Default::default()
                },
                channel,
                cancel,
            ),
        )
        .await
        .unwrap()
        .unwrap();
    }

    #[test]
    fn resume_preserves_new_lines_at_the_same_timestamp() {
        let mut cursor = ResumeCursor::default();
        let mut replay = None;
        assert!(cursor.accept("2026-01-01T00:00:00.999Z first", &mut replay));
        assert!(cursor.accept("2026-01-01T00:00:00.999Z second", &mut replay));
        let mut request = LogParams {
            since_seconds: Some(600),
            tail_lines: Some(200),
            ..Default::default()
        };
        cursor.apply(&mut request);
        assert_eq!(
            request.since_time.unwrap().to_string(),
            "2026-01-01T00:00:00Z"
        );
        assert!(request.since_seconds.is_none());
        assert!(request.tail_lines.is_none());
        replay = cursor.last;
        assert!(!cursor.accept("2026-01-01T00:00:00.500Z older", &mut replay));
        assert!(!cursor.accept("2026-01-01T00:00:00.999Z first", &mut replay));
        assert!(!cursor.accept("2026-01-01T00:00:00.999Z second", &mut replay));
        assert!(cursor.accept("2026-01-01T00:00:00.999Z third", &mut replay));
    }

    #[test]
    fn retry_delay_is_capped() {
        assert_eq!(retry_delay(0).as_secs(), 1);
        assert_eq!(retry_delay(3).as_secs(), 8);
        assert_eq!(retry_delay(8).as_secs(), 15);
        assert_eq!(retry_delay(u32::MAX).as_secs(), 15);
    }
    #[tokio::test]
    async fn selector_replaces_a_terminal_reader_when_the_pod_uid_changes() {
        let server = MockServer::start().await;
        let listed = Arc::new(AtomicUsize::new(0));
        let count = listed.clone();
        Mock::given(path("/api/v1/namespaces/ns/pods"))
            .respond_with(move |_: &wiremock::Request| {
                let uid = if count.fetch_add(1, Ordering::SeqCst) == 0 {
                    "old"
                } else {
                    "new"
                };
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "apiVersion":"v1", "kind":"PodList", "metadata":{},
                    "items":[{"apiVersion":"v1", "kind":"Pod", "metadata":{"name":"api","uid":uid}}]
                }))
            })
            .mount(&server)
            .await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let count = attempts.clone();
        Mock::given(path("/api/v1/namespaces/ns/pods/api/log")).respond_with(move |_: &wiremock::Request| {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                ResponseTemplate::new(404).set_body_json(serde_json::json!({"kind":"Status", "apiVersion":"v1", "code":404, "message":"gone", "reason":"NotFound", "status":"Failure"}))
            } else {
                ResponseTemplate::new(200).set_body_string("2026-01-01T00:00:00Z replacement\n")
            }
        }).mount(&server).await;
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                if json.contains("replacement") {
                    stop.cancel();
                }
            }
            Ok(())
        });
        let client = Client::try_from(kube::Config::new(server.uri().parse().unwrap())).unwrap();
        let completed = tokio::time::timeout(
            std::time::Duration::from_secs(7),
            stream_logs(
                client,
                LogSelector {
                    namespace: "ns".into(),
                    label_selector: Some("app=api".into()),
                    pod_name: None,
                    container: Some("app".into()),
                    since_seconds: None,
                    tail_lines: None,
                    previous: false,
                },
                channel,
                cancel,
            ),
        )
        .await;
        assert!(
            completed.is_ok(),
            "a new pod UID must get a fresh reader even when its name is unchanged"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }
}
