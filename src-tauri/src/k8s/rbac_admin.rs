//! RBAC provisioner — create ServiceAccount + Role/Binding + short-lived
//! token and emit a ready-to-use kubeconfig.
//!
//! This is the first write surface in Lumen. It is deliberately narrow:
//!
//! * Always uses dedicated objects under a known name prefix
//!   (`lumen-team-<member>`), so cleanup is trivial and there is zero chance
//!   of overwriting unrelated RBAC.
//! * Uses the TokenRequest subresource (Kubernetes 1.24+) for short-lived
//!   tokens. No long-lived static Secret tokens. `ttl_hours` is capped to 24h.
//! * Templates (`viewer` / `editor` / `admin`) compile to explicit PolicyRule
//!   lists here — no wildcards above what the template already implies.
//! * The emitted kubeconfig contains the token. Treat it as a secret.

use crate::error::{AppError, AppResult};
use k8s_openapi::api::authentication::v1::{TokenRequest, TokenRequestSpec};
use k8s_openapi::api::core::v1::ServiceAccount;
use k8s_openapi::api::rbac::v1::{
    ClusterRole, ClusterRoleBinding, PolicyRule, Role, RoleBinding, RoleRef, Subject,
};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::{
    api::{Patch, PatchParams},
    Api, Client,
};
use serde::{Deserialize, Serialize};

const LUMEN_MANAGED_LABEL: &str = "app.kubernetes.io/managed-by";
const LUMEN_MANAGED_VALUE: &str = "lumen";
const LUMEN_OWNER_LABEL: &str = "lumen.dev/team-member";
const LUMEN_TEMPLATE_LABEL: &str = "lumen.dev/template";
const LUMEN_TOKEN_MODE_LABEL: &str = "lumen.dev/token-mode";

