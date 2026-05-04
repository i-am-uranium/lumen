//! Port-forward sessions.
//!
//! Each session binds a local TCP listener on `127.0.0.1:<local_port>` and
//! forwards every inbound connection to `<pod>:<remote_port>` through kube's
//! SPDY port-forward channel. A session can target a specific pod or a
//! service — for services we resolve one backing pod via label selector at
//! start time (simple and predictable; if the pod dies, the session ends
//! and the user starts a new one).
//!
//! Sessions are kept in a process-wide registry keyed by an opaque id so the
//! UI can list + stop them. Dropping the cancel token on a session tears
//! down the listener and every in-flight connection.

use crate::error::{AppError, AppResult};
use k8s_openapi::api::core::v1::{Pod, Service};
use kube::{api::ListParams, Api, Client};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardTargetKind {
    Pod,
    Service,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForwardSession {
    pub id: String,
    pub context: String,
    pub namespace: String,
    pub target_kind: ForwardTargetKind,
    /// What the user asked for (pod name or service name).
    pub target_name: String,
    /// Pod we ended up tunnelling to. Same as `target_name` for pod targets.
    pub pod_name: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub started_at_ms: i64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub connections: u64,
    pub last_error: Option<String>,
}

struct SessionHandle {
    session: Arc<RwLock<ForwardSession>>,
    cancel: CancellationToken,
}

#[derive(Default)]
pub struct ForwardRegistry {
    sessions: RwLock<HashMap<String, SessionHandle>>,
}

impl ForwardRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub async fn list(&self) -> Vec<ForwardSession> {
        let mut out = Vec::new();
        for h in self.sessions.read().await.values() {
            out.push(h.session.read().await.clone());
        }
        out.sort_by_key(|s| s.started_at_ms);
        out
    }

    pub async fn stop(&self, id: &str) -> bool {
        let mut map = self.sessions.write().await;
        if let Some(h) = map.remove(id) {
            h.cancel.cancel();
            true
        } else {
            false
        }
    }

    pub async fn stop_all(&self) {
        let mut map = self.sessions.write().await;
        for (_, h) in map.drain() {
            h.cancel.cancel();
        }
    }

    async fn register(&self, id: String, handle: SessionHandle) {
        self.sessions.write().await.insert(id, handle);
    }

    async fn mark_error(&self, id: &str, err: String) {
        if let Some(h) = self.sessions.read().await.get(id) {
            h.session.write().await.last_error = Some(err);
        }
    }

    async fn bump_counters(&self, id: &str, r: u64, w: u64, new_conn: bool) {
        if let Some(h) = self.sessions.read().await.get(id) {
            let mut s = h.session.write().await;
            s.bytes_in += r;
            s.bytes_out += w;
            if new_conn {
                s.connections += 1;
            }
        }
    }
}

async fn resolve_pod_for_service(
    client: &Client,
    namespace: &str,
    service: &str,
    remote_port: u16,
) -> AppResult<(String, u16)> {
    let svc_api: Api<Service> = Api::namespaced(client.clone(), namespace);
    let svc = svc_api
        .get(service)
        .await
        .map_err(|e| AppError::K8s(format!("service {service}: {e}")))?;
    let spec = svc
        .spec
        .as_ref()
        .ok_or_else(|| AppError::K8s("service has no spec".into()))?;
    let selector = spec
        .selector
        .clone()
        .ok_or_else(|| AppError::K8s("service has no selector (headless or external?)".into()))?;
    if selector.is_empty() {
        return Err(AppError::K8s("service selector is empty".into()));
    }
    // Resolve remote port to a container targetPort when possible, so a
    // user asking for "http" (or the service port number) gets matched to
    // the pod's real container port.
    let target_container_port: Option<u16> = spec.ports.as_ref().and_then(|ports| {
        ports.iter().find_map(|p| {
            if p.port as u16 != remote_port {
                return None;
            }
            match p.target_port.as_ref()? {
                k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::Int(i) => {
                    Some(*i as u16)
                }
                k8s_openapi::apimachinery::pkg::util::intstr::IntOrString::String(_) => {
                    // Named port — we don't resolve it here; fall back to the
                    // service's own port number (kube will still do the right
                    // thing in most cases where port == targetPort).
                    Some(remote_port)
                }
            }
        })
    });
    let pod_port = target_container_port.unwrap_or(remote_port);

    let ls = selector
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join(",");
    let pod_api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let pods = pod_api
        .list(&ListParams::default().labels(&ls))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let pod = pods
        .items
        .into_iter()
        .find(|p| {
            let phase = p
                .status
                .as_ref()
                .and_then(|s| s.phase.as_deref())
                .unwrap_or("");
            phase == "Running"
        })
        .ok_or_else(|| {
            AppError::K8s(format!(
                "no Running pod matches selector {ls} for service {service}"
            ))
        })?;
    let name = pod
        .metadata
        .name
        .ok_or_else(|| AppError::K8s("selected pod has no name".into()))?;
    Ok((name, pod_port))
}

