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

/// Push a line into the UI stream marked with a synthetic `[lumen]` container
/// so surfaced errors show up inline with real log output, instead of being
/// silently dropped in the spawned task.
fn emit_banner(channel: &Channel<LogLine>, pod: &str, text: String) {
    let _ = channel.send(LogLine {
        pod: pod.to_string(),
        container: "[lumen]".into(),
        text,
    });
}

async fn tail_one_pod(
    client: Client,
    namespace: String,
    pod: String,
    container: Option<String>,
    params: LogParams,
    channel: Channel<LogLine>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let api: Api<Pod> = Api::namespaced(client.clone(), &namespace);
    let mut p = params.clone();
    // Auto-pick a sensible container if the caller didn't specify. Without
    // this, multi-container pods (Istio sidecars are near-universal in our
    // setup) fail hard on the Kubernetes API with "container must be
    // specified" and the user just sees an empty, hanging stream.
    let resolved_container = match container.clone() {
        Some(c) => Some(c),
        None => pick_container(&client, &namespace, &pod).await,
    };
    p.container = resolved_container.clone();

    match api.log_stream(&pod, &p).await {
        Ok(stream) => {
            // kube 0.95's log_stream returns `impl futures::AsyncBufRead`.
            // Adapt it to tokio's AsyncBufRead via tokio_util's compat layer,
            // then read lines.
            let mut lines = stream.compat().lines();
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    line = lines.next_line() => {
                        match line {
                            Ok(Some(text)) => {
                                let _ = channel.send(LogLine {
                                    pod: pod.clone(),
                                    container: resolved_container.clone().unwrap_or_default(),
                                    text,
                                });
                            }
                            Ok(None) => break,
                            Err(e) => {
                                emit_banner(&channel, &pod, format!("stream ended: {e}"));
                                return Err(AppError::K8s(e.to_string()));
                            }
                        }
                    }
                }
            }
            Ok(())
        }
        Err(e) => {
            emit_banner(
                &channel,
                &pod,
                format!(
                    "could not open log stream for {}{}: {}",
                    pod,
                    resolved_container
                        .as_deref()
                        .map(|c| format!(" (container={c})"))
                        .unwrap_or_default(),
                    e
                ),
            );
            Err(AppError::K8s(e.to_string()))
        }
    }
}

async fn list_pods_by_selector(
    client: &Client,
    namespace: &str,
    label_selector: &str,
) -> AppResult<Vec<String>> {
    let api: Api<Pod> = Api::namespaced(client.clone(), namespace);
    let lp = ListParams::default().labels(label_selector);
    Ok(api
        .list(&lp)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?
        .items
        .into_iter()
        .filter_map(|p| p.metadata.name)
        .collect())
}

pub async fn stream_logs(
    client: Client,
    selector: LogSelector,
    channel: Channel<LogLine>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let mut params = LogParams::default();
    params.follow = true;
    params.tail_lines = selector.tail_lines.or(Some(200));
    params.since_seconds = selector.since_seconds;

    // Single-pod path: one-shot, no polling needed.
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

    let mut tailed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut handles: Vec<tokio::task::JoinHandle<AppResult<()>>> = Vec::new();

    // Initial fan-out.
    let initial = list_pods_by_selector(&client, &selector.namespace, &label_selector).await?;
    if initial.is_empty() {
        emit_banner(
            &channel,
            "(no-pods)",
            format!(
                "no pods matched label selector {label_selector} in namespace {}. Watching for new pods...",
                selector.namespace,
            ),
        );
    }
    for pod in initial {
        if tailed.insert(pod.clone()) {
            let child_cancel = cancel.clone();
            handles.push(tokio::spawn(tail_one_pod(
                client.clone(),
                selector.namespace.clone(),
                pod,
                selector.container.clone(),
                params.clone(),
                channel.clone(),
                child_cancel,
            )));
        }
    }

    // Rescan loop.
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    // First tick fires immediately; burn it so we don't re-list right after the initial fan-out.
    interval.tick().await;
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = interval.tick() => {
                // Swallow transient errors: a single failed list shouldn't tear down the stream.
                if let Ok(current) = list_pods_by_selector(&client, &selector.namespace, &label_selector).await {
                    for pod in current {
                        if tailed.insert(pod.clone()) {
                            let child_cancel = cancel.clone();
                            handles.push(tokio::spawn(tail_one_pod(
                                client.clone(),
                                selector.namespace.clone(),
                                pod,
                                selector.container.clone(),
                                params.clone(),
                                channel.clone(),
                                child_cancel,
                            )));
                        }
                    }
                }
            }
        }
    }

    // Drain outstanding tasks (they exit on cancel).
    for h in handles {
        let _ = h.await;
    }
    Ok(())
}
