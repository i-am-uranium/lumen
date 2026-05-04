//! Watch-based live updates: thin wrappers around `kube::runtime::watcher`
//! that emit typed `WatchEvent`s through a Tauri Channel.
//!
//! Each watch follows the same shape as `events::stream_events`: pass the
//! cancel token registered in `state.k8s.streams`, return early when the
//! token fires or the stream errors. The frontend opens a watch with a
//! caller-supplied `stream_id` and stops it via `stop_stream`.
//!
//! Variants:
//!   * `Applied` — initial list payload AND ongoing changes (kube-rs collapses
//!     them; consumers should treat each `Applied` as upsert-by-name).
//!   * `Deleted` — the resource is gone; remove from local cache by name.
//!   * `InitDone` — sent once after the first successful list, so the UI can
//!     swap from "loading…" to the populated view.
//!   * `Error` — non-fatal stream hiccup (kube re-lists internally); surfaced
//!     so the UI can show a transient banner.

use crate::error::AppResult;
use crate::k8s::types::{NodeSummary, WorkloadSummary};
use futures::StreamExt;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, StatefulSet};
use k8s_openapi::api::batch::v1::{CronJob, Job};
use k8s_openapi::api::core::v1::{Node, Pod};
use kube::{
    api::Api,
    runtime::{watcher, WatchStreamExt},
    Client,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WatchEvent<T: Serialize + Clone> {
    Applied { item: T },
    Deleted { name: String },
    InitDone,
    Error { message: String },
}

pub async fn watch_nodes(
    client: Client,
    channel: Channel<WatchEvent<NodeSummary>>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let api: Api<Node> = Api::all(client);
    let stream = watcher(api, watcher::Config::default()).default_backoff();
    tokio::pin!(stream);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            ev = stream.next() => {
                match ev {
                    Some(Ok(watcher::Event::Apply(n) | watcher::Event::InitApply(n))) => {
                        let _ = channel.send(WatchEvent::Applied {
                            item: crate::k8s::fleet::node_summary(&n),
                        });
                    }
                    Some(Ok(watcher::Event::Delete(n))) => {
                        if let Some(name) = n.metadata.name {
                            let _ = channel.send(WatchEvent::Deleted { name });
                        }
                    }
                    Some(Ok(watcher::Event::Init)) => {}
                    Some(Ok(watcher::Event::InitDone)) => {
                        let _ = channel.send(WatchEvent::InitDone);
                    }
                    Some(Err(err)) => {
                        let _ = channel.send(WatchEvent::Error { message: err.to_string() });
                    }
                    None => break,
                }
            }
        }
    }
    Ok(())
}

/// Watches the six workload kinds (Deployment, StatefulSet, DaemonSet, CronJob,
/// Job, Pod) in a namespace (or all namespaces if `None`) and multiplexes
/// `WorkloadSummary` events through a single channel. Each `Deleted` carries
/// `{kind}/{name}` so the consumer can scope removal to the right kind.
pub async fn watch_workloads(
    client: Client,
    namespace: Option<String>,
    channel: Channel<WatchEvent<WorkloadSummary>>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let (tx, mut rx) = tokio::sync::mpsc::channel::<WatchEvent<WorkloadSummary>>(256);

    macro_rules! spawn_kind {
        ($kind:ty, $build:expr, $type_label:expr) => {{
            let api: Api<$kind> = match &namespace {
                Some(ns) => Api::namespaced(client.clone(), ns),
                None => Api::all(client.clone()),
            };
            let cancel = cancel.clone();
            let tx = tx.clone();
            tokio::spawn(async move {
                let stream = watcher(api, watcher::Config::default()).default_backoff();
                tokio::pin!(stream);
                loop {
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        ev = stream.next() => match ev {
                            Some(Ok(watcher::Event::Apply(o) | watcher::Event::InitApply(o))) => {
                                let _ = tx.send(WatchEvent::Applied { item: $build(&o) }).await;
                            }
                            Some(Ok(watcher::Event::Delete(o))) => {
                                if let Some(name) = o.metadata.name {
                                    let _ = tx
                                        .send(WatchEvent::Deleted {
                                            name: format!("{}/{}", $type_label, name),
                                        })
                                        .await;
                                }
                            }
                            Some(Ok(_)) => {}
                            Some(Err(err)) => {
                                let _ = tx.send(WatchEvent::Error { message: err.to_string() }).await;
                            }
                            None => break,
                        }
                    }
                }
            });
        }};
    }

    spawn_kind!(Deployment, crate::k8s::resources::deployment_summary, "Deployment");
    spawn_kind!(StatefulSet, crate::k8s::resources::statefulset_summary, "StatefulSet");
    spawn_kind!(DaemonSet, crate::k8s::resources::daemonset_summary, "DaemonSet");
    spawn_kind!(CronJob, crate::k8s::resources::cronjob_summary, "CronJob");
    spawn_kind!(Job, crate::k8s::resources::job_summary, "Job");
    spawn_kind!(Pod, crate::k8s::resources::pod_summary, "Pod");

    drop(tx);

    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            ev = rx.recv() => match ev {
                Some(e) => { let _ = channel.send(e); }
                None => break,
            }
        }
    }
    Ok(())
}
