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
    Stdout { text: String },
    Stderr { text: String },
    Closed {
        message: Option<String>,
        exit_code: Option<i32>,
    },
}

struct Session {
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
        sess.stdin_tx
            .send(bytes)
            .map_err(|e| AppError::K8s(format!("stdin queue closed: {e}")))
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let map = self.sessions.read().await;
        let sess = map
            .get(id)
            .ok_or_else(|| AppError::K8s(format!("attach session {id} not found")))?;
        sess.resize_tx
            .send((cols, rows))
            .map_err(|e| AppError::K8s(format!("resize queue closed: {e}")))
    }

    pub async fn close(&self, id: &str) {
        if let Some(s) = self.take(id).await {
            s.cancel.cancel();
        }
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

        loop {
            tokio::select! {
                _ = cancel_task.cancelled() => break,
                bytes = stdin_rx.recv() => {
                    let Some(bytes) = bytes else { break };
                    if let Some(sin) = stdin.as_mut() {
                        if sin.write_all(&bytes).await.is_err() { break; }
                        if sin.flush().await.is_err() { break; }
                    }
                }
                sz = resize_rx.recv() => {
                    let Some((c, r)) = sz else { break };
                    if let Some(sink) = resize_sink.as_mut() {
                        let _ = sink.send(TerminalSize { width: c, height: r }).await;
                    }
                }
            }
        }

        let exit_status = if let Some(fut) = status_fut {
            fut.await
        } else {
            None
        };
        let join_result = attached.join().await;

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
fn parse_exit_code(
    status: &k8s_openapi::apimachinery::pkg::apis::meta::v1::Status,
) -> Option<i32> {
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
}
