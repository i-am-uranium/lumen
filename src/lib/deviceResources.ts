import { invoke } from "@tauri-apps/api/core";

export type DeviceObject = Record<string, unknown>;
export type DeviceSource = {
  state: "available" | "unsupported" | "forbidden" | "error";
  items: DeviceObject[];
  message: string | null;
};
export type DeviceSnapshot = {
  namespace: string;
  captured_at: string;
  claims: DeviceSource;
  templates: DeviceSource;
  classes: DeviceSource;
  slices: DeviceSource;
  pods: DeviceSource;
};
export type DeviceCollection = "claims" | "templates" | "classes" | "slices";
export const object = (value: unknown): DeviceObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as DeviceObject)
    : {};
export const objects = (value: unknown): DeviceObject[] =>
  Array.isArray(value) ? value.map(object) : [];
export const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
export const resourceName = (resource: DeviceObject): string =>
  string(object(resource.metadata).name);
export const resourceNamespace = (resource: DeviceObject): string =>
  string(object(resource.metadata).namespace);
export async function fetchDeviceResources(
  context: string,
  namespace: string,
): Promise<DeviceSnapshot> {
  if (!context.trim())
    throw new Error("An explicit cluster context is required.");
  return invoke<DeviceSnapshot>("device_resources_snapshot", {
    context,
    namespace,
  });
}

export type DeviceAllocation = {
  request: string;
  driver: string;
  pool: string;
  device: string;
  shared: boolean;
};
export function allocationDevices(claim: DeviceObject): DeviceAllocation[] {
  return objects(
    object(object(object(claim.status).allocation).devices).results,
  )
    .map((result) => ({
      request: string(result.request),
      driver: string(result.driver),
      pool: string(result.pool),
      device: string(result.device),
      shared: result.adminAccess === true || result.shareID != null,
    }))
    .filter((result) => result.driver && result.pool && result.device);
}
export type PodClaimLink = {
  alias: string;
  claimName: string;
  templateName: string;
  templateState: "present" | "missing" | "unavailable" | "none";
  state: "resolved" | "awaiting-claim" | "missing" | "unavailable";
  allocations: DeviceAllocation[];
};
export function podClaimLinks(
  pod: DeviceObject,
  snapshot: DeviceSnapshot,
): PodClaimLink[] {
  const statuses = objects(object(pod.status).resourceClaimStatuses);
  return objects(object(pod.spec).resourceClaims).map((ref) => {
    const alias = string(ref.name);
    const claimName =
      string(ref.resourceClaimName) ||
      string(
        statuses.find((status) => status.name === alias)?.resourceClaimName,
      );
    const claim =
      snapshot.claims.state === "available"
        ? snapshot.claims.items.find(
            (item) =>
              resourceName(item) === claimName &&
              resourceNamespace(item) === resourceNamespace(pod),
          )
        : undefined;
    const templateName = string(ref.resourceClaimTemplateName);
    const templateState = !templateName
      ? "none"
      : snapshot.templates.state !== "available"
        ? "unavailable"
        : snapshot.templates.items.some(
              (item) =>
                resourceName(item) === templateName &&
                resourceNamespace(item) === resourceNamespace(pod),
            )
          ? "present"
          : "missing";
    return {
      alias,
      claimName,
      templateName,
      templateState,
      state: !claimName
        ? "awaiting-claim"
        : snapshot.claims.state !== "available"
          ? "unavailable"
          : claim
            ? "resolved"
            : "missing",
      allocations: claim ? allocationDevices(claim) : [],
    };
  });
}
export type DeviceHealth = {
  container: string;
  health: "Healthy" | "Unhealthy" | "Unknown";
  message: string;
};
export function deviceHealth(
  pod: DeviceObject,
  alias: string,
  allocation: DeviceAllocation,
): DeviceHealth[] {
  const statuses = object(pod.status);
  const id = `${allocation.driver}/${allocation.pool}/${allocation.device}`;
  // A prioritized subrequest is reported under its parent container request.
  const request = allocation.request.split("/")[0];
  const reports: DeviceHealth[] = [
    "containerStatuses",
    "initContainerStatuses",
    "ephemeralContainerStatuses",
  ].flatMap((key) =>
    objects(statuses[key]).flatMap((container) =>
      objects(container.allocatedResourcesStatus)
        .filter(
          (status) =>
            status.name === `claim:${alias}` ||
            status.name === `claim:${alias}/${request}` ||
            status.name === `claim:${alias}/${allocation.request}`,
        )
        .flatMap((status) =>
          objects(status.resources)
            .filter((resource) => resource.resourceID === id)
            .map((resource) => ({
              container: string(container.name),
              health:
                resource.health === "Healthy" || resource.health === "Unhealthy"
                  ? resource.health
                  : "Unknown",
              message: string(resource.message),
            })),
        ),
    ),
  );
  const spec = object(pod.spec);
  const consumers = ["containers", "initContainers", "ephemeralContainers"]
    .flatMap((key) => objects(spec[key]))
    .filter((container) =>
      objects(object(container.resources).claims).some(
        (claim) =>
          claim.name === alias &&
          (!claim.request ||
            claim.request === request ||
            claim.request === allocation.request),
      ),
    );
  for (const consumer of consumers) {
    const container = string(consumer.name);
    if (!reports.some((report) => report.container === container))
      reports.push({
        container,
        health: "Unknown",
        message: "No matching health report",
      });
  }
  return reports;
}

