import { describe, expect, it, vi } from "vitest";
import {
  allocationDevices,
  allocationInventory,
  buildDeviceInventory,
  deviceHealth,
  podClaimLinks,
  redactDeviceResource,
  fetchDeviceResources,
  type DeviceSnapshot,
  type DeviceObject,
} from "./deviceResources";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const available = (items: DeviceObject[] = []) => ({
  state: "available" as const,
  items,
  message: null,
});
function snapshot(): DeviceSnapshot {
  return {
    namespace: "team",
    captured_at: "2026-09-10T00:00:00Z",
    claims: available(),
    templates: available(),
    classes: available(),
    slices: available(),
    pods: available(),
  };
}
const claim: DeviceObject = {
  metadata: { name: "generated", namespace: "team" },
  status: {
    allocation: {
      devices: {
        results: [
          {
            request: "gpu",
            driver: "vendor.io",
            pool: "pool/x",
            device: "one",
          },
        ],
      },
    },
  },
};
const pod: DeviceObject = {
  metadata: { name: "job", namespace: "team" },
  spec: {
    resourceClaims: [{ name: "alias", resourceClaimTemplateName: "template" }],
  },
  status: {
    resourceClaimStatuses: [{ name: "alias", resourceClaimName: "generated" }],
  },
};
const slice = (name: string, generation: number, count = 1): DeviceObject => ({
  metadata: { name },
  spec: {
    driver: "vendor.io",
    pool: { name: "pool/x", generation, resourceSliceCount: count },
    nodeName: "node-a",
    devices: [{ name: "one" }],
  },
});
describe("device resources", () => {
  it("requires explicit context before invoking", async () => {
    await expect(fetchDeviceResources("", "team")).rejects.toThrow("context");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("joins template-generated claims using pod status and namespace", () => {
    const s = snapshot();
    s.claims.items = [
      { ...claim, metadata: { name: "generated", namespace: "other" } },
      claim,
    ];
    expect(podClaimLinks(pod, s)[0]).toMatchObject({
      claimName: "generated",
      state: "resolved",
      templateName: "template",
      allocations: [{ pool: "pool/x", device: "one" }],
    });
  });
  it("distinguishes uncreated, missing, and unreadable claims", () => {
    const s = snapshot();
    expect(podClaimLinks({ ...pod, status: {} }, s)[0].state).toBe(
      "awaiting-claim",
    );
    expect(podClaimLinks(pod, s)[0].state).toBe("missing");
    s.claims.state = "forbidden";
    expect(podClaimLinks(pod, s)[0].state).toBe("unavailable");
  });
  it("extracts allocations without mistaking pending claims for free devices", () => {
    expect(allocationDevices({})).toEqual([]);
    expect(allocationDevices(claim)[0]).toMatchObject({
      request: "gpu",
      driver: "vendor.io",
      pool: "pool/x",
    });
  });
  it("keeps health unknown when no matching report exists and matches full tuple", () => {
    const a = allocationDevices(claim)[0];
    expect(deviceHealth(pod, "alias", a)).toEqual([]);
    const p = {
      ...pod,
      status: {
        containerStatuses: [
          {
            name: "main",
            allocatedResourcesStatus: [
              {
                name: "claim:alias/gpu",
                resources: [
                  { resourceID: "vendor.io/pool/x/one", health: "Unhealthy" },
                  { resourceID: "vendor.io/other/one", health: "Healthy" },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(deviceHealth(p, "alias", a)).toEqual([
      { container: "main", health: "Unhealthy", message: "" },
    ]);
  });
  it("includes init-container health but rejects unrelated request names", () => {
    const p = {
      status: {
        initContainerStatuses: [
          {
            name: "init",
            allocatedResourcesStatus: [
              {
                name: "claim:alias/other",
                resources: [
                  { resourceID: "vendor.io/pool/x/one", health: "Healthy" },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(deviceHealth(p, "alias", allocationDevices(claim)[0])).toEqual([]);
  });
  it("uses latest pool generation and marks incomplete publication", () => {
    const s = snapshot();
    s.slices.items = [slice("old", 1), slice("new", 2, 2)];
    const rows = buildDeviceInventory(s, "node-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      generation: 2,
      complete: false,
      access: "accessible",
    });
  });
  it("does not guess node label selectors, supports per-device selection", () => {
    const s = snapshot();
    s.slices.items = [
      {
        metadata: { name: "shared" },
        spec: {
          driver: "v",
          pool: { name: "p", generation: 0, resourceSliceCount: 1 },
          nodeSelector: {
            nodeSelectorTerms: [
              {
                matchExpressions: [
                  { key: "gpu", operator: "In", values: ["yes"] },
                ],
              },
            ],
          },
          devices: [{ name: "one" }],
        },
      },
    ];
    expect(buildDeviceInventory(s, "node-a")[0].access).toBe("unknown");
    expect(buildDeviceInventory(s, "node-a", { gpu: "yes" })[0].access).toBe(
      "accessible",
    );
    expect(buildDeviceInventory(s, "node-a", { gpu: "no" })[0].access).toBe(
      "inaccessible",
    );
    s.slices.items = [
      {
        metadata: { name: "per-device" },
        spec: {
          driver: "v",
          pool: { name: "p", generation: 0, resourceSliceCount: 1 },
          perDeviceNodeSelection: true,
          devices: [{ name: "one", nodeName: "node-b" }],
        },
      },
    ];
    expect(buildDeviceInventory(s, "node-a")[0].access).toBe("inaccessible");
  });
  it("matches whole-claim reports and preserves unknown health for another consuming container", () => {
    const p = {
      spec: {
        containers: [
          { name: "main", resources: { claims: [{ name: "alias" }] } },
          {
            name: "helper",
            resources: { claims: [{ name: "alias", request: "gpu" }] },
          },
          {
            name: "other",
            resources: { claims: [{ name: "alias", request: "storage" }] },
          },
        ],
      },
      status: {
        containerStatuses: [
          {
            name: "main",
            allocatedResourcesStatus: [
              {
                name: "claim:alias",
                resources: [
                  { resourceID: "vendor.io/pool/x/one", health: "Healthy" },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(deviceHealth(p, "alias", allocationDevices(claim)[0])).toEqual([
      { container: "main", health: "Healthy", message: "" },
      {
        container: "helper",
        health: "Unknown",
        message: "No matching health report",
      },
    ]);
  });
  it("joins allocations to current slice tuples and distinguishes missing inventory from unavailable sources", () => {
    const s = snapshot();
    const allocation = allocationDevices(claim)[0];
    s.slices.items = [
      slice("current", 2, 2),
      {
        ...slice("other", 3),
        spec: { ...(slice("other", 3).spec as object), driver: "different.io" },
      },
    ];
    expect(allocationInventory(s, allocation)).toMatchObject({
      state: "matched",
      devices: [{ slice: "current", placement: "node-a", complete: false }],
    });
    expect(allocationInventory(s, { ...allocation, pool: "other" }).state).toBe(
      "missing",
    );
    s.slices.state = "forbidden";
    expect(allocationInventory(s, allocation).state).toBe("unavailable");
  });
  it("redacts driver parameters, annotations, configuration and arbitrary status data recursively", () => {
    const raw = {
      metadata: { annotations: { secret: "do-not-show" } },
      spec: {
        devices: {
          config: [{ opaque: { parameters: { token: "do-not-show" } } }],
        },
      },
      status: { devices: [{ data: { password: "do-not-show" } }] },
    };
    const safe = JSON.stringify(redactDeviceResource(raw));
    expect(safe).not.toContain("do-not-show");
    expect(safe).toContain("redacted");
    expect(JSON.stringify(raw)).toContain("do-not-show");
  });
});
