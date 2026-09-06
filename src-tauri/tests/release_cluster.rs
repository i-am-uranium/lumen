//! Run only via scripts/test-kind.sh against its isolated disposable cluster.
use k8s_openapi::api::core::v1::ConfigMap;
use kube::{
    api::ListParams,
    config::{KubeConfigOptions, Kubeconfig},
    Api, Client, Config,
};
use lumen_lib::k8s::{
    actions,
    rbac::{self, AccessReviewRequest},
    types::WorkloadKind,
};

async fn configuration() -> Config {
    let path = std::env::var("LUMEN_E2E_KUBECONFIG").expect("use scripts/test-kind.sh");
    let kubeconfig = Kubeconfig::read_from(path).unwrap();
    let context = kubeconfig.current_context.as_deref().unwrap();
    assert!(
        context.starts_with("kind-lumen-e2e-"),
        "refusing non-fixture context"
    );
    let config = Config::from_custom_kubeconfig(kubeconfig, &KubeConfigOptions::default())
        .await
        .unwrap();
    assert!(
        matches!(config.cluster_url.host(), Some("127.0.0.1" | "localhost")),
        "refusing non-local API server"
    );
    config
}

fn request(verb: &str, namespace: &str) -> AccessReviewRequest {
    AccessReviewRequest {
        kind: WorkloadKind::ConfigMap,
        verb: verb.into(),
        namespace: Some(namespace.into()),
        name: None,
        subresource: None,
    }
}

#[tokio::test]
#[ignore = "requires the disposable fixture created by scripts/test-kind.sh"]
async fn native_apply_respects_validation_rbac_and_namespace_boundaries() {
    let config = configuration().await;
    let admin = Client::try_from(config.clone()).unwrap();
    let maps: Api<ConfigMap> = Api::namespaced(admin.clone(), "lumen-e2e-a");
    let other: Api<ConfigMap> = Api::namespaced(admin.clone(), "lumen-e2e-b");
    let manifest = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: release-check\ndata:\n  status: validated\n";
    let preview = actions::apply_resource(
        &admin,
        "lumen-e2e-a",
        WorkloadKind::ConfigMap,
        "release-check",
        manifest,
        true,
    )
    .await
    .unwrap();
    assert!(preview.dry_run);
    assert!(
        maps.get_opt("release-check").await.unwrap().is_none(),
        "dry-run persisted a resource"
    );
    let applied = actions::apply_resource(
        &admin,
        "lumen-e2e-a",
        WorkloadKind::ConfigMap,
        "release-check",
        manifest,
        false,
    )
    .await
    .unwrap();
    assert!(!applied.dry_run);
    assert_eq!(
        maps.get("release-check").await.unwrap().data.unwrap()["status"],
        "validated"
    );
    assert!(
        other.get_opt("release-check").await.unwrap().is_none(),
        "write escaped target namespace"
    );

    let invalid = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: invalid\ndata:\n  status: [not, a, string]\n";
    assert!(actions::apply_resource(
        &admin,
        "lumen-e2e-a",
        WorkloadKind::ConfigMap,
        "invalid",
        invalid,
        true
    )
    .await
    .is_err());
    assert!(maps.get_opt("invalid").await.unwrap().is_none());

    let mut restricted_config = config;
    restricted_config.auth_info.impersonate =
        Some("system:serviceaccount:lumen-e2e-a:viewer".into());
    restricted_config.auth_info.impersonate_groups = Some(vec![
        "system:authenticated".into(),
        "system:serviceaccounts".into(),
        "system:serviceaccounts:lumen-e2e-a".into(),
    ]);
    let viewer = Client::try_from(restricted_config).unwrap();
    assert!(
        rbac::check_access(&viewer, request("get", "lumen-e2e-a"))
            .await
            .unwrap()
            .allowed
    );
    assert!(
        !rbac::check_access(&viewer, request("patch", "lumen-e2e-a"))
            .await
            .unwrap()
            .allowed
    );
    assert!(
        !rbac::check_access(&viewer, request("get", "lumen-e2e-b"))
            .await
            .unwrap()
            .allowed
    );
    let visible: Api<ConfigMap> = Api::namespaced(viewer.clone(), "lumen-e2e-a");
    assert!(!visible
        .list(&ListParams::default())
        .await
        .unwrap()
        .items
        .is_empty());
    assert!(actions::apply_resource(
        &viewer,
        "lumen-e2e-a",
        WorkloadKind::ConfigMap,
        "release-check",
        manifest,
        false
    )
    .await
    .is_err());
    assert!(actions::delete_resource(
        &viewer,
        "lumen-e2e-a",
        WorkloadKind::ConfigMap,
        "release-check"
    )
    .await
    .is_err());
    assert!(
        maps.get_opt("release-check").await.unwrap().is_some(),
        "denied delete removed the resource"
    );
    actions::delete_resource(
        &admin,
        "lumen-e2e-a",
        WorkloadKind::ConfigMap,
        "release-check",
    )
    .await
    .unwrap();
    assert!(maps.get_opt("release-check").await.unwrap().is_none());
}