type NodeAccess = "accessible" | "inaccessible" | "unknown";
function selectorAccess(
  selector: DeviceObject,
  nodeName: string,
  labels?: Record<string, string>,
): NodeAccess {
  const terms = objects(selector.nodeSelectorTerms);
  if (!terms.length) return "inaccessible";
  const results = terms.map((term): NodeAccess => {
    const expressions = objects(term.matchExpressions).map((rule) => ({
      rule,
      values: labels,
    }));
    const fields = objects(term.matchFields).map((rule) => ({
      rule,
      values: { "metadata.name": nodeName } as Record<string, string>,
    }));
    if (!expressions.length && !fields.length) return "inaccessible";
    const requirements = [...expressions, ...fields].map(
      ({ rule, values }): NodeAccess => {
        if (!values) return "unknown";
        const key = string(rule.key);
        if (
          fields.some((item) => item.rule === rule) &&
          key !== "metadata.name"
        )
          return "unknown";
        const has = Object.prototype.hasOwnProperty.call(values, key);
        const actual = values[key];
        const expected = Array.isArray(rule.values)
          ? rule.values.map(string)
          : [];
        let match: boolean;
        switch (rule.operator) {
          case "In":
            match = has && expected.includes(actual);
            break;
          case "NotIn":
            match = !has || !expected.includes(actual);
            break;
          case "Exists":
            match = has;
            break;
          case "DoesNotExist":
            match = !has;
            break;
          case "Gt":
          case "Lt": {
            if (expected.length !== 1 || !/^-?\d+$/.test(expected[0]))
              return "unknown";
            match =
              has &&
              /^-?\d+$/.test(actual) &&
              (rule.operator === "Gt"
                ? Number(actual) > Number(expected[0])
                : Number(actual) < Number(expected[0]));
            break;
          }
          default:
            return "unknown";
        }
        return match ? "accessible" : "inaccessible";
      },
    );
    return requirements.includes("inaccessible")
      ? "inaccessible"
      : requirements.includes("unknown")
        ? "unknown"
        : "accessible";
  });
  return results.includes("accessible")
    ? "accessible"
    : results.includes("unknown")
      ? "unknown"
      : "inaccessible";
}
function accessFor(
  selection: DeviceObject,
  nodeName?: string,
  labels?: Record<string, string>,
): NodeAccess {
  if (!nodeName) return "unknown";
  if (selection.nodeName)
    return selection.nodeName === nodeName ? "accessible" : "inaccessible";
  if (selection.allNodes === true) return "accessible";
  if (selection.nodeSelector)
    return selectorAccess(object(selection.nodeSelector), nodeName, labels);
  return "unknown";
}
export type InventoryDevice = {
  driver: string;
  pool: string;
  device: string;
  slice: string;
  generation: number | null;
  complete: boolean;
  observedSlices: number;
  expectedSlices: number | null;
  access: NodeAccess;
  placement: string;
  shared: boolean;
};
export function buildDeviceInventory(
  snapshot: DeviceSnapshot,
  nodeName?: string,
  labels?: Record<string, string>,
): InventoryDevice[] {
  if (snapshot.slices.state !== "available") return [];
  const pools = new Map<string, DeviceObject[]>();
  for (const slice of snapshot.slices.items) {
    const spec = object(slice.spec);
    const pool = object(spec.pool);
    const key = JSON.stringify([spec.driver, pool.name]);
    const poolSlices = pools.get(key);
    if (poolSlices) poolSlices.push(slice);
    else pools.set(key, [slice]);
  }
  return [...pools.values()].flatMap((slices) => {
    const generations = slices
      .map((slice) => object(object(slice.spec).pool).generation)
      .filter((value): value is number => typeof value === "number");
    const generation = generations.length ? Math.max(...generations) : null;
    const latest = slices.filter(
      (slice) =>
        (object(object(slice.spec).pool).generation ?? null) === generation,
    );
    const expected = object(object(latest[0]?.spec).pool).resourceSliceCount;
    const expectedSlices =
      typeof expected === "number" && expected > 0 ? expected : null;
    const complete =
      generation !== null &&
      expectedSlices !== null &&
      latest.length === expectedSlices &&
      latest.every(
        (slice) =>
          object(object(slice.spec).pool).resourceSliceCount === expectedSlices,
      );
    return latest.flatMap((slice) => {
      const spec = object(slice.spec);
      const pool = object(spec.pool);
      return objects(spec.devices).map((device) => {
        const selection = spec.perDeviceNodeSelection === true ? device : spec;
        return {
          driver: string(spec.driver),
          pool: string(pool.name),
          device: string(device.name),
          slice: resourceName(slice),
          generation,
          complete,
          observedSlices: latest.length,
          expectedSlices,
          access: accessFor(selection, nodeName, labels),
          placement:
            string(selection.nodeName) ||
            (selection.allNodes === true
              ? "all nodes"
              : selection.nodeSelector
                ? "node selector"
                : "unknown"),
          shared:
            device.allowMultipleAllocations === true ||
            object(device.basic).allowMultipleAllocations === true,
        };
      });
    });
  });
}

