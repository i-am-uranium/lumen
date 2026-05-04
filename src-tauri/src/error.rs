//! AppError: single error type serialized to JS as a tagged union.
//!
//! React pattern-matches on `kind` to render friendly messages.
use serde::Serialize;

#[derive(thiserror::Error, Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("network error: {0}")]
    Network(String),
    #[error("upstream error: {0}")]
    Upstream(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("internal: {0}")]
    Internal(String),
    #[error("kubernetes error: {0}")]
    K8s(String),
    #[error("kubeconfig error: {0}")]
    Kubeconfig(String),
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_tagged_union() {
        let e = AppError::PermissionDenied("nope".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#"{"kind":"PermissionDenied","message":"nope"}"#);
    }

    #[test]
    fn k8s_variant_serializes() {
        let e = AppError::K8s("boom".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#"{"kind":"K8s","message":"boom"}"#);
    }

    #[test]
    fn kubeconfig_variant_serializes() {
        let e = AppError::Kubeconfig("not found".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#"{"kind":"Kubeconfig","message":"not found"}"#);
    }

    #[test]
    fn every_string_variant_serializes_with_message_key() {
        // Lock in the JS contract: every non-unit variant emits
        // `{"kind": "<Variant>", "message": "<payload>"}`.
        let cases: &[(AppError, &str, &str)] = &[
            (
                AppError::NotFound("svc/bucket".into()),
                "NotFound",
                "svc/bucket",
            ),
            (AppError::Network("dns".into()), "Network", "dns"),
            (
                AppError::Upstream("HTTP 500".into()),
                "Upstream",
                "HTTP 500",
            ),
            (
                AppError::Conflict("version bumped".into()),
                "Conflict",
                "version bumped",
            ),
            (AppError::Internal("oops".into()), "Internal", "oops"),
        ];
        for (err, kind, msg) in cases {
            let v: serde_json::Value = serde_json::to_value(err).unwrap();
            assert_eq!(
                v["kind"],
                serde_json::json!(kind),
                "kind mismatch for {kind}"
            );
            assert_eq!(
                v["message"],
                serde_json::json!(msg),
                "message mismatch for {kind}"
            );
        }
    }
}
