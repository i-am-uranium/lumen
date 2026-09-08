//! Interactive pod-attach sessions (kubectl-exec equivalent) over Tauri IPC.
//!
//! One session = one SPDY exec subresource on a pod, optionally with a TTY.
//! The session is plumbed between Rust and the frontend like so:
//!
//!   frontend keyboard -> write_stdin command -> session.stdin_tx
//!   pod stdout/stderr -> Tauri Channel -> xterm.js
//!   frontend resize   -> resize command -> session.resize_tx
//!   frontend close    -> close command -> cancel token
//!
//! Sessions live in a process-wide registry on AppState so the UI can
//! target them by id and clean up on unmount.

use crate::error::{AppError, AppResult};
use futures::SinkExt;
use k8s_openapi::api::core::v1::Pod;
use kube::{
    api::{AttachParams, TerminalSize},
    Api, Client,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, RwLock};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AttachEvent {
    Stdout {
        text: String,
    },
    Stderr {
        text: String,
    },
    Closed {
        message: Option<String>,
        exit_code: Option<i32>,
    },
}

#[derive(Clone)]
pub struct SessionProtection {
    pub context: String,
    pub identity: String,
    pub policy: Arc<crate::protection::ContextProtectionPolicy>,
}
impl SessionProtection {
    fn authorize(&self) -> AppResult<()> {
        let (_, current) = crate::protection::load_target(&self.context).inspect_err(|_| {
            let _ = self.policy.lock(&self.context, "");
        })?;
        if current != self.identity {
            // Observing replacement revokes the grant, even if the old config
            // is subsequently restored.
            let _ = self.policy.lock(&self.context, &current);
            return Err(AppError::PermissionDenied(
                "Exec context configuration changed; open a new session".into(),
            ));
        }
        self.policy
            .require_mutation(&self.context, &self.identity, false)
    }
}

struct Session {
    protection: SessionProtection,
    stdin_tx: mpsc::UnboundedSender<Vec<u8>>,
    resize_tx: mpsc::UnboundedSender<(u16, u16)>,
    cancel: CancellationToken,
}

#[derive(Default)]
pub struct AttachRegistry {
    sessions: RwLock<HashMap<String, Session>>,
}