fn token_secret_name(member: &str) -> String {
    format!("lumen-team-{member}-token")
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessTemplate {
    Viewer,
    Editor,
    Admin,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TeamAccessRequest {
    /// Identifier for the team member. `[a-z0-9-]+`, becomes the SA name
    /// prefix.
    pub member_id: String,
    /// List of namespaces the access is scoped to. An empty vec means
    /// cluster-wide access (ClusterRole + ClusterRoleBinding).
    pub namespaces: Vec<String>,
    pub template: AccessTemplate,
    /// Token lifetime for the short-lived path; clamped to [1, 24] hours.
    /// Ignored when `long_lived = true`.
    pub ttl_hours: i64,
    /// When true, back the SA with a long-lived Secret-typed token instead
    /// of calling TokenRequest. The token never auto-expires — revoke the
    /// grant to invalidate it.
    #[serde(default)]
    pub long_lived: bool,
    /// Namespace to host the ServiceAccount itself. Defaults to the first
    /// target namespace (or "default" for cluster-wide).
    pub service_account_namespace: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenMode {
    /// TokenRequest-based, short-lived (1-24h).
    Short,
    /// Secret-based, never expires until the Secret is deleted.
    Long,
}

impl TokenMode {
    fn as_str(self) -> &'static str {
        match self {
            TokenMode::Short => "short",
            TokenMode::Long => "long",
        }
    }
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "short" => Some(TokenMode::Short),
            "long" => Some(TokenMode::Long),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CreatedObject {
    pub kind: String,
    pub name: String,
    pub namespace: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TeamAccessResult {
    pub service_account: String,
    pub sa_namespace: String,
    pub token_expires_at: String,
    pub kubeconfig_yaml: String,
    pub created: Vec<CreatedObject>,
}

fn validate_member_id(s: &str) -> AppResult<()> {
    if s.is_empty() || s.len() > 40 {
        return Err(AppError::Internal("member_id must be 1-40 chars".into()));
    }
    if !s
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(AppError::Internal("member_id must match [a-z0-9-]+".into()));
    }
    if s.starts_with('-') || s.ends_with('-') {
        return Err(AppError::Internal(
            "member_id cannot start or end with '-'".into(),
        ));
    }
    Ok(())
}

fn sa_name(member: &str) -> String {
    format!("lumen-team-{member}")
}
fn role_name(member: &str) -> String {
    format!("lumen-team-{member}")
}
fn binding_name(member: &str, ns: &str) -> String {
    format!("lumen-team-{member}-{ns}")
}

fn lumen_labels(
    member: &str,
    template: AccessTemplate,
) -> std::collections::BTreeMap<String, String> {
    let mut m = std::collections::BTreeMap::new();
    m.insert(LUMEN_MANAGED_LABEL.into(), LUMEN_MANAGED_VALUE.into());
    m.insert(LUMEN_OWNER_LABEL.into(), member.to_string());
    m.insert(LUMEN_TEMPLATE_LABEL.into(), template_str(template).into());
    m
}

fn sa_labels_with_mode(
    member: &str,
    template: AccessTemplate,
    mode: TokenMode,
) -> std::collections::BTreeMap<String, String> {
    let mut m = lumen_labels(member, template);
    m.insert(LUMEN_TOKEN_MODE_LABEL.into(), mode.as_str().into());
    m
}

/// Create or update a long-lived Secret-typed ServiceAccount token and poll
/// until the token-controller populates `.data.token`. Returns the token
/// string.
async fn issue_long_lived_token(
    client: &Client,
    ns: &str,
    sa: &str,
    member: &str,
    template: AccessTemplate,
) -> AppResult<String> {
    use k8s_openapi::api::core::v1::Secret;
    let api: Api<Secret> = Api::namespaced(client.clone(), ns);
    let name = token_secret_name(member);

    let mut annotations = std::collections::BTreeMap::new();
    annotations.insert("kubernetes.io/service-account.name".into(), sa.to_string());

    let secret = Secret {
        metadata: ObjectMeta {
            name: Some(name.clone()),
            namespace: Some(ns.into()),
            labels: Some(lumen_labels(member, template)),
            annotations: Some(annotations),
            ..Default::default()
        },
        type_: Some("kubernetes.io/service-account-token".into()),
        ..Default::default()
    };
    let pp = PatchParams::apply("lumen").force();
    api.patch(&name, &pp, &Patch::Apply(&secret))
        .await
        .map_err(|e| AppError::K8s(format!("create token Secret: {e}")))?;

    // The kube-controller-manager populates `.data.token` within a tick.
    // Poll for up to ~6 seconds before giving up.
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Ok(obj) = api.get(&name).await {
            if let Some(data) = obj.data {
                if let Some(bytes) = data.get("token") {
                    return String::from_utf8(bytes.0.clone())
                        .map_err(|e| AppError::Internal(format!("token not utf8: {e}")));
                }
            }
        }
    }
    Err(AppError::K8s(
        "timed out waiting for the ServiceAccount token Secret to populate — check that the token-controller is running".into(),
    ))
}

async fn read_long_lived_token(client: &Client, ns: &str, member: &str) -> AppResult<String> {
    use k8s_openapi::api::core::v1::Secret;
    let api: Api<Secret> = Api::namespaced(client.clone(), ns);
    let obj = api
        .get(&token_secret_name(member))
        .await
        .map_err(|e| AppError::K8s(format!("read token Secret: {e}")))?;
    let data = obj
        .data
        .ok_or_else(|| AppError::K8s("token Secret has no data".into()))?;
    let bytes = data
        .get("token")
        .ok_or_else(|| AppError::K8s("token Secret missing .data.token".into()))?;
    String::from_utf8(bytes.0.clone()).map_err(|e| AppError::Internal(e.to_string()))
}

fn template_str(t: AccessTemplate) -> &'static str {
    match t {
        AccessTemplate::Viewer => "viewer",
        AccessTemplate::Editor => "editor",
        AccessTemplate::Admin => "admin",
    }
}

fn template_from_str(s: &str) -> Option<AccessTemplate> {
    match s {
        "viewer" => Some(AccessTemplate::Viewer),
        "editor" => Some(AccessTemplate::Editor),
        "admin" => Some(AccessTemplate::Admin),
        _ => None,
    }
}

fn rules_for(template: AccessTemplate) -> Vec<PolicyRule> {
    let core_read_resources = vec![
        "pods".into(),
        "pods/log".into(),
        "services".into(),
        "endpoints".into(),
        "persistentvolumeclaims".into(),
        "configmaps".into(),
        "events".into(),
        "namespaces".into(),
        "nodes".into(),
        "replicationcontrollers".into(),
    ];
    let apps_resources = vec![
        "deployments".into(),
        "statefulsets".into(),
        "daemonsets".into(),
        "replicasets".into(),
    ];
    let batch_resources = vec!["jobs".into(), "cronjobs".into()];
    let net_resources = vec!["ingresses".into(), "networkpolicies".into()];
    let autoscaling_resources = vec!["horizontalpodautoscalers".into()];

    let read = vec!["get".into(), "list".into(), "watch".into()];
    let write = {
        let mut v = read.clone();
        v.extend([
            "create".into(),
            "update".into(),
            "patch".into(),
            "delete".into(),
        ]);
        v
    };
    let verbs = match template {
        AccessTemplate::Viewer => read.clone(),
        AccessTemplate::Editor | AccessTemplate::Admin => write.clone(),
    };

    match template {
        AccessTemplate::Admin => vec![PolicyRule {
            api_groups: Some(vec!["*".into()]),
            resources: Some(vec!["*".into()]),
            verbs: vec![
                "get".into(),
                "list".into(),
                "watch".into(),
                "create".into(),
                "update".into(),
                "patch".into(),
                "delete".into(),
                "deletecollection".into(),
            ],
            ..Default::default()
        }],
        _ => vec![
            PolicyRule {
                api_groups: Some(vec!["".into()]),
                resources: Some(core_read_resources),
                verbs: verbs.clone(),
                ..Default::default()
            },
            PolicyRule {
                api_groups: Some(vec!["apps".into()]),
                resources: Some(apps_resources),
                verbs: verbs.clone(),
                ..Default::default()
            },
            PolicyRule {
                api_groups: Some(vec!["batch".into()]),
                resources: Some(batch_resources),
                verbs: verbs.clone(),
                ..Default::default()
            },
            PolicyRule {
                api_groups: Some(vec!["networking.k8s.io".into()]),
                resources: Some(net_resources),
                verbs: verbs.clone(),
                ..Default::default()
            },
            PolicyRule {
                api_groups: Some(vec!["autoscaling".into()]),
                resources: Some(autoscaling_resources),
                verbs: verbs.clone(),
                ..Default::default()
            },
        ],
    }
}

async fn upsert_sa(
    client: &Client,
    ns: &str,
    name: &str,
    member: &str,
    template: AccessTemplate,
    mode: TokenMode,
) -> AppResult<()> {
    let api: Api<ServiceAccount> = Api::namespaced(client.clone(), ns);
    let sa = ServiceAccount {
        metadata: ObjectMeta {
            name: Some(name.into()),
            namespace: Some(ns.into()),
            labels: Some(sa_labels_with_mode(member, template, mode)),
            ..Default::default()
        },
        ..Default::default()
    };
    let pp = PatchParams::apply("lumen").force();
    api.patch(name, &pp, &Patch::Apply(&sa))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(())
}

async fn upsert_role(
    client: &Client,
    ns: &str,
    name: &str,
    member: &str,
    template: AccessTemplate,
    rules: &[PolicyRule],
) -> AppResult<()> {
    let api: Api<Role> = Api::namespaced(client.clone(), ns);
    let role = Role {
        metadata: ObjectMeta {
            name: Some(name.into()),
            namespace: Some(ns.into()),
            labels: Some(lumen_labels(member, template)),
            ..Default::default()
        },
        rules: Some(rules.to_vec()),
    };
    let pp = PatchParams::apply("lumen").force();
    api.patch(name, &pp, &Patch::Apply(&role))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(())
}

async fn upsert_cluster_role(
    client: &Client,
    name: &str,
    member: &str,
    template: AccessTemplate,
    rules: &[PolicyRule],
) -> AppResult<()> {
    let api: Api<ClusterRole> = Api::all(client.clone());
    let cr = ClusterRole {
        metadata: ObjectMeta {
            name: Some(name.into()),
            labels: Some(lumen_labels(member, template)),
            ..Default::default()
        },
        rules: Some(rules.to_vec()),
        aggregation_rule: None,
    };
    let pp = PatchParams::apply("lumen").force();
    api.patch(name, &pp, &Patch::Apply(&cr))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(())
}

struct RoleBindingTarget<'a> {
    namespace: &'a str,
    binding_name: &'a str,
    role_name: &'a str,
    service_account_name: &'a str,
    service_account_namespace: &'a str,
    member: &'a str,
    template: AccessTemplate,
}

