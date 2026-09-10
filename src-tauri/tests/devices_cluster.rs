//! Synthetic DRA inventory on a disposable API server; no physical device or driver.
//! Run only via scripts/test-kind.sh against its isolated fixture.

use kube::{
    api::{DynamicObject, Patch, PatchParams},
    config::{KubeConfigOptions, Kubeconfig},
    core::{ApiResource, GroupVersionKind},
    Api, Client, Config,
};
use lumen_lib::k8s::devices::{snapshot, DeviceSourceState};
use serde_json::{json, Value};

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

async fn fixture(client: &Client, plural: &str, value: Value) {
    let version = value["apiVersion"].as_str().unwrap();
    let (group, version) = version.split_once('/').unwrap_or(("", version));
    let resource = ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk(group, version, value["kind"].as_str().unwrap()),
        plural,
    );
    let api: Api<DynamicObject> = match value["metadata"]["namespace"].as_str() {
        Some(namespace) => Api::namespaced_with(client.clone(), namespace, &resource),
        None => Api::all_with(client.clone(), &resource),
    };
    api.patch(
        value["metadata"]["name"].as_str().unwrap(),
        &PatchParams::apply("lumen-device-inventory-fixture"),
        &Patch::Apply(&value),
    )
    .await
    .expect("could not create synthetic fixture; Kubernetes must serve resource.k8s.io/v1");
}

fn fixture_item<'a>(items: &'a [Value], name: &str, namespace: &str) -> &'a Value {
    let mut matches = items.iter().filter(|item| {
        item["metadata"]["name"] == name && item["metadata"]["namespace"] == namespace
    });
    let item = matches
        .next()
        .unwrap_or_else(|| panic!("missing fixture {namespace}/{name}"));
    assert!(
        matches.next().is_none(),
        "duplicate fixture {namespace}/{name}"
    );
    item
}