impl AttachRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    async fn insert(&self, id: String, session: Session) {
        self.sessions.write().await.insert(id, session);
    }

    async fn take(&self, id: &str) -> Option<Session> {
        self.sessions.write().await.remove(id)
    }

    pub async fn write_stdin(&self, id: &str, bytes: Vec<u8>) -> AppResult<()> {
        let map = self.sessions.read().await;
        let sess = map
            .get(id)
            .ok_or_else(|| AppError::K8s(format!("attach session {id} not found")))?;
        if let Err(error) = sess.protection.authorize() {
            sess.cancel.cancel();
            return Err(error);
        }
        sess.stdin_tx
            .send(bytes)
            .map_err(|e| AppError::K8s(format!("stdin queue closed: {e}")))
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let map = self.sessions.read().await;
        let sess = map
            .get(id)
            .ok_or_else(|| AppError::K8s(format!("attach session {id} not found")))?;
        if let Err(error) = sess.protection.authorize() {
            sess.cancel.cancel();
            return Err(error);
        }
        sess.resize_tx
            .send((cols, rows))
            .map_err(|e| AppError::K8s(format!("resize queue closed: {e}")))
    }

    pub async fn close(&self, id: &str) {
        if let Some(s) = self.take(id).await {
            s.cancel.cancel();
        }
    }

    pub async fn close_context(&self, context: &str) {
        let mut map = self.sessions.write().await;
        map.retain(|_, session| {
            if session.protection.context == context {
                session.cancel.cancel();
                false
            } else {
                true
            }
        });
    }

    pub async fn close_all(&self) {
        let mut m = self.sessions.write().await;
        for (_, s) in m.drain() {
            s.cancel.cancel();
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct StartAttachRequest {
    pub namespace: String,
    pub pod: String,
    #[serde(default)]
    pub pod_uid: Option<String>,
    pub container: Option<String>,
    pub command: Vec<String>,
    pub tty: bool,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

pub async fn start(
    client: Client,
    registry: Arc<AttachRegistry>,
    req: StartAttachRequest,
    channel: Channel<AttachEvent>,
    protection: SessionProtection,
) -> AppResult<String> {
    if req.command.is_empty() {
        return Err(AppError::K8s("attach command cannot be empty".into()));
    }

    let id = format!(
        "attach-{}-{}-{}",
        req.namespace,
        req.pod,
        chrono::Utc::now().timestamp_millis()
    );

    let mut ap = AttachParams::default()
        .stdin(true)
        .stdout(true)
        .stderr(!req.tty)
        .tty(req.tty);
    if let Some(c) = &req.container {
        ap = ap.container(c.clone());
    }

    let api: Api<Pod> = Api::namespaced(client, &req.namespace);
    if req.pod_uid.is_some()
        || req
            .container
            .as_deref()
            .is_some_and(|c| c.starts_with("lumen-debug-"))
    {
        let uid = req
            .pod_uid
            .as_deref()
            .filter(|uid| !uid.is_empty())
            .ok_or_else(|| {
                AppError::Conflict(
                    "Debug terminal requires the captured pod UID. Reopen it from Debug container."
                        .into(),
                )
            })?;
        let pod = tokio::time::timeout(std::time::Duration::from_secs(10), api.get(&req.pod))
            .await
            .map_err(|_| AppError::Network("Timed out checking debug pod identity".into()))?
            .map_err(|e| AppError::K8s(e.to_string()))?;
        crate::k8s::debug::verify_terminal(&pod, uid, req.container.as_deref())?;
    }
    protection.authorize()?;
    let mut attached = api
        .exec(&req.pod, &req.command, &ap)
        .await
        .map_err(|e| AppError::K8s(format!("attach: {e}")))?;

    let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let cancel = CancellationToken::new();

    registry
        .insert(
            id.clone(),
            Session {
                protection: protection.clone(),
                stdin_tx,
                resize_tx,
                cancel: cancel.clone(),
            },
        )
        .await;

    let stdout = attached.stdout();
    let stderr = attached.stderr();
    let mut stdin = attached.stdin();
    let mut resize_sink = attached.terminal_size();
    // `take_status` drains the SPDY error-stream Status frame the kubelet
    // sends after the process exits. It carries the exit code under
    // `details.causes[*].message` when reason="ExitCode" — that's how
    // kubectl reports `command terminated with exit code N`.
    let status_fut = attached.take_status();

    if req.tty {
        if let (Some(c), Some(r)) = (req.cols, req.rows) {
            if let Some(sink) = resize_sink.as_mut() {
                let _ = sink
                    .send(TerminalSize {
                        width: c,
                        height: r,
                    })
                    .await;
            }
        }
    }

    let registry_clone = registry.clone();
    let id_clone = id.clone();
    let channel_for_task = channel.clone();
    let cancel_task = cancel.clone();

    tokio::spawn(async move {
        let mut stdout_task = stdout.map(|mut out| {
            let ch = channel_for_task.clone();
            let c = cancel_task.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                loop {
                    tokio::select! {
                        _ = c.cancelled() => break,
                        r = out.read(&mut buf) => match r {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let _ = ch.send(AttachEvent::Stdout {
                                    text: String::from_utf8_lossy(&buf[..n]).into_owned(),
                                });
                            }
                        }
                    }
                }
            })
        });

        let mut stderr_task = stderr.map(|mut err| {
            let ch = channel_for_task.clone();
            let c = cancel_task.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                loop {
                    tokio::select! {
                        _ = c.cancelled() => break,
                        r = err.read(&mut buf) => match r {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let _ = ch.send(AttachEvent::Stderr {
                                    text: String::from_utf8_lossy(&buf[..n]).into_owned(),
                                });
                            }
                        }
                    }
                }
            })
        });

        // The watchdog runs independently so a blocked socket write cannot
        // postpone expiry or keep an already-locked exec session alive.
        let watch_cancel = cancel_task.clone();
        let watch_protection = protection.clone();
        let watchdog = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(250));
            loop {
                tokio::select! {
                    _ = watch_cancel.cancelled() => break,
                    _ = interval.tick() => {
                        if watch_protection.authorize().is_err() { watch_cancel.cancel(); break; }
                    }
                }
            }
        });
        loop {
            tokio::select! {
                biased;
                _ = cancel_task.cancelled() => break,
                bytes = stdin_rx.recv() => {
                    let Some(bytes) = bytes else { break };
                    if protection.authorize().is_err() { cancel_task.cancel(); break; }
                    if let Some(sin) = stdin.as_mut() {
                        let write = async { sin.write_all(&bytes).await?; sin.flush().await };
                        tokio::select! {
                            _ = cancel_task.cancelled() => break,
                            result = write => if result.is_err() { break; },
                        }
                    }
                }
                sz = resize_rx.recv() => {
                    let Some((c, r)) = sz else { break };
                    if let Some(sink) = resize_sink.as_mut() {
                        tokio::select! {
                            _ = cancel_task.cancelled() => break,
                            _ = sink.send(TerminalSize { width: c, height: r }) => {},
                        }
                    }
                }
            }
        }

        // Cancellation must tear down the websocket instead of waiting for a
        // remote shell to exit (which may never happen).
        if cancel_task.is_cancelled() {
            watchdog.abort();
            attached.abort();
            if let Some(t) = stdout_task.take() {
                t.abort();
            }
            if let Some(t) = stderr_task.take() {
                t.abort();
            }
            let _ = channel_for_task.send(AttachEvent::Closed {
                message: Some("Session closed: context locked or configuration changed".into()),
                exit_code: None,
            });
            registry_clone.take(&id_clone).await;
            return;
        }
        let exit_status = if let Some(fut) = status_fut {
            tokio::select! {
                status = fut => status,
                _ = cancel_task.cancelled() => { attached.abort(); None },
            }
        } else {
            None
        };
        let join_result = attached.join().await;
        watchdog.abort();

        if let Some(t) = stdout_task.take() {
            t.abort();
        }
        if let Some(t) = stderr_task.take() {
            t.abort();
        }

        let exit_code = exit_status.as_ref().and_then(parse_exit_code);
        let message = match (&exit_status, &join_result) {
            (Some(s), _) if s.status.as_deref() == Some("Failure") => s.message.clone(),
            (_, Err(e)) => Some(format!("join: {e}")),
            _ => None,
        };
        let _ = channel_for_task.send(AttachEvent::Closed { message, exit_code });
        registry_clone.take(&id_clone).await;
    });

    Ok(id)
}