async fn upsert_binding_to_role(client: &Client, target: RoleBindingTarget<'_>) -> AppResult<()> {
    let RoleBindingTarget {
        namespace,
        binding_name,
        role_name,
        service_account_name,
        service_account_namespace,
        member,
        template,
    } = target;
    let api: Api<RoleBinding> = Api::namespaced(client.clone(), namespace);
    let rb = RoleBinding {
        metadata: ObjectMeta {
            name: Some(binding_name.into()),
            namespace: Some(namespace.into()),
            labels: Some(lumen_labels(member, template)),
            ..Default::default()
        },
        role_ref: RoleRef {
            api_group: "rbac.authorization.k8s.io".into(),
            kind: "Role".into(),
            name: role_name.into(),
        },
        subjects: Some(vec![Subject {
            kind: "ServiceAccount".into(),
            name: service_account_name.into(),
            namespace: Some(service_account_namespace.into()),
            api_group: None,
        }]),
    };
    let pp = PatchParams::apply("lumen").force();
    api.patch(binding_name, &pp, &Patch::Apply(&rb))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(())
}

async fn upsert_cluster_binding(
    client: &Client,
    binding_name: &str,
    cluster_role: &str,
    sa_name: &str,
    sa_ns: &str,
    member: &str,
    template: AccessTemplate,
) -> AppResult<()> {
    let api: Api<ClusterRoleBinding> = Api::all(client.clone());
    let crb = ClusterRoleBinding {
        metadata: ObjectMeta {
            name: Some(binding_name.into()),
            labels: Some(lumen_labels(member, template)),
            ..Default::default()
        },
        role_ref: RoleRef {
            api_group: "rbac.authorization.k8s.io".into(),
            kind: "ClusterRole".into(),
            name: cluster_role.into(),
        },
        subjects: Some(vec![Subject {
            kind: "ServiceAccount".into(),
            name: sa_name.into(),
            namespace: Some(sa_ns.into()),
            api_group: None,
        }]),
    };
    let pp = PatchParams::apply("lumen").force();
    api.patch(binding_name, &pp, &Patch::Apply(&crb))
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    Ok(())
}

