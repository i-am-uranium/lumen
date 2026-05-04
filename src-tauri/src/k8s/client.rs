//! Multi-cluster client manager.
//!
//! Each kubeconfig context gets its own `kube::Client`, created lazily on first
//! use and cached. A single frontend session may hold clients for many
//! contexts simultaneously (fleet mode). `current_context` is kept for legacy
//! single-cluster commands; all new commands accept an explicit `context` arg.

use crate::error::{AppError, AppResult};
use kube::{Client, Config};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct K8sState {
    pub current_context: RwLock<Option<String>>,
    /// Cache of `Client` keyed by context name. Populated lazily.
    pub clients: RwLock<HashMap<String, Client>>,
    /// Cancellation tokens for running streams, keyed by stream id.
    pub streams: RwLock<HashMap<String, CancellationToken>>,
}

impl K8sState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Build (or reuse) a Client for the given kubeconfig context.
    async fn build_client(context: &str) -> AppResult<Client> {
        let kc = crate::k8s::kubeconfig::load()?;
        let opts = kube::config::KubeConfigOptions {
            context: Some(context.to_string()),
            ..Default::default()
        };
        let cfg = Config::from_custom_kubeconfig(kc, &opts)
            .await
            .map_err(|e| AppError::Kubeconfig(e.to_string()))?;
        Client::try_from(cfg).map_err(|e| AppError::K8s(e.to_string()))
    }

    /// Get (or create + cache) a Client for `context`.
    pub async fn client_for(&self, context: &str) -> AppResult<Client> {
        if let Some(c) = self.clients.read().await.get(context).cloned() {
            return Ok(c);
        }
        let client = Self::build_client(context).await?;
        self.clients
            .write()
            .await
            .insert(context.to_string(), client.clone());
        Ok(client)
    }

    /// Set the "active" context — legacy single-cluster convenience. Also
    /// pre-warms the client cache for that context.
    pub async fn set_context(&self, name: &str) -> AppResult<()> {
        let _ = self.client_for(name).await?;
        *self.current_context.write().await = Some(name.to_string());
        Ok(())
    }

    /// Resolve the context to use: explicit override, else the legacy current.
    pub async fn resolve_context(&self, explicit: Option<&str>) -> AppResult<String> {
        if let Some(c) = explicit {
            return Ok(c.to_string());
        }
        self.current_context
            .read()
            .await
            .clone()
            .ok_or_else(|| AppError::K8s("no active cluster context".into()))
    }

    /// Legacy: client for the current context. New code should prefer
    /// `client_for(ctx)`.
    pub async fn client(&self) -> AppResult<Client> {
        let ctx = self.resolve_context(None).await?;
        self.client_for(&ctx).await
    }

    /// Evict a cached client (e.g. on auth failure).
    pub async fn invalidate(&self, context: &str) {
        self.clients.write().await.remove(context);
    }

    /// Evict *all* cached clients. Useful when the kubeconfig changes on disk
    /// or the user explicitly wants to force a reconnect across every context.
    pub async fn invalidate_all(&self) {
        self.clients.write().await.clear();
    }
}
