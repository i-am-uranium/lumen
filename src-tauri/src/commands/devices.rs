//! Explicit-context, read-only device inventory IPC.

use std::time::Duration;

use crate::{
    error::{AppError, AppResult},
    k8s::devices::{self, DeviceResourcesSnapshot},
    state::AppState,
};

#[tauri::command]
pub async fn device_resources_snapshot(
    context: String,
    namespace: String,
    state: tauri::State<'_, AppState>,
) -> AppResult<DeviceResourcesSnapshot> {
    if context.trim().is_empty() {
        return Err(AppError::K8s(
            "An explicit cluster context is required.".into(),
        ));
    }
    if !devices::valid_namespace(&namespace) {
        return Err(AppError::K8s(
            "Namespace must be a valid Kubernetes DNS label, or empty for all namespaces.".into(),
        ));
    }
    let client = tokio::time::timeout(Duration::from_secs(10), state.k8s.client_for(&context))
        .await
        .map_err(|_| AppError::K8s("Connecting to the selected context timed out.".into()))??;
    Ok(devices::snapshot(&client, &namespace).await)
}