/// Issue a short-lived token via the TokenRequest subresource.
async fn issue_token(
    client: &Client,
    ns: &str,
    sa_name: &str,
    ttl_seconds: i64,
) -> AppResult<(String, String)> {
    let path = format!("/api/v1/namespaces/{ns}/serviceaccounts/{sa_name}/token");
    let tr = TokenRequest {
        metadata: ObjectMeta::default(),
        spec: TokenRequestSpec {
            audiences: vec![],
            expiration_seconds: Some(ttl_seconds),
            bound_object_ref: None,
        },
        status: None,
    };
    let body = serde_json::to_vec(&tr)
        .map_err(|e| AppError::Internal(format!("token request marshal: {e}")))?;
    let req = http::Request::builder()
        .method("POST")
        .uri(&path)
        .header("content-type", "application/json")
        .body(body)
        .map_err(|e| AppError::Internal(format!("token request build: {e}")))?;
    let resp: TokenRequest = client
        .request(req)
        .await
        .map_err(|e| AppError::K8s(format!("TokenRequest failed: {e}")))?;
    let status = resp
        .status
        .ok_or_else(|| AppError::K8s("TokenRequest returned no status".into()))?;
    Ok((status.token, status.expiration_timestamp.0.to_rfc3339()))
}

/// Produce a kubeconfig YAML string using the token and the cluster endpoint
/// (copied from the admin's own kubeconfig).
fn render_kubeconfig(
    ctx_name: &str,
    server: &str,
    ca_data_b64: Option<&str>,
    insecure: bool,
    sa_name: &str,
    sa_ns: &str,
    token: &str,
) -> String {
    let ca_line = match ca_data_b64 {
        Some(b) => format!("    certificate-authority-data: {b}\n"),
        None if insecure => "    insecure-skip-tls-verify: true\n".to_string(),
        None => "".into(),
    };
    format!(
        r#"apiVersion: v1
kind: Config
current-context: {ctx_name}
clusters:
- name: {ctx_name}
  cluster:
    server: {server}
{ca_line}contexts:
- name: {ctx_name}
  context:
    cluster: {ctx_name}
    user: {sa_name}
    namespace: {sa_ns}
users:
- name: {sa_name}
  user:
    token: {token}
"#
    )
}

fn extract_cluster_endpoint(
    kc: &kube::config::Kubeconfig,
    ctx_name: &str,
) -> AppResult<(String, Option<String>, bool)> {
    let ctx = kc
        .contexts
        .iter()
        .find(|c| c.name == ctx_name)
        .ok_or_else(|| AppError::Kubeconfig(format!("context '{ctx_name}' not found")))?
        .context
        .clone()
        .ok_or_else(|| AppError::Kubeconfig("context entry empty".into()))?;
    let cluster = kc
        .clusters
        .iter()
        .find(|c| c.name == ctx.cluster)
        .ok_or_else(|| {
            AppError::Kubeconfig(format!("cluster '{}' not in kubeconfig", ctx.cluster))
        })?
        .cluster
        .clone()
        .ok_or_else(|| AppError::Kubeconfig("cluster entry empty".into()))?;
    let server = cluster
        .server
        .ok_or_else(|| AppError::Kubeconfig("cluster has no server URL".into()))?;
    let insecure = cluster.insecure_skip_tls_verify.unwrap_or(false);
    let ca_b64 = cluster.certificate_authority_data.clone();
    Ok((server, ca_b64, insecure))
}

