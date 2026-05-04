use crate::k8s::types::{RbacRuleDetail, RbacSubjectDetail};
use k8s_openapi::api::rbac::v1::{PolicyRule, RoleRef, Subject};

fn values_or_star(values: Option<&Vec<String>>) -> Vec<String> {
    values
        .filter(|values| !values.is_empty())
        .cloned()
        .unwrap_or_else(|| vec!["*".to_string()])
}

pub fn rule_details(rules: Option<&Vec<PolicyRule>>) -> Vec<RbacRuleDetail> {
    rules
        .into_iter()
        .flatten()
        .map(|rule| RbacRuleDetail {
            api_groups: values_or_star(rule.api_groups.as_ref()),
            resources: values_or_star(rule.resources.as_ref()),
            resource_names: rule.resource_names.clone().unwrap_or_default(),
            non_resource_urls: rule.non_resource_urls.clone().unwrap_or_default(),
            verbs: if rule.verbs.is_empty() {
                vec!["*".to_string()]
            } else {
                rule.verbs.clone()
            },
        })
        .collect()
}

pub fn subject_details(subjects: Option<&Vec<Subject>>) -> Vec<RbacSubjectDetail> {
    subjects
        .into_iter()
        .flatten()
        .map(|subject| RbacSubjectDetail {
            kind: subject.kind.clone(),
            name: subject.name.clone(),
            namespace: subject.namespace.clone(),
        })
        .collect()
}

pub fn role_ref_label(role_ref: &RoleRef) -> String {
    format!("{}/{}", role_ref.kind, role_ref.name)
}

#[cfg(test)]
mod tests {
    use super::{role_ref_label, rule_details, subject_details};
    use k8s_openapi::api::rbac::v1::{PolicyRule, RoleRef, Subject};

    #[test]
    fn rule_details_preserve_verbs_resources_and_names() {
        let rules = vec![PolicyRule {
            api_groups: Some(vec!["apps".into()]),
            resources: Some(vec!["deployments".into(), "statefulsets".into()]),
            resource_names: Some(vec!["api".into()]),
            verbs: vec!["get".into(), "patch".into()],
            ..Default::default()
        }];

        let details = rule_details(Some(&rules));

        assert_eq!(details[0].api_groups, vec!["apps"]);
        assert_eq!(details[0].resources, vec!["deployments", "statefulsets"]);
        assert_eq!(details[0].resource_names, vec!["api"]);
        assert_eq!(details[0].verbs, vec!["get", "patch"]);
    }

    #[test]
    fn subject_details_keep_namespace_for_service_accounts() {
        let subjects = vec![Subject {
            kind: "ServiceAccount".into(),
            name: "reader".into(),
            namespace: Some("team-a".into()),
            api_group: None,
        }];

        let details = subject_details(Some(&subjects));

        assert_eq!(details[0].kind, "ServiceAccount");
        assert_eq!(details[0].name, "reader");
        assert_eq!(details[0].namespace.as_deref(), Some("team-a"));
    }

    #[test]
    fn role_ref_label_includes_kind_and_name() {
        let role_ref = RoleRef {
            api_group: "rbac.authorization.k8s.io".into(),
            kind: "ClusterRole".into(),
            name: "view".into(),
        };

        assert_eq!(role_ref_label(&role_ref), "ClusterRole/view");
    }
}
