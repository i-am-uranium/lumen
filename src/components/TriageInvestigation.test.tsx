import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { k8s, type PodDetails, type ResourceDetail } from "@/lib/k8s";
import type { TriageIssue } from "@/lib/triage";
import { buildIncidentReportData, renderIncidentReportMarkdown, type IncidentReportInput } from "@/lib/incidentReport";
import { TriageInvestigation } from "./TriageInvestigation";
vi.mock("@/lib/k8s", () => ({ k8s: { getResource: vi.fn(), getPodDetails: vi.fn(), listEventsFor: vi.fn() } }));
vi.mock("@/components/IncidentReportDialog", () => ({ IncidentReportDialog: ({ open, input }: { open: boolean; input: IncidentReportInput }) => open ? <pre data-testid="report">{renderIncidentReportMarkdown(buildIncidentReportData(input))}</pre> : null }));
const issue: TriageIssue = { id: "crash", group: "crashloop-restarts", severity: "high", title: "Pod restarting repeatedly", resource: { kind: "pod", namespace: "payments", name: "api" }, evidence: ["5 restarts"], nextActions: ["Check previous logs"] };
const detail = (kind: string, name: string, owners: { kind: string; name: string }[] = []): ResourceDetail => ({ summary: { kind, name, namespace: "payments", ready: "0/1", health: "degraded", labels: {}, age_seconds: 60 }, yaml: `metadata:\n  name: ${name}\n  uid: uid-${kind}-${name}`, owner_refs: owners } as ResourceDetail);
function renderInvestigation() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>;
  return render(<TriageInvestigation context="prod" issue={issue} startedAt="2026-09-06T00:00:00Z" onClose={() => {}} />, { wrapper: Wrapper });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(k8s.getResource).mockImplementation(async (_ns, kind, name) => detail(kind, name, kind === "pod" ? [{ kind: "ReplicaSet", name: "api-rs" }] : kind === "replicaset" ? [{ kind: "Deployment", name: "api" }] : []));
  vi.mocked(k8s.getPodDetails).mockResolvedValue({ name: "api", namespace: "payments", containers: [{ name: "sidecar", ready: true, restart_count: 0, state: "running" }, { name: "worker", ready: false, restart_count: 5, state: "CrashLoopBackOff" }] } as PodDetails);
  vi.mocked(k8s.listEventsFor).mockImplementation(async (_ns, kind, name) => [{ ts: "2026-09-05T23:59:00Z", type_: "Warning", reason: "BackOff", message: `${kind} warning`, involved_kind: kind, involved_name: name, involved_uid: `uid-${kind}-${name}`, count: 5 }, { ts: null, type_: "Warning", reason: "Unrelated", message: "other resource", involved_kind: "Service", involved_name: name, involved_uid: "other", count: 1 }, { ts: null, type_: "Normal", reason: "Pulled", message: "image already present", involved_kind: kind, involved_name: name, involved_uid: `uid-${kind}-${name}`, count: 1 }]);
});
it("connects failing container, exact events, observed owners and scoped export", async () => {
  renderInvestigation();
  const previous = await screen.findByRole("link", { name: /previous logs.*worker/i });
  expect(previous).toHaveAttribute("href", "/cluster/prod/logs?ns=payments&kind=pod&name=api&c=worker&startedAt=2026-09-06T00%3A00%3A00Z&previous=true");
  expect(await screen.findByText(/deployment\/api · 0\/1/)).toBeInTheDocument();
  expect(k8s.listEventsFor).toHaveBeenCalledWith("payments", "pod", "api", "prod");
  expect(k8s.getResource).toHaveBeenCalledWith("payments", "deployment", "api", "prod");
  expect(screen.queryByText("other resource")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /export investigation/i }));
  const report = screen.getByTestId("report");
  expect(report).toHaveTextContent("payments");
  expect(report).toHaveTextContent("2026-09-06T00:00:00Z");
  expect(report).toHaveTextContent("deployment/api · 0/1");
  expect(report).toHaveTextContent("Events without matching involved-object UID");
  expect(report).toHaveTextContent("no rollout notes available");
  expect(report).not.toHaveTextContent("other resource");
  expect(report).toHaveTextContent("image already present");
});
it("shows denied sources explicitly while allowing a partial scoped report", async () => {
  vi.mocked(k8s.getResource).mockRejectedValue(new Error("forbidden"));
  vi.mocked(k8s.listEventsFor).mockRejectedValue(new Error("forbidden"));
  renderInvestigation();
  expect(await screen.findByText(/Resource: unavailable/i)).toBeInTheDocument();
  expect(screen.getByText(/Related events: unavailable/i)).toBeInTheDocument();
  expect(screen.getByText(/Owner rollout evidence unavailable/i)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /export investigation/i }));
  expect(screen.getByTestId("report")).toHaveTextContent("unavailable");
});
it("does not expose old target results after context and selection change", async () => {
  let complete!: (value: ResourceDetail) => void;
  vi.mocked(k8s.getResource).mockImplementation((_ns, kind, name, ctx) => ctx === "prod" ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve(detail(kind, name)));
  const view = renderInvestigation();
  await waitFor(() => expect(complete).toBeDefined());
  view.rerender(<TriageInvestigation context="stage" issue={{ ...issue, resource: { ...issue.resource, name: "other" } }} startedAt="2026-09-06T01:00:00Z" onClose={() => {}} />);
  complete(detail("pod", "api", [{ kind: "Deployment", name: "stale-owner" }]));
  await screen.findByText(/stage · payments · pod\/other/i);
  expect(screen.queryByText(/stale-owner/)).not.toBeInTheDocument();
  expect(k8s.getResource).not.toHaveBeenCalledWith("payments", "deployment", "stale-owner", "stage");
});

it("redacts credential-like owner event messages before display and export", async () => {
  vi.mocked(k8s.listEventsFor).mockImplementation(async (_ns, kind, name) => [{ ts: null, type_: "Warning", reason: "Failed", message: "token: super-secret-owner-event", involved_kind: kind, involved_name: name, involved_uid: `uid-${kind}-${name}`, count: 1 }]);
  renderInvestigation();
  await screen.findByText(/deployment\/api · 0\/1/);
  await waitFor(() => expect(screen.getByRole("button", { name: /export investigation/i })).not.toBeDisabled());
  expect(screen.queryByText(/super-secret-owner-event/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: /export investigation/i }));
  expect(screen.getByTestId("report")).not.toHaveTextContent("super-secret-owner-event");
});