pub async fn provision(
    client: &Client,
    context_name: &str,
    kc: &kube::config::Kubeconfig,
    req: TeamAccessRequest,
) -> AppResult<TeamAccessResult> {
    validate_member_id(&req.member_id)?;
    let ttl_seconds = req.ttl_hours.clamp(1, 24) * 3600;
    let cluster_wide = req.namespaces.is_empty();
    let sa_ns = req
        .service_account_namespace
        .clone()
        .or_else(|| req.namespaces.first().cloned())
        .unwrap_or_else(|| "default".to_string());

    let sa = sa_name(&req.member_id);
    let role = role_name(&req.member_id);
    let rules = rules_for(req.template);

    let mut created: Vec<CreatedObject> = Vec::new();

    let mode = if req.long_lived {
        TokenMode::Long
    } else {
        TokenMode::Short
    };

    // 1. ServiceAccount in the SA namespace.
    upsert_sa(client, &sa_ns, &sa, &req.member_id, req.template, mode).await?;
    created.push(CreatedObject {
        kind: "ServiceAccount".into(),
        name: sa.clone(),
        namespace: Some(sa_ns.clone()),
    });

    if cluster_wide {
        upsert_cluster_role(client, &role, &req.member_id, req.template, &rules).await?;
        created.push(CreatedObject {
            kind: "ClusterRole".into(),
            name: role.clone(),
            namespace: None,
        });
        let bn = format!("lumen-team-{}-cluster", req.member_id);
        upsert_cluster_binding(
            client,
            &bn,
            &role,
            &sa,
            &sa_ns,
            &req.member_id,
            req.template,
        )
        .await?;
        created.push(CreatedObject {
            kind: "ClusterRoleBinding".into(),
            name: bn,
            namespace: None,
        });
    } else {
        for ns in &req.namespaces {
            upsert_role(client, ns, &role, &req.member_id, req.template, &rules).await?;
            created.push(CreatedObject {
                kind: "Role".into(),
                name: role.clone(),
                namespace: Some(ns.clone()),
            });
            let bn = binding_name(&req.member_id, ns);
            upsert_binding_to_role(
                client,
                RoleBindingTarget {
                    namespace: ns,
                    binding_name: &bn,
                    role_name: &role,
                    service_account_name: &sa,
                    service_account_namespace: &sa_ns,
                    member: &req.member_id,
                    template: req.template,
                },
            )
            .await?;
            created.push(CreatedObject {
                kind: "RoleBinding".into(),
                name: bn,
                namespace: Some(ns.clone()),
            });
        }
    }

    // 2. Issue the token. Long-lived uses a Secret-typed token; short-lived
    //    uses the TokenRequest subresource.
    let (token, expires_at) = if req.long_lived {
        let tok = issue_long_lived_token(client, &sa_ns, &sa, &req.member_id, req.template).await?;
        created.push(CreatedObject {
            kind: "Secret".into(),
            name: token_secret_name(&req.member_id),
            namespace: Some(sa_ns.clone()),
        });
        (tok, "never (long-lived — revoke to invalidate)".to_string())
    } else {
        issue_token(client, &sa_ns, &sa, ttl_seconds).await?
    };

    // 3. Render kubeconfig using the admin's current cluster endpoint.
    let (server, ca_b64, insecure) = extract_cluster_endpoint(kc, context_name)?;
    let kubeconfig = render_kubeconfig(
        context_name,
        &server,
        ca_b64.as_deref(),
        insecure,
        &sa,
        &sa_ns,
        &token,
    );

    Ok(TeamAccessResult {
        service_account: sa,
        sa_namespace: sa_ns,
        token_expires_at: expires_at,
        kubeconfig_yaml: kubeconfig,
        created,
    })
}

// ─── Token renewal: reissue against an existing SA, no RBAC churn ────────

