import { describe, expect, it } from "vitest";
import {
  buildChangeHistoryEvent,
  changeHistoryResourceHref,
  filterChangeHistoryEvents,
  redactChangeHistoryDetails,
  type ChangeHistoryEvent,
} from "./changeHistory";

const baseEvent: ChangeHistoryEvent = {
  id: "ch-1",
  action: "restart",
  target: {
    kind: "deployment",
    namespace: "payments",
    name: "api",
    context: "prod/us-east",
  },
  timestamp: 1_700_000_000_000,
  status: "success",
  summary: "restarted deployment/api",
};

describe("changeHistory helpers", () => {
  it("constructs normalized audit events with target metadata and bounded summaries", () => {
    const event = buildChangeHistoryEvent(
      {
        action: "scale",
        target: {
          kind: "Deployment",
          namespace: " payments ",
          name: " api ",
          context: " prod/us-east ",
        },
        status: "success",
        summary: " scaled deployment/api to 4 replicas ".repeat(20),
        details: { replicas: 4 },
      },
      1_700_000_000_000,
      () => "ch-fixed",
    );

    expect(event).toMatchObject({
      id: "ch-fixed",
      action: "scale",
      target: {
        kind: "deployment",
        namespace: "payments",
        name: "api",
        context: "prod/us-east",
      },
      timestamp: 1_700_000_000_000,
      status: "success",
      details: { replicas: 4 },
    });
    expect(event.summary).toContain("scaled deployment/api");
    expect(event.summary.length).toBeLessThanOrEqual(180);
  });

  it("filters by context, namespace, action, status, and free-text search", () => {
    const events: ChangeHistoryEvent[] = [
      baseEvent,
      {
        ...baseEvent,
        id: "ch-2",
        action: "apply",
        status: "failure",
        error: "RBAC denied update",
        target: {
          kind: "configmap",
          namespace: "catalog",
          name: "settings",
          context: "dev",
        },
        summary: "failed to apply configmap/settings",
      },
    ];

    expect(
      filterChangeHistoryEvents(events, {
        context: "prod/us-east",
        namespace: "payments",
        action: "restart",
        status: "success",
        search: "api",
      }).map((event) => event.id),
    ).toEqual(["ch-1"]);

    expect(
      filterChangeHistoryEvents(events, { search: "rbac" }).map(
        (event) => event.id,
      ),
    ).toEqual(["ch-2"]);
  });

  it("redacts secret manifests and sensitive fields before persistence", () => {
    const redacted = redactChangeHistoryDetails(
      {
        manifest: `apiVersion: v1
kind: Secret
metadata:
  name: db-creds
data:
  password: c2VjcmV0
`,
        password: "plain-secret",
        token: "abc123",
        note: "kept",
      },
      { kind: "secret", namespace: "default", name: "db-creds", context: "dev" },
    );

    expect(JSON.stringify(redacted)).not.toContain("c2VjcmV0");
    expect(JSON.stringify(redacted)).not.toContain("plain-secret");
    expect(JSON.stringify(redacted)).not.toContain("abc123");
    expect(redacted).toMatchObject({
      manifest: "[redacted secret manifest]",
      password: "[redacted]",
      token: "[redacted]",
      note: "kept",
    });
  });

  it("builds a best-effort resource link for namespaced Kubernetes targets", () => {
    expect(changeHistoryResourceHref(baseEvent)).toBe(
      "/cluster/prod%2Fus-east/workloads/deployments?ns=payments&q=api",
    );
  });
});