/** Driver configuration and custom status can hold arbitrary secrets. Never reveal them in inspection. */
export function redactDeviceResource(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeviceResource);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "managedFields")
      .map(([key, child]) => [
        key,
        ["annotations", "parameters", "data", "config"].includes(key)
          ? "[redacted]"
          : redactDeviceResource(child),
      ]),
  );
}

export type AllocationInventory = {
  state: "matched" | "missing" | "unavailable";
  devices: InventoryDevice[];
};
export function buildAllocationInventoryIndex(
  snapshot: DeviceSnapshot,
): Map<string, InventoryDevice[]> {
  const index = new Map<string, InventoryDevice[]>();
  for (const device of buildDeviceInventory(snapshot)) {
    const key = JSON.stringify([device.driver, device.pool, device.device]);
    const matches = index.get(key);
    if (matches) matches.push(device);
    else index.set(key, [device]);
  }
  return index;
}
export function allocationInventory(
  snapshot: DeviceSnapshot,
  allocation: DeviceAllocation,
  index = buildAllocationInventoryIndex(snapshot),
): AllocationInventory {
  if (snapshot.slices.state !== "available")
    return { state: "unavailable", devices: [] };
  const devices =
    index.get(
      JSON.stringify([allocation.driver, allocation.pool, allocation.device]),
    ) ?? [];
  return { state: devices.length ? "matched" : "missing", devices };
}
