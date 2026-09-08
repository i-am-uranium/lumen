//! Disposable fixture only; invoke with the isolated test-kind.sh kubeconfig.
use k8s_openapi::api::{
    core::v1::Pod,
    rbac::v1::{Role, RoleBinding},
};
use kube::{
    api::{DeleteParams, PostParams},
    config::{KubeConfigOptions, Kubeconfig},
    Api, Client, Config,
};
use lumen_lib::{
    error::AppError,
    k8s::debug::{self, DebugProfile, DebugRequest},
};
use std::time::Duration;

#[tokio::test]
#[ignore = "requires isolated kind-lumen-e2e-* and LUMEN_E2E_KUBECONFIG"]
async fn restricted_ephemeral_debug_lifecycle_and_rbac() {
    let path = std::env::var("LUMEN_E2E_KUBECONFIG").expect("use the disposable kind fixture");
    let kc = Kubeconfig::read_from(path).unwrap();
    let context = kc.current_context.as_ref().unwrap().clone();
    assert!(
        context.starts_with("kind-lumen-e2e-"),
        "refusing a non-fixture context"
    );
    let config = Config::from_custom_kubeconfig(kc, &KubeConfigOptions::default())
        .await
        .unwrap();
    assert!(
        matches!(config.cluster_url.host(), Some("127.0.0.1" | "localhost")),
        "refusing nonlocal API"
    );
    let admin = Client::try_from(config.clone()).unwrap();
    let pods: Api<Pod> = Api::namespaced(admin.clone(), "lumen-e2e-a");
    let pod: Pod = serde_json::from_value(serde_json::json!({"apiVersion":"v1", "kind":"Pod", "metadata":{"name":"debug-fixture"}, "spec":{"restartPolicy":"Never", "containers":[{"name":"app", "image":"busybox:1.37", "command":["sleep","600"]}]}})).unwrap();
    let created = pods.create(&PostParams::default(), &pod).await.unwrap();
    let uid = created.metadata.uid.unwrap();
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let current = pods.get("debug-fixture").await.unwrap();
            if current
                .status
                .as_ref()
                .and_then(|s| s.container_statuses.as_ref())
                .is_some_and(|cs| {
                    cs.iter()
                        .any(|c| c.state.as_ref().and_then(|s| s.running.as_ref()).is_some())
                })
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    })
    .await
    .expect("fixture image failed to start within 120 seconds");
    let request = DebugRequest {
        context: context.clone(),
        namespace: "lumen-e2e-a".into(),
        pod: "debug-fixture".into(),
        pod_uid: uid,
        target_container: "app".into(),
        name: "lumen-debug-acceptance".into(),
        image: "busybox:1.37".into(),
        command: vec!["sleep".into(), "600".into()],
        profile: DebugProfile::Restricted,
    };
    let result = debug::create(admin.clone(), request.clone(), || Ok(()))
        .await
        .unwrap();
    assert_eq!(result.container.state, "running");
    assert!(!result.reused);
    let reused = debug::create(admin.clone(), request.clone(), || Ok(()))
        .await
        .unwrap();
    assert!(reused.reused);
    let current = pods.get("debug-fixture").await.unwrap();
    assert_eq!(
        current
            .spec
            .as_ref()
            .unwrap()
            .ephemeral_containers
            .as_ref()
            .unwrap()
            .len(),
        1
    );
    debug::verify_terminal(&current, &request.pod_uid, Some(&request.name)).unwrap();
    let mut replaced = request.clone();
    replaced.pod_uid = "wrong-uid".into();
    assert!(matches!(
        debug::create(admin.clone(), replaced, || Ok(())).await,
        Err(AppError::Conflict(_))
    ));
    // Give the existing viewer only pod GET, proving denial happens on the
    // ephemeralcontainers mutation rather than being masked by a failed read.
    let roles: Api<Role> = Api::namespaced(admin.clone(), "lumen-e2e-a");
    let bindings: Api<RoleBinding> = Api::namespaced(admin, "lumen-e2e-a");
    roles.create(&PostParams::default(), &serde_json::from_value(serde_json::json!({"metadata":{"name":"debug-reader"},"rules":[{"apiGroups":[""],"resources":["pods"],"verbs":["get"]}]})).unwrap()).await.unwrap();
    bindings.create(&PostParams::default(), &serde_json::from_value(serde_json::json!({"metadata":{"name":"debug-reader"},"roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"Role","name":"debug-reader"},"subjects":[{"kind":"ServiceAccount","name":"viewer","namespace":"lumen-e2e-a"}]})).unwrap()).await.unwrap();
    let mut viewer_config = config;
    viewer_config.auth_info.impersonate = Some("system:serviceaccount:lumen-e2e-a:viewer".into());
    viewer_config.auth_info.impersonate_groups = Some(vec![
        "system:authenticated".into(),
        "system:serviceaccounts".into(),
        "system:serviceaccounts:lumen-e2e-a".into(),
    ]);
    let viewer = Client::try_from(viewer_config).unwrap();
    let mut denied = request;
    denied.name = "lumen-debug-denied".into();
    let error = debug::create(viewer, denied, || Ok(())).await.unwrap_err();
    assert!(error.to_string().contains("Permission or admission denied"));
    assert_eq!(
        pods.get("debug-fixture")
            .await
            .unwrap()
            .spec
            .unwrap()
            .ephemeral_containers
            .unwrap()
            .len(),
        1
    );
    pods.delete("debug-fixture", &DeleteParams::default())
        .await
        .unwrap();
    bindings
        .delete("debug-reader", &DeleteParams::default())
        .await
        .unwrap();
    roles
        .delete("debug-reader", &DeleteParams::default())
        .await
        .unwrap();
}
