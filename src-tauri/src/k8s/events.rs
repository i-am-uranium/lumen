use crate::error::{AppError, AppResult};
use k8s_openapi::api::core::v1::Event;
use kube::{
    api::Api,
    runtime::{watcher, WatchStreamExt},
    Client,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize)]
pub struct EventLine {
    pub ts: Option<String>,
    pub kind: String,
    pub reason: String,
    pub message: String,
    pub involved: String,
    #[serde(rename = "type_")]
    pub type_: String,
}

pub async fn stream_events(
    client: Client,
    namespace: Option<String>,
    channel: Channel<EventLine>,
    cancel: CancellationToken,
) -> AppResult<()> {
    let api: Api<Event> = match namespace {
        Some(ns) => Api::namespaced(client, &ns),
        None => Api::all(client),
    };
    let stream = watcher(api, watcher::Config::default()).applied_objects();
    tokio::pin!(stream);
    use futures::StreamExt;
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            ev = stream.next() => {
                match ev {
                    Some(Ok(e)) => {
                        let line = EventLine {
                            ts: e.event_time.map(|t| t.0.to_rfc3339()),
                            kind: "Event".into(),
                            reason: e.reason.unwrap_or_default(),
                            message: e.message.unwrap_or_default(),
                            involved: format!(
                                "{}/{}",
                                e.involved_object.kind.unwrap_or_default(),
                                e.involved_object.name.unwrap_or_default()
                            ),
                            type_: e.type_.unwrap_or_default(),
                        };
                        let _ = channel.send(line);
                    }
                    Some(Err(err)) => return Err(AppError::K8s(err.to_string())),
                    None => break,
                }
            }
        }
    }
    Ok(())
}