// kubelet reports exec exit codes inside Status.details.causes[*] when the
// reason is "ExitCode" — the message field holds the integer as a string.
// `status: "Success"` (zero-cause) means exit 0; missing details fall back
// to None so the UI can display "exited" without a code.
fn parse_exit_code(status: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Status) -> Option<i32> {
    if status.status.as_deref() == Some("Success") {
        return Some(0);
    }
    status
        .details
        .as_ref()?
        .causes
        .as_ref()?
        .iter()
        .find(|c| c.reason.as_deref() == Some("ExitCode"))
        .and_then(|c| c.message.as_ref())
        .and_then(|m| m.parse::<i32>().ok())
}

#[cfg(test)]
mod tests {
    use super::parse_exit_code;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{Status, StatusCause, StatusDetails};

    fn status_failure_with_cause(reason: &str, message: &str) -> Status {
        Status {
            status: Some("Failure".into()),
            details: Some(StatusDetails {
                causes: Some(vec![StatusCause {
                    reason: Some(reason.into()),
                    message: Some(message.into()),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn success_status_maps_to_exit_zero() {
        let s = Status {
            status: Some("Success".into()),
            ..Default::default()
        };
        assert_eq!(parse_exit_code(&s), Some(0));
    }

    #[test]
    fn extracts_nonzero_exit_from_failure_cause() {
        let s = status_failure_with_cause("ExitCode", "137");
        assert_eq!(parse_exit_code(&s), Some(137));
    }

    #[test]
    fn ignores_unrelated_cause_reasons() {
        let s = status_failure_with_cause("InternalError", "boom");
        assert_eq!(parse_exit_code(&s), None);
    }

    #[test]
    fn returns_none_when_details_missing() {
        let s = Status {
            status: Some("Failure".into()),
            details: None,
            ..Default::default()
        };
        assert_eq!(parse_exit_code(&s), None);
    }

    #[test]
    fn handles_unparseable_exit_code_message() {
        let s = status_failure_with_cause("ExitCode", "not-an-integer");
        assert_eq!(parse_exit_code(&s), None);
    }
    #[tokio::test]
    async fn locking_context_closes_only_its_sessions() {
        let registry = super::AttachRegistry::new();
        let policy = std::sync::Arc::new(crate::protection::ContextProtectionPolicy::unavailable());
        let first = tokio_util::sync::CancellationToken::new();
        let second = tokio_util::sync::CancellationToken::new();
        for (id, context, cancel) in [
            ("one", "prod", first.clone()),
            ("two", "dev", second.clone()),
        ] {
            let (stdin_tx, _) = tokio::sync::mpsc::unbounded_channel();
            let (resize_tx, _) = tokio::sync::mpsc::unbounded_channel();
            registry
                .insert(
                    id.into(),
                    super::Session {
                        stdin_tx,
                        resize_tx,
                        cancel,
                        protection: super::SessionProtection {
                            context: context.into(),
                            identity: String::new(),
                            policy: policy.clone(),
                        },
                    },
                )
                .await;
        }
        registry.close_context("prod").await;
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(registry.write_stdin("one", vec![b'x']).await.is_err());
        assert_eq!(registry.sessions.read().await.len(), 1);
        registry.close_all().await;
    }
    #[tokio::test]
    async fn debug_attach_checks_uid_before_any_exec_request() {
        use wiremock::{
            matchers::{method, path},
            Mock, MockServer, ResponseTemplate,
        };
        let server = MockServer::start().await;
        Mock::given(method("GET")).and(path("/api/v1/namespaces/apps/pods/api"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"apiVersion":"v1","kind":"Pod","metadata":{"name":"api","namespace":"apps","uid":"replacement"},"spec":{"containers":[{"name":"app"}]},"status":{"phase":"Running"}}))).mount(&server).await;
        for uid in [None, Some("captured-uid".to_owned())] {
            let client =
                kube::Client::try_from(kube::Config::new(server.uri().parse().unwrap())).unwrap();
            let request = super::StartAttachRequest {
                namespace: "apps".into(),
                pod: "api".into(),
                pod_uid: uid,
                container: Some("lumen-debug-one".into()),
                command: vec!["/bin/sh".into()],
                tty: true,
                cols: None,
                rows: None,
            };
            let protection = super::SessionProtection {
                context: "test".into(),
                identity: String::new(),
                policy: std::sync::Arc::new(
                    crate::protection::ContextProtectionPolicy::unavailable(),
                ),
            };
            let channel = tauri::ipc::Channel::new(|_| Ok(()));
            let result = super::start(
                client,
                super::AttachRegistry::new(),
                request,
                channel,
                protection,
            )
            .await;
            assert!(matches!(result, Err(crate::error::AppError::Conflict(_))));
        }
        assert!(server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .all(|request| request.method == "GET" && !request.url.path().contains("exec")));
    }
}