#[tokio::test]
#[ignore = "requires the disposable fixture created by scripts/test-kind.sh"]
async fn inventory_obeys_real_api_schema_rbac_and_namespace_scope() {
    let config = configuration().await;
    let admin = Client::try_from(config.clone()).unwrap();
    admin
        .list_api_group_resources("resource.k8s.io/v1")
        .await
        .expect("fixture Kubernetes version must support resource.k8s.io/v1");
    fixture(&admin, "deviceclasses", json!({
        "apiVersion":"resource.k8s.io/v1","kind":"DeviceClass",
        "metadata":{"name":"lumen-device-fixture"},
        "spec":{"selectors":[{"cel":{"expression":"device.driver == 'fixture.example.com'"}}],
            "config":[{"opaque":{"driver":"fixture.example.com","parameters":{"fixtureSecret":"must-not-cross-ipc"}}}]}
    })).await;
    fixture(&admin, "resourceslices", json!({
        "apiVersion":"resource.k8s.io/v1","kind":"ResourceSlice",
        "metadata":{"name":"lumen-device-fixture"},
        "spec":{"driver":"fixture.example.com","pool":{"name":"fixture-pool","generation":1,"resourceSliceCount":1},
            "allNodes":true,"devices":[{"name":"synthetic-gpu","attributes":{"model":{"string":"synthetic"}}}]}
    })).await;
    let claim_spec = json!({"devices":{"requests":[{"name":"gpu","exactly":{
        "deviceClassName":"lumen-device-fixture","allocationMode":"ExactCount","count":1}}]}});
    for namespace in ["lumen-e2e-a", "lumen-e2e-b"] {
        fixture(&admin, "resourceclaims", json!({
            "apiVersion":"resource.k8s.io/v1","kind":"ResourceClaim",
            "metadata":{"name":"device-fixture","namespace":namespace,"annotations":{"fixture-secret":"must-not-cross-ipc"}},
            "spec":claim_spec
        })).await;
        fixture(
            &admin,
            "resourceclaimtemplates",
            json!({
                "apiVersion":"resource.k8s.io/v1","kind":"ResourceClaimTemplate",
                "metadata":{"name":"device-fixture","namespace":namespace},
                "spec":{"spec":claim_spec}
            }),
        )
        .await;
    }
    fixture(&admin, "pods", json!({
        "apiVersion":"v1","kind":"Pod","metadata":{"name":"device-fixture","namespace":"lumen-e2e-a"},
        "spec":{"schedulerName":"lumen-fixture-disabled","resourceClaims":[{"name":"gpu","resourceClaimName":"device-fixture"}],
            "containers":[{"name":"app","image":"registry.k8s.io/pause:3.10", "env":[{"name":"FIXTURE_SECRET","value":"must-not-cross-ipc"}],
                "resources":{"claims":[{"name":"gpu"}]}}]}
    })).await;
    // Other integration suites share these namespaces. Include both an
    // unrelated name and a same-name pod in another namespace so this test
    // cannot accidentally depend on list ordering or name-only selection.
    for (name, namespace) in [
        ("a-unrelated-device-fixture", "lumen-e2e-a"),
        ("device-fixture", "lumen-e2e-b"),
    ] {
        fixture(
            &admin,
            "pods",
            json!({
                "apiVersion":"v1","kind":"Pod","metadata":{"name":name,"namespace":namespace},
                "spec":{"schedulerName":"lumen-fixture-disabled",
                    "containers":[{"name":"unrelated","image":"registry.k8s.io/pause:3.10"}]}
            }),
        )
        .await;
    }
    fixture(&admin, "roles", json!({
        "apiVersion":"rbac.authorization.k8s.io/v1","kind":"Role",
        "metadata":{"name":"device-fixture-reader","namespace":"lumen-e2e-a"},
        "rules":[{"apiGroups":["resource.k8s.io"],"resources":["resourceclaims","resourceclaimtemplates"],"verbs":["list"]},
            {"apiGroups":[""],"resources":["pods"],"verbs":["list"]}]
    })).await;
    fixture(&admin, "rolebindings", json!({
        "apiVersion":"rbac.authorization.k8s.io/v1","kind":"RoleBinding",
        "metadata":{"name":"device-fixture-reader","namespace":"lumen-e2e-a"},
        "roleRef":{"apiGroup":"rbac.authorization.k8s.io","kind":"Role","name":"device-fixture-reader"},
        "subjects":[{"kind":"ServiceAccount","name":"viewer","namespace":"lumen-e2e-a"}]
    })).await;

    let scoped = snapshot(&admin, "lumen-e2e-a").await;
    for source in [
        &scoped.claims,
        &scoped.templates,
        &scoped.classes,
        &scoped.slices,
        &scoped.pods,
    ] {
        assert_eq!(
            source.state,
            DeviceSourceState::Available,
            "{:?}",
            source.message
        );
        assert!(!source.items.is_empty());
    }
    assert_eq!(scoped.claims.items.len(), 1);
    assert_eq!(scoped.templates.items.len(), 1);
    fixture_item(&scoped.claims.items, "device-fixture", "lumen-e2e-a");
    fixture_item(&scoped.templates.items, "device-fixture", "lumen-e2e-a");
    assert!(scoped
        .pods
        .items
        .iter()
        .all(|pod| pod["metadata"]["namespace"] == "lumen-e2e-a"));
    let pod = fixture_item(&scoped.pods.items, "device-fixture", "lumen-e2e-a");
    assert_eq!(
        pod["spec"]["resourceClaims"][0]["resourceClaimName"],
        "device-fixture"
    );
    let unrelated = fixture_item(
        &scoped.pods.items,
        "a-unrelated-device-fixture",
        "lumen-e2e-a",
    );
    assert!(unrelated["spec"]["resourceClaims"].is_null());
    assert!(!serde_json::to_string(&scoped)
        .unwrap()
        .contains("must-not-cross-ipc"));
    let all = snapshot(&admin, "").await;
    assert_eq!(all.claims.items.len(), 2);
    assert_eq!(all.templates.items.len(), 2);
    for namespace in ["lumen-e2e-a", "lumen-e2e-b"] {
        fixture_item(&all.claims.items, "device-fixture", namespace);
        fixture_item(&all.templates.items, "device-fixture", namespace);
        fixture_item(&all.pods.items, "device-fixture", namespace);
    }

    let mut restricted_config = config;
    restricted_config.auth_info.impersonate =
        Some("system:serviceaccount:lumen-e2e-a:viewer".into());
    restricted_config.auth_info.impersonate_groups = Some(vec![
        "system:authenticated".into(),
        "system:serviceaccounts".into(),
        "system:serviceaccounts:lumen-e2e-a".into(),
    ]);
    let viewer = Client::try_from(restricted_config).unwrap();
    let own = snapshot(&viewer, "lumen-e2e-a").await;
    assert_eq!(own.claims.state, DeviceSourceState::Available);
    assert_eq!(own.templates.state, DeviceSourceState::Available);
    assert_eq!(own.pods.state, DeviceSourceState::Available);
    assert_eq!(own.classes.state, DeviceSourceState::Forbidden);
    assert_eq!(own.slices.state, DeviceSourceState::Forbidden);
    let other = snapshot(&viewer, "lumen-e2e-b").await;
    assert_eq!(other.claims.state, DeviceSourceState::Forbidden);
    assert_eq!(other.templates.state, DeviceSourceState::Forbidden);
    assert_eq!(other.pods.state, DeviceSourceState::Forbidden);
    assert!(other.claims.items.is_empty());
    let all = snapshot(&viewer, "").await;
    assert_eq!(all.claims.state, DeviceSourceState::Forbidden);
}
