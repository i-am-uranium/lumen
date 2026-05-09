import { describe, expect, it } from "vitest";
import {
  buildRolloutTimeline,
  filterRolloutTimeline,
  type RolloutTimelineInput,
} from "./rolloutTimeline";
import type { WorkloadSummary } from "./k8s";

function workload(overrides: Partial<WorkloadSummary>): WorkloadSummary {
  return {
    kind: "deployment",
    name: "api",
    namespace: "default",
    ready: "1/1",
    age_seconds: 3_600,
    health: "healthy",
    labels: {},
    ...overrides,
  };
}

describe("buildRolloutTimeline", () => {
  it("correlates rollout signals from workloads, warning events, Helm, and Argo history", () => {
    const input: RolloutTimelineInput = {
      nowMs: Date.parse("2026-05-09T12:00:00.000Z"),
      namespace: "",
      workloads: [
        workload({
          kind: "deployment",
          name: "api",
          namespace: "default",
          ready: "2/3",
          health: "degraded",
          age_seconds: 300,
        }),
        workload({
          kind: "pod",
          name: "api-7f9d",
          namespace: "default",
          pod_phase: "Running",
          restart_count: 4,
          controlled_by: { kind: "ReplicaSet", name: "api-7f9d" },
          age_seconds: 120,
        }),
      ],
      events: [
        {
          id: 1,
          receivedAt: Date.parse("2026-05-09T11:58:00.000Z"),
          ts: "2026-05-09T11:57:00.000Z",
          type_: "Warning",
          kind: "Pod",
          involved: "Pod/api-7f9d",
          reason: "BackOff",
          message: "Back-off restarting failed container api",
        },
      ],
      helmReleases: [
        {
          name: "api",
          namespace: "default",
          revision: 12,
          status: "deployed",
          chart_name: "api",
          chart_version: "1.2.3",
          app_version: "1.1.0",
          last_deployed: "2026-05-09T11:50:00.000Z",
          description: "Upgrade complete",
        },
      ],
      argoApplications: [
        {
          name: "api",
          namespace: "argocd",
          project: "default",
          sync_status: "Synced",
          health_status: "Degraded",
          repo_url: "https://github.com/acme/platform",
          path: "apps/api",
          target_revision: "main",
          destination_namespace: "default",
          destination_server: "https://kubernetes.default.svc",
          age_seconds: 86_400,
          resource_count: 8,
        },
      ],
      argoHistories: [
        {
          appName: "api",
          appNamespace: "argocd",
          destinationNamespace: "default",
          history: [
            {
              revision: "abc123",
              deployed_at: "2026-05-09T11:45:00.000Z",
              source_path: "apps/api",
            },
          ],
        },
      ],
    };

    const entries = buildRolloutTimeline(input);

    expect(entries.map((entry) => entry.type)).toEqual([
      "pod_churn",
      "warning_event",
      "workload_rollout",
      "helm_revision",
      "argo_sync",
      "argo_health",
    ]);
    expect(entries[0]).toMatchObject({
      severity: "warning",
      namespace: "default",
      resourceKind: "pod",
      resourceName: "api-7f9d",
      correlationKey: "default/api",
    });
  });

  it("filters by namespace, kind, and search text", () => {
    const entries = buildRolloutTimeline({
      nowMs: Date.parse("2026-05-09T12:00:00.000Z"),
      namespace: "payments",
      workloads: [
        workload({ kind: "deployment", namespace: "default", name: "api" }),
        workload({ kind: "pod", namespace: "payments", name: "worker", restart_count: 1 }),
      ],
      events: [],
      helmReleases: [],
      argoApplications: [],
      argoHistories: [],
    });

    expect(entries).toHaveLength(1);
    expect(
      filterRolloutTimeline(entries, {
        resourceKind: "pod",
        search: "worker",
      }).map((entry) => entry.resourceName),
    ).toEqual(["worker"]);
    expect(
      filterRolloutTimeline(entries, {
        resourceKind: "deployment",
        search: "",
      }),
    ).toEqual([]);
  });
});