/// Mint a fresh short-lived token for an existing Lumen-managed SA and emit
/// a new kubeconfig. Does not touch Role/Binding/ClusterRole. Fails loudly
/// if the SA does not exist — callers should re-run the full provision
/// wizard in that case.
pub async fn renew_token(
    client: &Client,
    context_name: &str,
    kc: &kube::config::Kubeconfig,
    member_id: &str,
    ttl_hours: i64,
) -> AppResult<TeamAccessResult> {
    validate_member_id(member_id)?;
    let ttl_seconds = ttl_hours.clamp(1, 24) * 3600;
    let sa = sa_name(member_id);

    // Find which namespace the SA lives in. We stamp every Lumen SA with
    // `app.kubernetes.io/managed-by=lumen`, so we can locate it across all
    // namespaces in one list call.
    let sa_api: Api<ServiceAccount> = Api::all(client.clone());
    let lp = kube::api::ListParams::default().labels(&member_label_selector());
    let list = sa_api
        .list(&lp)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let sa_obj = list
        .items
        .into_iter()
        .find(|o| o.metadata.name.as_deref() == Some(sa.as_str()))
        .ok_or_else(|| {
            AppError::K8s(format!(
                "no Lumen-managed ServiceAccount found for '{member_id}'. Re-run the provisioning wizard."
            ))
        })?;
    let sa_ns = sa_obj
        .metadata
        .namespace
        .clone()
        .ok_or_else(|| AppError::K8s("SA has no namespace".into()))?;

    let sa_labels = labels_of(&sa_obj.metadata);
    let mode = sa_labels
        .get(LUMEN_TOKEN_MODE_LABEL)
        .and_then(|s| TokenMode::from_str(s))
        .unwrap_or(TokenMode::Short);

    let (token, expires_at) = match mode {
        TokenMode::Short => issue_token(client, &sa_ns, &sa, ttl_seconds).await?,
        TokenMode::Long => {
            let t = read_long_lived_token(client, &sa_ns, member_id).await?;
            (t, "never (long-lived — revoke to invalidate)".to_string())
        }
    };

    let (server, ca_b64, insecure) = extract_cluster_endpoint(kc, context_name)?;
    let kubeconfig = render_kubeconfig(
        context_name,
        &server,
        ca_b64.as_deref(),
        insecure,
        &sa,
        &sa_ns,
        &token,
    );

    Ok(TeamAccessResult {
        service_account: sa,
        sa_namespace: sa_ns,
        token_expires_at: expires_at,
        kubeconfig_yaml: kubeconfig,
        created: Vec::new(),
    })
}

/// Rotate a long-lived Secret-typed ServiceAccount token by deleting the
/// existing Secret and recreating it. The kube-controller-manager populates
/// `.data.token` with a fresh value on recreate. Errors out if the SA is
/// not in long-lived mode (the caller should use `renew_token` for short-
/// lived rotation, which already issues a brand new TokenRequest).
pub async fn rotate_long_lived_token(
    client: &Client,
    context_name: &str,
    kc: &kube::config::Kubeconfig,
    member_id: &str,
) -> AppResult<TeamAccessResult> {
    use k8s_openapi::api::core::v1::Secret;

    validate_member_id(member_id)?;
    let sa = sa_name(member_id);

    let sa_api: Api<ServiceAccount> = Api::all(client.clone());
    let lp = kube::api::ListParams::default().labels(&member_label_selector());
    let list = sa_api
        .list(&lp)
        .await
        .map_err(|e| AppError::K8s(e.to_string()))?;
    let sa_obj = list
        .items
        .into_iter()
        .find(|o| o.metadata.name.as_deref() == Some(sa.as_str()))
        .ok_or_else(|| {
            AppError::K8s(format!(
                "no Lumen-managed ServiceAccount found for '{member_id}'. Re-run the provisioning wizard."
            ))
        })?;
    let sa_ns = sa_obj
        .metadata
        .namespace
        .clone()
        .ok_or_else(|| AppError::K8s("SA has no namespace".into()))?;

    let sa_labels = labels_of(&sa_obj.metadata);
    let mode = sa_labels
        .get(LUMEN_TOKEN_MODE_LABEL)
        .and_then(|s| TokenMode::from_str(s))
        .unwrap_or(TokenMode::Short);
    if mode != TokenMode::Long {
        return Err(AppError::K8s(
            "rotate is only valid for long-lived tokens. Use renew for short-lived tokens.".into(),
        ));
    }

    let template = pick_template(&sa_labels)
        .ok_or_else(|| AppError::K8s("SA missing template label — cannot rotate".into()))?;

    // Delete the existing Secret. The kubelet token-controller will repopulate
    // `.data.token` on the next apply with a brand new JWT.
    let secret_api: Api<Secret> = Api::namespaced(client.clone(), &sa_ns);
    let secret_name = token_secret_name(member_id);
    let dp = kube::api::DeleteParams::default();
    match secret_api.delete(&secret_name, &dp).await {
        Ok(_) => {}
        Err(kube::Error::Api(e)) if e.code == 404 => {}
        Err(e) => return Err(AppError::K8s(format!("delete old token Secret: {e}"))),
    }

    let token = issue_long_lived_token(client, &sa_ns, &sa, member_id, template).await?;

    let (server, ca_b64, insecure) = extract_cluster_endpoint(kc, context_name)?;
    let kubeconfig = render_kubeconfig(
        context_name,
        &server,
        ca_b64.as_deref(),
        insecure,
        &sa,
        &sa_ns,
        &token,
    );

    Ok(TeamAccessResult {
        service_account: sa,
        sa_namespace: sa_ns,
        token_expires_at: "never (long-lived — rotated)".to_string(),
        kubeconfig_yaml: kubeconfig,
        created: Vec::new(),
    })
}

