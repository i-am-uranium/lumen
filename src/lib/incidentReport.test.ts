import { describe, expect, it } from "vitest";
import type { EventLine } from "@/lib/k8s";
import type { RolloutTimelineEntry } from "@/lib/rolloutTimeline";
import type { TriageIssue } from "@/lib/triage";
import {
  buildIncidentReportData,
  incidentReportFilename,
  redactIncidentReportText,
  renderIncidentReportMarkdown,
} from "./incidentReport";

const generatedAt = new Date("2026-05-09T15:04:05.000Z");

function issue(overrides: Partial<TriageIssue> = {}): TriageIssue {
  return {
    id: "issue-1",
    group: "crashloop-restarts",
    severity: "high",
    title: "Pod restarting repeatedly",
    resource: { kind: "pod", namespace: "checkout", name: "api-7b9" },
    evidence: ["6 container restarts", "ready 0/1"],
    nextActions: [
      "Open logs for the failing container",
      "Check recent warning events",
    ],
    ...overrides,
  };
}

function warning(overrides: Partial<EventLine> & { count?: number | null } = {}): EventLine & { count?: number | null } {
  return {
    ts: "2026-05-09T14:58:00Z",
    kind: "Pod",
    reason: "BackOff",
    message: "Back-off restarting failed container",
    involved: "Pod/api-7b9",
    type_: "Warning",
    ...overrides,
  };
}

function timeline(overrides: Partial<RolloutTimelineEntry> = {}): RolloutTimelineEntry {
  return {
    id: "deploy-api",
    type: "workload_rollout",
    severity: "warning",
    timestampMs: Date.parse("2026-05-09T14:50:00Z"),
    namespace: "checkout",
    resourceKind: "deployment",
    resourceName: "api",
    title: "deployment/api rollout signal",
    description: "1/3 ready · degraded",
    details: ["age 8m", "namespace checkout"],
    correlationKey: "checkout/api",
    searchText: "deployment api degraded",
    ...overrides,
  };
}

describe("buildIncidentReportData", () => {
  it("shapes current triage context into a stable report model", () => {
    const report = buildIncidentReportData({
      clusterContext: "prod-main",
      namespace: "checkout",
      generatedAt,
      selectedResource: { kind: "deployment", namespace: "checkout", name: "api" },
      triageIssues: [
        issue({ id: "medium", severity: "medium", title: "Warning event" }),
        issue({ id: "critical", severity: "critical", title: "Node not ready" }),
      ],
      warningEvents: [
        warning({ type_: "Normal", reason: "Pulled" }),
        warning({ reason: "Unhealthy", involved: "Pod/api-7b9", count: 3 }),
      ],
      rolloutEntries: [timeline()],
      manualNotes: "Customer reports 502s after deploy.",
    });

    expect(report.generatedAtIso).toBe("2026-05-09T15:04:05.000Z");
    expect(report.scope).toEqual({
      clusterContext: "prod-main",
      namespace: "checkout",
      selectedResource: "deployment/checkout/api",
    });
    expect(report.summary).toEqual({
      totalIssues: 2,
      critical: 1,
      high: 0,
      medium: 1,
      low: 0,
      warningEvents: 1,
      rolloutNotes: 1,
    });
    expect(report.triageIssues.map((item) => item.title)).toEqual([
      "Node not ready",
      "Warning event",
    ]);
    expect(report.warningEvents).toEqual([
      expect.objectContaining({
        reason: "Unhealthy",
        involved: "Pod/api-7b9",
        count: 3,
      }),
    ]);
    expect(report.nextChecks).toEqual([
      "Open logs for the failing container",
      "Check recent warning events",
      "Correlate warnings with rollout and activity timeline timestamps",
      "Capture current resource YAML and relevant logs before remediation",
    ]);
  });
});

describe("renderIncidentReportMarkdown", () => {
  it("renders a redacted Markdown incident report for sharing", () => {
    const report = buildIncidentReportData({
      clusterContext: "prod-main",
      namespace: "checkout",
      generatedAt,
      selectedResource: { kind: "deployment", namespace: "checkout", name: "api" },
      triageIssues: [issue({ severity: "high" })],
      warningEvents: [warning()],
      rolloutEntries: [timeline()],
      manualNotes: "kubectl uses Authorization: Bearer abc.def.ghi",
    });

    const markdown = renderIncidentReportMarkdown(report);

    expect(markdown).toContain("# Incident Report - prod-main");
    expect(markdown).toContain("- **Namespace:** checkout");
    expect(markdown).toContain("- **Selected resource:** deployment/checkout/api");
    expect(markdown).toContain("## Triage Summary");
    expect(markdown).toContain("### high - Pod restarting repeatedly");
    expect(markdown).toContain("## Warning Events");
    expect(markdown).toContain("BackOff");
    expect(markdown).toContain("## Rollout / Timeline Notes");
    expect(markdown).toContain("deployment/api rollout signal");
    expect(markdown).toContain("## Manual Notes");
    expect(markdown).toContain("Authorization: Bearer [REDACTED]");
    expect(markdown).not.toContain("abc.def.ghi");
  });
});

describe("redactIncidentReportText", () => {
  it("redacts Secret YAML, bearer tokens, kubeconfig credentials, and obvious API keys", () => {
    const raw = [
      "apiVersion: v1",
      "kind: Secret",
      "metadata:",
      "  name: checkout-token",
      "data:",
      "  password: cGFzcw==",
      "stringData:",
      "  apiKey: plain-secret",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret",
      "token: kubeconfig-token",
      "client-key-data: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t",
      "STRIPE_API_KEY=sk_live_1234567890",
    ].join("\n");

    const redacted = redactIncidentReportText(raw);

    expect(redacted).toContain("kind: Secret");
    expect(redacted).toContain("data: [REDACTED]");
    expect(redacted).toContain("stringData: [REDACTED]");
    expect(redacted).toContain("Authorization: Bearer [REDACTED]");
    expect(redacted).toContain("token: [REDACTED]");
    expect(redacted).toContain("client-key-data: [REDACTED]");
    expect(redacted).toContain("STRIPE_API_KEY=[REDACTED]");
    expect(redacted).not.toContain("plain-secret");
    expect(redacted).not.toContain("kubeconfig-token");
    expect(redacted).not.toContain("sk_live_1234567890");
  });
});

describe("incidentReportFilename", () => {
  it("generates a stable sanitized markdown filename", () => {
    expect(
      incidentReportFilename({
        clusterContext: "prod/main",
        namespace: "checkout.payments",
        generatedAt,
        selectedResource: { kind: "deployment", namespace: "checkout", name: "api:v2" },
      }),
    ).toBe("incident-prod-main-checkout-payments-deployment-api-v2-20260509-150405.md");
  });
});
