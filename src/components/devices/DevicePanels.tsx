import { DevicePagination, useDevicePagination } from "./DevicePagination";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  buildDeviceInventory,
  allocationInventory,
  buildAllocationInventoryIndex,
  objects,
  deviceHealth,
  object,
  podClaimLinks,
  resourceName,
  resourceNamespace,
  string,
  type DeviceSnapshot,
  type DeviceSource,
} from "@/lib/deviceResources";
import { SectionPanel, PanelHeading } from "@/components/lumen/page";

export function DeviceSourceNotice({
  source,
  label,
}: {
  source: DeviceSource;
  label: string;
}) {
  if (source.state === "available") return null;
  const reason = {
    unsupported: "API not served by this cluster",
    forbidden: "access denied by cluster permissions",
    error: "could not load resources",
  }[source.state];
  return (
    <div
      role="status"
      className="rounded-control border border-border-default bg-elevated p-3 text-xs text-text-secondary"
    >
      <strong>
        {label}: {reason}.
      </strong>
      {source.message && <p className="mt-1 break-words">{source.message}</p>}
    </div>
  );
}

export function PodDevicesPanel({
  snapshot,
  podName,
  namespace,
}: {
  snapshot: DeviceSnapshot;
  podName: string;
  namespace: string;
}) {
  const pod =
    snapshot.pods.state === "available"
      ? snapshot.pods.items.find(
          (item) =>
            resourceName(item) === podName &&
            resourceNamespace(item) === namespace,
        )
      : undefined;
  const links = pod ? podClaimLinks(pod, snapshot) : [];
  const inventoryIndex = useMemo(
    () => buildAllocationInventoryIndex(snapshot),
    [snapshot],
  );
  const terminal =
    pod && ["Succeeded", "Failed"].includes(string(object(pod.status).phase));
  return (
    <SectionPanel>
      <PanelHeading
        eyebrow="Pod allocation"
        title={`${namespace}/${podName}`}
      />
      <DeviceSourceNotice source={snapshot.pods} label="Pods" />
      {snapshot.pods.state === "available" && !pod && (
        <p className="text-sm text-text-muted">
          Pod not found in this snapshot. It may have been deleted or moved
          outside the selected namespace.
        </p>
      )}
      {pod && (
        <>
          <p className="mb-3 text-xs text-text-muted">
            Reported device health depends on driver support and cluster
            configuration. Missing reports are unknown.
            {terminal &&
              " This pod has terminated; health reports may no longer update."}
          </p>
          {!links.length && (
            <p className="text-sm text-text-secondary">
              This pod has no DRA resource claim references.
            </p>
          )}
          <div className="space-y-3">
            {links.map((link) => (
              <div
                key={link.alias}
                className="rounded-control border border-border-default p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <strong>{link.alias}</strong>
                  <span className="text-text-muted">→</span>
                  <span className="font-mono">
                    {link.claimName || "claim not created"}
                  </span>
                </div>
                {link.templateName && (
                  <p className="mt-1 text-xs text-text-secondary">
                    Template: {link.templateName}
                    {link.templateState === "missing"
                      ? " · not present in this snapshot"
                      : link.templateState === "unavailable"
                        ? " · source unavailable"
                        : ""}
                  </p>
                )}
                {link.state !== "resolved" ? (
                  <p className="mt-2 text-xs text-warning">
                    {
                      {
                        "awaiting-claim":
                          "Waiting for the pod controller to report a generated claim.",
                        missing:
                          "Referenced claim is missing from this namespace snapshot.",
                        unavailable:
                          "Claim details are unavailable; check the claims source status.",
                      }[link.state]
                    }
                  </p>
                ) : !link.allocations.length ? (
                  <p className="mt-2 text-xs text-text-secondary">
                    No devices allocated yet.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {link.allocations.map((allocation, index) => {
                      const reports = deviceHealth(pod, link.alias, allocation);
                      const inventory = allocationInventory(
                        snapshot,
                        allocation,
                        inventoryIndex,
                      );
                      return (
                        <li
                          key={`${allocation.request}/${allocation.driver}/${allocation.pool}/${allocation.device}/${index}`}
                          className="rounded-control bg-elevated p-3"
                        >
                          <p className="break-all font-mono text-xs">
                            {allocation.driver} / {allocation.pool} /{" "}
                            {allocation.device}
                          </p>
                          <p className="mt-1 text-xs text-text-muted">
                            Request: {allocation.request || "unknown"}
                            {allocation.shared &&
                              " · shared or administrative allocation"}
                          </p>
                          <div className="mt-2 text-xs text-text-secondary">
                            {inventory.state === "unavailable"
                              ? "Inventory unavailable: resource slices could not be read."
                              : inventory.state === "missing"
                                ? "Device absent from the latest published inventory. The allocation may reference an older or incomplete pool."
                                : inventory.devices.map((device) => (
                                    <p key={`${device.slice}/${device.device}`}>
                                      Slice: {device.slice} · {device.placement}{" "}
                                      · generation{" "}
                                      {device.generation ?? "unknown"} ·{" "}
                                      {device.complete
                                        ? "complete pool"
                                        : "incomplete pool"}
                                    </p>
                                  ))}
                          </div>
                          {!reports.length ? (
                            <p className="mt-2 text-xs text-text-secondary">
                              Health unknown · no matching container report
                            </p>
                          ) : (
                            <ul className="mt-2 space-y-1">
                              {reports.map((report, index) => (
                                <li
                                  key={`${report.container}/${index}`}
                                  className={`text-xs ${report.health === "Unhealthy" ? "text-danger" : report.health === "Healthy" ? "text-success" : "text-text-secondary"}`}
                                >
                                  {report.container}: {report.health}
                                  {report.message && ` · ${report.message}`}
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </SectionPanel>
  );
}

export function NodeDevicesPanel({
  snapshot,
  nodeName,
  labels,
}: {
  snapshot: DeviceSnapshot;
  nodeName: string;
  labels?: Record<string, string>;
}) {
  const inventory = useMemo(
    () => buildDeviceInventory(snapshot, nodeName, labels),
    [snapshot, nodeName, labels],
  );
  const possible = inventory.filter(
    (device) => device.access !== "inaccessible",
  );
  const pagination = useDevicePagination(
    possible,
    JSON.stringify([snapshot.namespace, nodeName]),
  );
  return (
    <SectionPanel>
      <PanelHeading
        eyebrow="Node inventory"
        title={nodeName}
        meta={`${possible.filter((device) => device.access === "accessible").length} devices with confirmed node access`}
      />
      <DeviceSourceNotice source={snapshot.slices} label="Resource slices" />
      <p className="mb-3 text-xs text-text-muted">
        Published inventory does not measure free capacity. Shared devices and
        incomplete pools cannot be counted as available slots. Node selectors
        remain unknown when node labels are unavailable.
      </p>
      {snapshot.slices.state === "available" &&
        (!possible.length ? (
          <p className="text-sm text-text-secondary">
            No published devices with confirmed or unknown access to this node.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-text-muted">
                <tr>
                  <th className="p-2">Device</th>
                  <th className="p-2">Node access</th>
                  <th className="p-2">Pool snapshot</th>
                </tr>
              </thead>
              <tbody>
                {pagination.items.map((device, index) => (
                  <tr
                    key={`${device.slice}/${device.device}/${index}`}
                    className="border-t border-border-subtle"
                  >
                    <td className="p-2">
                      <div className="font-medium">{device.device}</div>
                      <div className="mt-1 break-all text-text-muted">
                        {device.driver} / {device.pool}
                      </div>
                      {device.shared && (
                        <span className="text-warning">Shareable</span>
                      )}
                    </td>
                    <td className="p-2">
                      {device.access === "accessible" ? "Confirmed" : "Unknown"}
                      <div className="mt-1 text-text-muted">
                        {device.placement}
                      </div>
                    </td>
                    <td className="p-2">
                      Generation {device.generation ?? "unknown"}
                      <div
                        className={`mt-1 ${device.complete ? "text-text-muted" : "text-warning"}`}
                      >
                        {device.complete ? "Complete" : "Incomplete"} ·{" "}
                        {device.observedSlices}/{device.expectedSlices ?? "?"}{" "}
                        slices
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {snapshot.slices.state === "available" && (
        <DevicePagination pagination={pagination} label="devices" />
      )}
    </SectionPanel>
  );
}

export function DevicePodLinks({
  snapshot,
  context,
}: {
  snapshot: DeviceSnapshot;
  context: string;
}) {
  const pods =
    snapshot.pods.state === "available"
      ? snapshot.pods.items.filter(
          (pod) => objects(object(pod.spec).resourceClaims).length > 0,
        )
      : [];
  const pagination = useDevicePagination(
    pods,
    JSON.stringify([context, snapshot.namespace]),
  );
  return (
    <SectionPanel>
      <PanelHeading
        eyebrow="Workloads"
        title="Pods requesting devices"
        meta={`${pods.length} in selected scope`}
      />
      <DeviceSourceNotice source={snapshot.pods} label="Pods" />
      {snapshot.pods.state === "available" &&
        (!pods.length ? (
          <p className="text-sm text-text-muted">
            No pods reference DRA claims in this scope.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {pagination.items.map((pod) => (
              <li key={`${resourceNamespace(pod)}/${resourceName(pod)}`}>
                <Link
                  className="inline-flex rounded-control border border-border-default px-3 py-2 text-xs text-accent-primary hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                  to={`/cluster/${encodeURIComponent(context)}/device-resources?${new URLSearchParams({ ns: resourceNamespace(pod), pod: resourceName(pod) })}`}
                >
                  {resourceNamespace(pod)}/{resourceName(pod)}
                </Link>
              </li>
            ))}
          </ul>
        ))}
      {snapshot.pods.state === "available" && (
        <DevicePagination pagination={pagination} label="pods" />
      )}
    </SectionPanel>
  );
}
