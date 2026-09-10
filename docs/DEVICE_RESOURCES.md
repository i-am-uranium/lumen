# Device resources

Open **device resources** in the cluster navigation to inspect Kubernetes Dynamic
Resource Allocation (DRA). Pod details link to their claims and reported health;
node details link to device inventory.

## Requirements and scope

Lumen reads `resource.k8s.io/v1`, the stable DRA API introduced in Kubernetes 1.34.
It does not fall back to beta APIs. A DRA driver must publish resources before
hardware inventory appears. This feature does not install drivers or create,
modify, or delete device resources.

The namespace selection applies to ResourceClaims, ResourceClaimTemplates, and
Pods. DeviceClasses and ResourceSlices are cluster-scoped. Each source uses the
permissions of the selected kubeconfig context. A user who can list claims in
one namespace can still inspect those claims when cluster-scoped reads are denied.
Enter a known namespace in the namespace picker if namespace discovery is denied.

API absence, denied access, request errors, and a successful empty list have
different messages. Successful sources remain usable if another source fails.
Refresh takes a new observation; the displayed capture time is not a driver
health-update timestamp. The independent list operations are not an atomic
snapshot across all objects.

## Claims, inventory, and health

Claims show allocated device identities. For a pod, Lumen resolves direct claim
references or generated claim names from pod status, then locates devices using
the driver, pool, and device tuple. Missing claims, pending allocations, and
unavailable inventory are distinct states.

Inventory uses the latest observed generation of each driver pool. Its expected
slice count determines whether the pool observation is complete. Node-name and
all-node placement can establish node access; selector-based placement remains
unknown when the required node labels are unavailable. A published device is not
necessarily unused. Sharing, administrative allocations, incomplete data, and
restricted namespace visibility prevent reliable global free-device counts.

Health comes from matching per-container Kubernetes status reports. Whole-claim
and individual-request reports are supported. A consuming container without a
matching report is shown as unknown. Terminated pods can retain old reports.
Lumen does not probe hardware, infer health from pod readiness, or measure GPU
utilization. Driver support and cluster feature configuration determine which
health reports exist.

The inspector displays sanitized JSON, which is also valid YAML syntax. It
removes annotations and managed fields, and redacts opaque configuration and
arbitrary driver status data. This inspection view is not an export for replaying
the complete original manifest.

## Bounds and verification

Native requests paginate at 500 objects per page, with a 10,000-object cap per
source and a 15-second source deadline. Discovery and client setup have separate
deadlines. A truncated or failed source is never presented as a complete inventory.

Unit tests exercise API discovery, authorization, pagination, deadlines,
redaction, claim relationships, health matching, and UI source states. The
`devices_cluster` integration test runs through `scripts/test-kind.sh` using a
disposable cluster and an isolated kubeconfig. It verifies real API schemas,
namespace isolation, read-only RBAC and sanitized responses with synthetic device
resources. It does not establish hardware allocation or real driver health behavior.

## YAML draft review

The shared YAML editor offers **Review changes**, comparing the edit-start
snapshot with the unsubmitted draft. **Revert draft** restores that snapshot.
Any text change invalidates earlier dry-run validation. If freshly loaded resource
data differs during editing, the draft is preserved and **Reload latest** explicitly
discards it before further apply attempts. Server dry-run output remains separately
visible so admission changes are distinguishable from typed edits.

Revert is a local editing action, not cluster rollback. Dry-run does not lock a
resource against another writer. Existing RBAC, protected-context, confirmation,
and read-only controls continue to apply. For oversized documents, line comparison
shows an explicit unavailable notice; the complete draft remains editable.
