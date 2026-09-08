use crate::error::{AppError, AppResult};
use futures::AsyncReadExt as FuturesAsyncReadExt;
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

#[derive(Debug, Clone, Serialize)]
pub struct BoundedLogCapture {
    pub text: String,
    pub truncated: bool,
    pub bytes: usize,
}

fn capture_params(
    container: String,
    previous: bool,
    tail_lines: Option<i64>,
    limit_bytes: i64,
) -> LogParams {
    LogParams {
        container: Some(container),
        follow: false,
        previous,
        tail_lines,
        limit_bytes: Some(limit_bytes),
        timestamps: true,
        ..Default::default()
    }
}

fn cap_capture_text(mut text: String, limit_bytes: usize) -> (String, bool) {
    let truncated = text.len() >= limit_bytes;
    if text.len() > limit_bytes {
        let mut end = limit_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    (text, truncated)
}

/// Includes client/credential startup, both UID reads, and the finite body read.
/// Keeping the deadline here lets native tests exercise the same boundary as IPC.
pub async fn capture_logs_with_deadline(
    client: impl std::future::Future<Output = AppResult<Client>>,
    selector: LogSelector,
    limit_bytes: i64,
    expected_uid: &str,
    budget: std::time::Duration,
) -> AppResult<BoundedLogCapture> {
    tokio::time::timeout(budget, async {
        capture_logs(client.await?, selector, limit_bytes, expected_uid).await
    })
    .await
    .map_err(|_| AppError::K8s("bounded log capture timed out".into()))?
}

async fn read_bounded_capture(
    stream: impl futures::AsyncRead + Unpin,
    cap: usize,
) -> AppResult<BoundedLogCapture> {
    let mut bytes = Vec::with_capacity(cap + 1);
    stream
        .take((cap + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let transport_truncated = bytes.len() > cap;
    bytes.truncate(cap);
    let (text, utf8_truncated) =
        cap_capture_text(String::from_utf8_lossy(&bytes).into_owned(), cap);
    Ok(BoundedLogCapture {
        bytes: text.len(),
        text,
        truncated: transport_truncated || utf8_truncated,
    })
}

pub async fn capture_logs(
    client: Client,
    selector: LogSelector,
    limit_bytes: i64,
    expected_uid: &str,
) -> AppResult<BoundedLogCapture> {
    let pod = selector
        .pod_name
        .ok_or_else(|| AppError::K8s("pod name required".into()))?;
    let container = selector
        .container
        .ok_or_else(|| AppError::K8s("container required".into()))?;
    let api: Api<Pod> = Api::namespaced(client, &selector.namespace);
    let before_uid = api
        .get(&pod)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?
        .metadata
        .uid;
    if before_uid.as_deref() != Some(expected_uid) {
        return Err(AppError::K8s("pod identity changed before capture".into()));
    }
    let params = capture_params(
        container,
        selector.previous,
        selector.tail_lines,
        limit_bytes,
    );
    let stream = api
        .log_stream(&pod, &params)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let capture = read_bounded_capture(stream, limit_bytes.max(1) as usize).await?;
    let after_uid = api
        .get(&pod)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?
        .metadata
        .uid;
    if after_uid.as_deref() != Some(expected_uid) {
        return Err(AppError::K8s("pod identity changed during capture".into()));
    }
    Ok(capture)
}

#[cfg(test)]
mod bounded_capture_tests {
    use super::*;
    use std::{
        pin::Pin,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
        task::{Context, Poll},
        time::Duration,
    };
    use wiremock::{
        matchers::{method, path},
        Mock, MockServer, ResponseTemplate,
    };

    const POD: &str = "/api/v1/namespaces/ns/pods/api";
    const LOG: &str = "/api/v1/namespaces/ns/pods/api/log";
    const BUDGET: Duration = Duration::from_millis(150);

    fn selector(previous: bool) -> LogSelector {
        LogSelector {
            namespace: "ns".into(),
            pod_name: Some("api".into()),
            container: Some("worker".into()),
            label_selector: None,
            since_seconds: None,
            tail_lines: Some(201),
            previous,
        }
    }

    fn client(uri: &str) -> Client {
        Client::try_from(kube::Config::new(uri.parse().unwrap())).unwrap()
    }

    fn pod_response(uid: &str) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": {"name": "api", "namespace": "ns", "uid": uid}
        }))
    }

    async fn mount_pod(server: &MockServer) {
        Mock::given(method("GET"))
            .and(path(POD))
            .respond_with(pod_response("original"))
            .mount(server)
            .await;
    }

    async fn capture(server: &MockServer, previous: bool) -> AppResult<BoundedLogCapture> {
        capture_logs_with_deadline(
            async { Ok(client(&server.uri())) },
            selector(previous),
            20_000,
            "original",
            Duration::from_secs(2),
        )
        .await
    }

    fn assert_timeout(result: AppResult<BoundedLogCapture>) {
        let error =
            result.expect_err("deadline must reject, never return captured partial/empty text");
        assert!(
            error.to_string().contains("bounded log capture timed out"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn http_current_and_previous_request_finite_selected_container_and_bounds() {
        for previous in [false, true] {
            let server = MockServer::start().await;
            mount_pod(&server).await;
            Mock::given(method("GET"))
                .and(path(LOG))
                .respond_with(ResponseTemplate::new(200).set_body_string("line\n"))
                .expect(1)
                .mount(&server)
                .await;
            let result = capture(&server, previous).await.unwrap();
            assert_eq!(result.text, "line\n");
            let requests = server.received_requests().await.unwrap();
            assert_eq!(
                requests.iter().map(|r| r.url.path()).collect::<Vec<_>>(),
                [POD, LOG, POD]
            );
            let query: std::collections::HashMap<_, _> = requests[1].url.query_pairs().collect();
            assert_eq!(query.get("container").map(|s| s.as_ref()), Some("worker"));
            assert_eq!(query.get("tailLines").map(|s| s.as_ref()), Some("201"));
            assert_eq!(query.get("limitBytes").map(|s| s.as_ref()), Some("20000"));
            assert_eq!(query.get("timestamps").map(|s| s.as_ref()), Some("true"));
            // Kubernetes defaults omitted booleans to false.
            assert_ne!(query.get("follow").map(|s| s.as_ref()), Some("true"));
            assert_eq!(query.get("previous").is_some_and(|s| s == "true"), previous);
        }
    }

    #[tokio::test]
    async fn http_empty_eof_is_successful_empty_capture() {
        let server = MockServer::start().await;
        mount_pod(&server).await;
        Mock::given(path(LOG))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(Vec::new()))
            .mount(&server)
            .await;
        let result = capture(&server, false).await.unwrap();
        assert_eq!(result.text, "");
        assert_eq!(result.bytes, 0);
        assert!(!result.truncated);
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn http_nonempty_eof_retains_text_without_truncation() {
        let server = MockServer::start().await;
        mount_pod(&server).await;
        let text = "2026-09-08T00:00:00Z café\nlast line without newline";
        Mock::given(path(LOG))
            .respond_with(ResponseTemplate::new(200).set_body_string(text))
            .mount(&server)
            .await;
        let result = capture(&server, true).await.unwrap();
        assert_eq!(result.text, text);
        assert_eq!(result.bytes, text.len());
        assert!(!result.truncated);
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn http_oversized_single_line_ignoring_server_limit_is_locally_bounded() {
        let server = MockServer::start().await;
        mount_pod(&server).await;
        let body = format!("{}{}", "a".repeat(19_999), "é".repeat(50_000));
        Mock::given(path(LOG))
            .respond_with(ResponseTemplate::new(200).set_body_string(body))
            .mount(&server)
            .await;
        let result = capture(&server, false).await.unwrap();
        assert_eq!(result.text, "a".repeat(19_999));
        assert_eq!(result.bytes, 19_999);
        assert!(result.truncated);
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    struct CountingReader {
        body: Vec<u8>,
        consumed: Arc<AtomicUsize>,
        dropped: Arc<AtomicBool>,
        chunk_size: usize,
    }
    impl futures::AsyncRead for CountingReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            buf: &mut [u8],
        ) -> Poll<std::io::Result<usize>> {
            let consumed = self.consumed.load(Ordering::SeqCst);
            let count = buf
                .len()
                .min(self.chunk_size)
                .min(self.body.len() - consumed);
            buf[..count].copy_from_slice(&self.body[consumed..consumed + count]);
            self.consumed.fetch_add(count, Ordering::SeqCst);
            Poll::Ready(Ok(count))
        }
    }
    impl Drop for CountingReader {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn production_reader_consumes_only_20001_bytes_and_drops_split_utf8_body() {
        // One-byte chunks split every multibyte code point across read calls.
        for chunk_size in [1, 65_536] {
            let consumed = Arc::new(AtomicUsize::new(0));
            let dropped = Arc::new(AtomicBool::new(false));
            let reader = CountingReader {
                body: format!("{}{}", "a".repeat(19_999), "é".repeat(50_000)).into_bytes(),
                consumed: consumed.clone(),
                dropped: dropped.clone(),
                chunk_size,
            };
            let result = read_bounded_capture(reader, 20_000).await.unwrap();
            assert_eq!(consumed.load(Ordering::SeqCst), 20_001);
            assert!(dropped.load(Ordering::SeqCst));
            assert_eq!(result.text, "a".repeat(19_999));
            assert!(result.truncated);
            assert!(!result.text.contains('\u{fffd}'));
        }
    }

    #[tokio::test]
    async fn uid_mismatch_before_read_rejects_without_requesting_logs() {
        let server = MockServer::start().await;
        Mock::given(path(POD))
            .respond_with(pod_response("replacement"))
            .mount(&server)
            .await;
        let error = capture(&server, false).await.unwrap_err();
        assert!(error
            .to_string()
            .contains("identity changed before capture"));
        let requests = server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].url.path(), POD);
    }

    #[tokio::test]
    async fn uid_mismatch_after_read_rejects_instead_of_returning_collected_text() {
        let server = MockServer::start().await;
        let reads = Arc::new(AtomicUsize::new(0));
        Mock::given(path(POD))
            .respond_with(move |_: &wiremock::Request| {
                pod_response(if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                    "original"
                } else {
                    "replacement"
                })
            })
            .mount(&server)
            .await;
        Mock::given(path(LOG))
            .respond_with(ResponseTemplate::new(200).set_body_string("collected"))
            .mount(&server)
            .await;
        let error = capture(&server, false).await.unwrap_err();
        assert!(error
            .to_string()
            .contains("identity changed during capture"));
        assert_eq!(server.received_requests().await.unwrap().len(), 3);
    }

    struct DropFlag(Arc<AtomicBool>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn deadline_includes_client_startup_and_cancels_pending_startup() {
        let dropped = Arc::new(AtomicBool::new(false));
        let flag = dropped.clone();
        let startup = async move {
            let _guard = DropFlag(flag);
            std::future::pending::<AppResult<Client>>().await
        };
        assert_timeout(
            capture_logs_with_deadline(startup, selector(false), 20_000, "original", BUDGET).await,
        );
        assert!(dropped.load(Ordering::SeqCst));
    }

    async fn assert_stalled_http_stage(stage: usize) {
        let server = MockServer::start().await;
        let reads = Arc::new(AtomicUsize::new(0));
        Mock::given(path(POD))
            .respond_with(move |_: &wiremock::Request| {
                let index = reads.fetch_add(1, Ordering::SeqCst);
                let response = pod_response("original");
                if (stage == 0 && index == 0) || (stage == 2 && index == 1) {
                    response.set_delay(Duration::from_secs(10))
                } else {
                    response
                }
            })
            .mount(&server)
            .await;
        let response = ResponseTemplate::new(200).set_body_string("collected");
        Mock::given(path(LOG))
            .respond_with(if stage == 1 {
                response.set_delay(Duration::from_secs(10))
            } else {
                response
            })
            .mount(&server)
            .await;
        assert_timeout(
            capture_logs_with_deadline(
                async { Ok(client(&server.uri())) },
                selector(false),
                20_000,
                "original",
                BUDGET,
            )
            .await,
        );
        assert_eq!(server.received_requests().await.unwrap().len(), stage + 1);
    }

    #[tokio::test]
    async fn deadline_includes_stalled_pre_read_uid_request() {
        assert_stalled_http_stage(0).await;
    }
    #[tokio::test]
    async fn deadline_includes_stalled_log_response_startup() {
        assert_stalled_http_stage(1).await;
    }
    #[tokio::test]
    async fn deadline_includes_stalled_post_read_uid_request() {
        assert_stalled_http_stage(2).await;
    }

    #[tokio::test]
    async fn deadline_rejects_partial_body_and_drops_stream_without_post_read() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let uri = format!("http://{}", listener.local_addr().unwrap());
        let partial_sent = Arc::new(AtomicBool::new(false));
        let sent = partial_sent.clone();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = requests.clone();
        let (closed_tx, closed_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            assert!(String::from_utf8_lossy(&request).starts_with(&format!("GET {POD} ")));
            count.fetch_add(1, Ordering::SeqCst);
            let pod =
                serde_json::json!({"apiVersion":"v1", "kind":"Pod", "metadata":{"uid":"original"}})
                    .to_string();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{pod}", pod.len()).as_bytes()).await.unwrap();
            drop(socket);
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(socket.read_u8().await.unwrap());
            }
            assert!(String::from_utf8_lossy(&request).starts_with(&format!("GET {LOG}?")));
            count.fetch_add(1, Ordering::SeqCst);
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n7\r\npartial\r\n").await.unwrap();
            sent.store(true, Ordering::SeqCst);
            // No terminal chunk: keep the body pending until cancellation closes it.
            let mut byte = [0];
            let closed = matches!(socket.read(&mut byte).await, Ok(0) | Err(_));
            let _ = closed_tx.send(closed);
        });
        assert_timeout(
            capture_logs_with_deadline(
                async { Ok(client(&uri)) },
                selector(false),
                20_000,
                "original",
                BUDGET,
            )
            .await,
        );
        assert!(partial_sent.load(Ordering::SeqCst));
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        // This timeout only bounds fixture cleanup; production rejection was asserted above.
        assert!(tokio::time::timeout(Duration::from_secs(1), closed_rx)
            .await
            .unwrap()
            .unwrap());
        server.await.unwrap();
    }
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
