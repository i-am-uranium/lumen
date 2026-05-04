//! Shared app state for Kubernetes clients, streams, port forwards, and pod attaches.

use crate::k8s::client::K8sState;
use crate::k8s::exec::AttachRegistry;
use crate::k8s::portforward::ForwardRegistry;
use std::sync::Arc;

pub struct AppState {
    pub k8s: Arc<K8sState>,
    pub forwards: Arc<ForwardRegistry>,
    pub attachments: Arc<AttachRegistry>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            k8s: K8sState::new(),
            forwards: ForwardRegistry::new(),
            attachments: AttachRegistry::new(),
        }
    }
}
