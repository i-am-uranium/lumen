use crate::k8s::types::StorageDetail;
use k8s_openapi::api::core::v1::{PersistentVolume, PersistentVolumeClaim};
use k8s_openapi::api::storage::v1::StorageClass;
use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
use std::collections::BTreeMap;

fn storage_quantity(capacity: &Option<BTreeMap<String, Quantity>>) -> Option<String> {
    capacity
        .as_ref()
        .and_then(|capacity| capacity.get("storage"))
        .map(|quantity| quantity.0.clone())
}

pub fn pvc_detail(pvc: &PersistentVolumeClaim) -> StorageDetail {
    let spec = pvc.spec.as_ref();
    let status = pvc.status.as_ref();
    StorageDetail {
        phase: status.and_then(|status| status.phase.clone()),
        capacity: status.and_then(|status| storage_quantity(&status.capacity)),
        access_modes: spec
            .and_then(|spec| spec.access_modes.clone())
            .unwrap_or_default(),
        storage_class: spec.and_then(|spec| spec.storage_class_name.clone()),
        volume_name: spec.and_then(|spec| spec.volume_name.clone()),
        reclaim_policy: None,
        binding_mode: None,
        provisioner: None,
        allow_expansion: None,
        claim_ref: None,
        parameters: BTreeMap::new(),
    }
}

pub fn pv_detail(pv: &PersistentVolume) -> StorageDetail {
    let spec = pv.spec.as_ref();
    StorageDetail {
        phase: pv.status.as_ref().and_then(|status| status.phase.clone()),
        capacity: spec.and_then(|spec| storage_quantity(&spec.capacity)),
        access_modes: spec
            .and_then(|spec| spec.access_modes.clone())
            .unwrap_or_default(),
        storage_class: spec.and_then(|spec| spec.storage_class_name.clone()),
        volume_name: None,
        reclaim_policy: spec.and_then(|spec| spec.persistent_volume_reclaim_policy.clone()),
        binding_mode: None,
        provisioner: None,
        allow_expansion: None,
        claim_ref: spec.and_then(|spec| {
            let claim = spec.claim_ref.as_ref()?;
            Some(format!(
                "{}/{}",
                claim.namespace.as_deref().unwrap_or(""),
                claim.name.as_deref().unwrap_or("")
            ))
        }),
        parameters: BTreeMap::new(),
    }
}

pub fn storage_class_detail(class: &StorageClass) -> StorageDetail {
    StorageDetail {
        phase: None,
        capacity: None,
        access_modes: vec![],
        storage_class: None,
        volume_name: None,
        reclaim_policy: class.reclaim_policy.clone(),
        binding_mode: class.volume_binding_mode.clone(),
        provisioner: Some(class.provisioner.clone()),
        allow_expansion: class.allow_volume_expansion,
        claim_ref: None,
        parameters: class.parameters.clone().unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::{pv_detail, pvc_detail, storage_class_detail};
    use k8s_openapi::api::core::v1::{
        ObjectReference, PersistentVolume, PersistentVolumeClaim, PersistentVolumeClaimSpec,
        PersistentVolumeClaimStatus, PersistentVolumeSpec,
    };
    use k8s_openapi::api::storage::v1::StorageClass;
    use k8s_openapi::apimachinery::pkg::api::resource::Quantity;
    use std::collections::BTreeMap;

    #[test]
    fn pvc_detail_surfaces_phase_capacity_class_and_bound_volume() {
        let pvc = PersistentVolumeClaim {
            spec: Some(PersistentVolumeClaimSpec {
                access_modes: Some(vec!["ReadWriteOnce".into()]),
                storage_class_name: Some("gp3".into()),
                volume_name: Some("pvc-123".into()),
                ..Default::default()
            }),
            status: Some(PersistentVolumeClaimStatus {
                phase: Some("Bound".into()),
                capacity: Some(BTreeMap::from([(
                    "storage".into(),
                    Quantity("20Gi".into()),
                )])),
                ..Default::default()
            }),
            ..Default::default()
        };

        let detail = pvc_detail(&pvc);

        assert_eq!(detail.phase.as_deref(), Some("Bound"));
        assert_eq!(detail.capacity.as_deref(), Some("20Gi"));
        assert_eq!(detail.storage_class.as_deref(), Some("gp3"));
        assert_eq!(detail.volume_name.as_deref(), Some("pvc-123"));
        assert_eq!(detail.access_modes, vec!["ReadWriteOnce"]);
    }

    #[test]
    fn pv_detail_surfaces_claim_reference_and_reclaim_policy() {
        let pv = PersistentVolume {
            spec: Some(PersistentVolumeSpec {
                capacity: Some(BTreeMap::from([(
                    "storage".into(),
                    Quantity("100Gi".into()),
                )])),
                access_modes: Some(vec!["ReadWriteMany".into()]),
                persistent_volume_reclaim_policy: Some("Retain".into()),
                storage_class_name: Some("efs".into()),
                claim_ref: Some(ObjectReference {
                    namespace: Some("apps".into()),
                    name: Some("uploads".into()),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        };

        let detail = pv_detail(&pv);

        assert_eq!(detail.capacity.as_deref(), Some("100Gi"));
        assert_eq!(detail.claim_ref.as_deref(), Some("apps/uploads"));
        assert_eq!(detail.reclaim_policy.as_deref(), Some("Retain"));
        assert_eq!(detail.storage_class.as_deref(), Some("efs"));
    }

    #[test]
    fn storage_class_detail_surfaces_provisioning_strategy() {
        let class = StorageClass {
            provisioner: "kubernetes.io/aws-ebs".into(),
            reclaim_policy: Some("Delete".into()),
            volume_binding_mode: Some("WaitForFirstConsumer".into()),
            allow_volume_expansion: Some(true),
            parameters: Some(BTreeMap::from([("type".into(), "gp3".into())])),
            ..Default::default()
        };

        let detail = storage_class_detail(&class);

        assert_eq!(detail.provisioner.as_deref(), Some("kubernetes.io/aws-ebs"));
        assert_eq!(detail.binding_mode.as_deref(), Some("WaitForFirstConsumer"));
        assert_eq!(detail.allow_expansion, Some(true));
        assert_eq!(detail.parameters["type"], "gp3");
    }
}