// ─── Clean-up helper: delete everything Lumen provisioned for a member ───

pub async fn revoke(
    client: &Client,
    member_id: &str,
    namespaces: Vec<String>,
) -> AppResult<Vec<CreatedObject>> {
    validate_member_id(member_id)?;
    let sa = sa_name(member_id);
    let role = role_name(member_id);
    let mut deleted: Vec<CreatedObject> = Vec::new();
    let dp = kube::api::DeleteParams::default();

    let discover_ns = namespaces.clone();

    // Cluster-level objects always try.
    let _ = Api::<ClusterRole>::all(client.clone())
        .delete(&role, &dp)
        .await;
    deleted.push(CreatedObject {
        kind: "ClusterRole".into(),
        name: role.clone(),
        namespace: None,
    });
    let cb = format!("lumen-team-{member_id}-cluster");
    let _ = Api::<ClusterRoleBinding>::all(client.clone())
        .delete(&cb, &dp)
        .await;
    deleted.push(CreatedObject {
        kind: "ClusterRoleBinding".into(),
        name: cb,
        namespace: None,
    });

    use k8s_openapi::api::core::v1::Secret;

    for ns in &discover_ns {
        let _ = Api::<RoleBinding>::namespaced(client.clone(), ns)
            .delete(&binding_name(member_id, ns), &dp)
            .await;
        deleted.push(CreatedObject {
            kind: "RoleBinding".into(),
            name: binding_name(member_id, ns),
            namespace: Some(ns.clone()),
        });
        let _ = Api::<Role>::namespaced(client.clone(), ns)
            .delete(&role, &dp)
            .await;
        deleted.push(CreatedObject {
            kind: "Role".into(),
            name: role.clone(),
            namespace: Some(ns.clone()),
        });
        // Long-lived token Secret, if any — irreversibly invalidates all
        // issued long-lived tokens for this member.
        let _ = Api::<Secret>::namespaced(client.clone(), ns)
            .delete(&token_secret_name(member_id), &dp)
            .await;
        // ServiceAccount lives in the first ns or caller-specified ns; try all
        // listed namespaces to be safe.
        let _ = Api::<ServiceAccount>::namespaced(client.clone(), ns)
            .delete(&sa, &dp)
            .await;
    }
    deleted.push(CreatedObject {
        kind: "ServiceAccount".into(),
        name: sa,
        namespace: discover_ns.first().cloned(),
    });

    Ok(deleted)
}

// ─── Listing existing grants ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TeamGrant {
    pub member_id: String,
    pub template: Option<AccessTemplate>,
    pub token_mode: Option<TokenMode>,
    pub service_account: Option<String>,
    pub sa_namespace: Option<String>,
    pub sa_age_seconds: i64,
    pub cluster_wide: bool,
    pub namespaces: Vec<String>,
    pub object_count: i32,
}

fn member_label_selector() -> String {
    format!("{LUMEN_MANAGED_LABEL}={LUMEN_MANAGED_VALUE}")
}

fn pick_owner(labels: &std::collections::BTreeMap<String, String>) -> Option<String> {
    labels.get(LUMEN_OWNER_LABEL).cloned()
}

fn pick_template(labels: &std::collections::BTreeMap<String, String>) -> Option<AccessTemplate> {
    labels
        .get(LUMEN_TEMPLATE_LABEL)
        .and_then(|s| template_from_str(s))
}

fn labels_of(
    meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta,
) -> std::collections::BTreeMap<String, String> {
    meta.labels
        .clone()
        .map(|m| m.into_iter().collect())
        .unwrap_or_default()
}

fn age_of(meta: &k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta) -> i64 {
    meta.creation_timestamp
        .as_ref()
        .map(|t| (chrono::Utc::now() - t.0).num_seconds().max(0))
        .unwrap_or(0)
}