/// Pipe one TCP connection to the pod through a fresh port-forward channel.
/// Returns bytes copied (in, out).
async fn pipe_one(
    client: Client,
    namespace: String,
    pod: String,
    pod_port: u16,
    mut tcp: tokio::net::TcpStream,
    cancel: CancellationToken,
) -> AppResult<(u64, u64)> {
    let api: Api<Pod> = Api::namespaced(client, &namespace);
    let mut pf = api
        .portforward(&pod, &[pod_port])
        .await
        .map_err(|e| AppError::K8s(format!("open port-forward: {e}")))?;
    let upstream = pf
        .take_stream(pod_port)
        .ok_or_else(|| AppError::K8s("kube did not return a stream for the requested port".into()))?;

    let (mut up_r, mut up_w) = tokio::io::split(upstream);
    let (mut tcp_r, mut tcp_w) = tcp.split();

    let up_to_tcp = async {
        let n = tokio::io::copy(&mut up_r, &mut tcp_w).await?;
        tcp_w.shutdown().await.ok();
        Ok::<u64, std::io::Error>(n)
    };
    let tcp_to_up = async {
        let n = tokio::io::copy(&mut tcp_r, &mut up_w).await?;
        up_w.shutdown().await.ok();
        Ok::<u64, std::io::Error>(n)
    };

    let result = tokio::select! {
        _ = cancel.cancelled() => Ok((0, 0)),
        r = async { tokio::try_join!(up_to_tcp, tcp_to_up) } => {
            match r {
                Ok((up_bytes, down_bytes)) => Ok((down_bytes, up_bytes)),
                Err(e) => Err(AppError::K8s(format!("port-forward stream: {e}"))),
            }
        }
    };
    // Best-effort drive the SPDY connection to completion so the server
    // sees the close.
    let _ = pf.join().await;
    result
}

async fn listener_loop(
    registry: Arc<ForwardRegistry>,
    id: String,
    client: Client,
    namespace: String,
    pod: String,
    pod_port: u16,
    listener: TcpListener,
    cancel: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            accept = listener.accept() => {
                match accept {
                    Ok((tcp, _peer)) => {
                        registry.bump_counters(&id, 0, 0, true).await;
                        let client = client.clone();
                        let ns = namespace.clone();
                        let pod = pod.clone();
                        let child = cancel.clone();
                        let reg = registry.clone();
                        let id_clone = id.clone();
                        tokio::spawn(async move {
                            match pipe_one(client, ns, pod, pod_port, tcp, child).await {
                                Ok((rx, tx)) => reg.bump_counters(&id_clone, rx, tx, false).await,
                                Err(e) => reg.mark_error(&id_clone, e.to_string()).await,
                            }
                        });
                    }
                    Err(e) => {
                        registry.mark_error(&id, format!("accept: {e}")).await;
                        break;
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct StartForwardRequest {
    pub context: String,
    pub namespace: String,
    pub target_kind: ForwardTargetKind,
    pub target_name: String,
    pub local_port: u16,
    pub remote_port: u16,
}

pub async fn start(
    client: Client,
    registry: Arc<ForwardRegistry>,
    req: StartForwardRequest,
) -> AppResult<ForwardSession> {
    // Resolve the pod + actual pod port to tunnel to.
    let (pod_name, pod_port) = match req.target_kind {
        ForwardTargetKind::Pod => (req.target_name.clone(), req.remote_port),
        ForwardTargetKind::Service => {
            resolve_pod_for_service(&client, &req.namespace, &req.target_name, req.remote_port)
                .await?
        }
    };

    // Bind the local listener before we register so callers see
    // bind-in-use errors immediately.
    let listener = TcpListener::bind(("127.0.0.1", req.local_port))
        .await
        .map_err(|e| {
            AppError::K8s(format!(
                "cannot bind local port {}: {e}",
                req.local_port
            ))
        })?;

    let id = format!(
        "pf-{}-{}-{}",
        req.namespace,
        req.target_name,
        req.local_port
    );
    let session = ForwardSession {
        id: id.clone(),
        context: req.context.clone(),
        namespace: req.namespace.clone(),
        target_kind: req.target_kind,
        target_name: req.target_name.clone(),
        pod_name: pod_name.clone(),
        local_port: req.local_port,
        remote_port: req.remote_port,
        started_at_ms: chrono::Utc::now().timestamp_millis(),
        bytes_in: 0,
        bytes_out: 0,
        connections: 0,
        last_error: None,
    };
    let session_arc = Arc::new(RwLock::new(session.clone()));
    let cancel = CancellationToken::new();

    registry
        .register(
            id.clone(),
            SessionHandle {
                session: session_arc.clone(),
                cancel: cancel.clone(),
            },
        )
        .await;

    let reg = registry.clone();
    let id_clone = id.clone();
    let ns = req.namespace.clone();
    tokio::spawn(async move {
        listener_loop(reg, id_clone, client, ns, pod_name, pod_port, listener, cancel).await;
    });

    Ok(session)
}