pub async fn list_grants(client: &Client) -> AppResult<Vec<TeamGrant>> {
    use kube::api::ListParams;
    let lp = ListParams::default().labels(&member_label_selector());

    let sa_api: Api<ServiceAccount> = Api::all(client.clone());
    let rb_api: Api<RoleBinding> = Api::all(client.clone());
    let crb_api: Api<ClusterRoleBinding> = Api::all(client.clone());

    let (sa_list, rb_list, crb_list) =
        tokio::join!(sa_api.list(&lp), rb_api.list(&lp), crb_api.list(&lp),);
    let sa_items = sa_list.map_err(|e| AppError::K8s(e.to_string()))?.items;
    let rb_items = rb_list.map_err(|e| AppError::K8s(e.to_string()))?.items;
    let crb_items = crb_list.map_err(|e| AppError::K8s(e.to_string()))?.items;

    // Roll up everything by member id.
    use std::collections::BTreeMap;
    let mut by_member: BTreeMap<String, TeamGrant> = BTreeMap::new();

    for sa in &sa_items {
        let labels = labels_of(&sa.metadata);
        if let Some(member) = pick_owner(&labels) {
            let entry = by_member.entry(member.clone()).or_insert(TeamGrant {
                member_id: member.clone(),
                template: None,
                token_mode: None,
                service_account: None,
                sa_namespace: None,
                sa_age_seconds: 0,
                cluster_wide: false,
                namespaces: Vec::new(),
                object_count: 0,
            });
            entry.service_account = sa.metadata.name.clone();
            entry.sa_namespace = sa.metadata.namespace.clone();
            entry.sa_age_seconds = age_of(&sa.metadata);
            if entry.template.is_none() {
                entry.template = pick_template(&labels);
            }
            if entry.token_mode.is_none() {
                entry.token_mode = labels
                    .get(LUMEN_TOKEN_MODE_LABEL)
                    .and_then(|s| TokenMode::from_str(s));
            }
            entry.object_count += 1;
        }
    }
    for rb in &rb_items {
        let labels = labels_of(&rb.metadata);
        if let Some(member) = pick_owner(&labels) {
            let entry = by_member.entry(member.clone()).or_insert(TeamGrant {
                member_id: member.clone(),
                template: None,
                token_mode: None,
                service_account: None,
                sa_namespace: None,
                sa_age_seconds: 0,
                cluster_wide: false,
                namespaces: Vec::new(),
                object_count: 0,
            });
            if entry.template.is_none() {
                entry.template = pick_template(&labels);
            }
            if let Some(ns) = rb.metadata.namespace.clone() {
                if !entry.namespaces.contains(&ns) {
                    entry.namespaces.push(ns);
                }
            }
            entry.object_count += 1;
        }
    }
    for crb in &crb_items {
        let labels = labels_of(&crb.metadata);
        if let Some(member) = pick_owner(&labels) {
            let entry = by_member.entry(member.clone()).or_insert(TeamGrant {
                member_id: member.clone(),
                template: None,
                token_mode: None,
                service_account: None,
                sa_namespace: None,
                sa_age_seconds: 0,
                cluster_wide: false,
                namespaces: Vec::new(),
                object_count: 0,
            });
            entry.cluster_wide = true;
            if entry.template.is_none() {
                entry.template = pick_template(&labels);
            }
            entry.object_count += 1;
        }
    }

    let mut out: Vec<TeamGrant> = by_member.into_values().collect();
    out.sort_by(|a, b| a.member_id.cmp(&b.member_id));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_member_id() {
        validate_member_id("alice").unwrap();
        validate_member_id("alice-smith-1").unwrap();
        assert!(validate_member_id("").is_err());
        assert!(validate_member_id("Alice").is_err());
        assert!(validate_member_id("-alice").is_err());
        assert!(validate_member_id("alice-").is_err());
        assert!(validate_member_id("alice_smith").is_err());
    }

    #[test]
    fn viewer_rules_are_read_only() {
        let rules = rules_for(AccessTemplate::Viewer);
        for r in &rules {
            for v in &r.verbs {
                assert!(["get", "list", "watch"].contains(&v.as_str()));
            }
        }
    }

    #[test]
    fn editor_rules_include_write_verbs() {
        let rules = rules_for(AccessTemplate::Editor);
        let has_create = rules.iter().any(|r| r.verbs.iter().any(|v| v == "create"));
        assert!(has_create);
    }

    #[test]
    fn admin_rules_are_wildcard() {
        let rules = rules_for(AccessTemplate::Admin);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].resources.as_deref(), Some(&["*".into()][..]));
    }

    #[test]
    fn renders_kubeconfig_with_ca() {
        let kc = render_kubeconfig(
            "prod",
            "https://api.example.com",
            Some("Y2E="),
            false,
            "lumen-team-alice",
            "default",
            "xyz",
        );
        assert!(kc.contains("server: https://api.example.com"));
        assert!(kc.contains("certificate-authority-data: Y2E="));
        assert!(kc.contains("token: xyz"));
    }

    #[test]
    fn renders_kubeconfig_insecure_when_no_ca() {
        let kc = render_kubeconfig(
            "dev",
            "https://kind.local",
            None,
            true,
            "lumen-team-alice",
            "default",
            "xyz",
        );
        assert!(kc.contains("insecure-skip-tls-verify: true"));
    }
}
