import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { k8s, type EventSummary, type ResourceDetail, type WorkloadKind } from "@/lib/k8s";
import type { TriageIssue } from "@/lib/triage";
import { redactIncidentReportText } from "@/lib/incidentReport";
import { Button } from "@/components/ui/button";
import { SectionPanel } from "@/components/lumen/page";
import { IncidentReportDialog } from "@/components/IncidentReportDialog";

type Props = { context: string; issue: TriageIssue; startedAt: string; onClose: () => void };
const OWNER_KINDS = new Set(["deployment", "replicaset", "statefulset", "daemonset", "job", "cronjob", "replicationcontroller"]);
function ownerOf(resource?: ResourceDetail) {
  const ref = resource?.owner_refs.find((owner) => OWNER_KINDS.has(owner.kind.toLowerCase()));
  return ref ? { kind: ref.kind.toLowerCase() as WorkloadKind, name: ref.name } : null;
}
function matchingEvents(events: EventSummary[] | undefined, kind: string, name: string) {
  return (events ?? []).filter((event) => event.involved_kind.toLowerCase() === kind.toLowerCase() && event.involved_name === name);
}
function source(label: string, query: Pick<UseQueryResult, "isPending" | "isError" | "dataUpdatedAt">, enabled = true) {
  if (!enabled) return `${label}: unavailable for this resource`;
  if (query.isError) return `${label}: unavailable (access denied or request failed)${query.dataUpdatedAt ? `; stale evidence retained from ${new Date(query.dataUpdatedAt).toISOString()}` : ""}`;
  if (query.isPending) return `${label}: loading`;
  return `${label}: captured ${new Date(query.dataUpdatedAt).toISOString()}`;
}

// Key the session so notes, container choices and pending results never cross targets.
export function TriageInvestigation(props: Props) {
  return <InvestigationSession key={JSON.stringify([props.context, props.issue.resource, props.startedAt])} {...props} />;
}
function InvestigationSession({ context, issue, startedAt, onClose }: Props) {
  const { kind, name } = issue.resource;
  const namespace = issue.resource.namespace ?? "";
  const [reportOpen, setReportOpen] = useState(false);
  const [chosenContainer, setChosenContainer] = useState<string | null>(null);
  const identity = [context, namespace, kind, name, startedAt];
  const resource = useQuery({ queryKey: ["investigation-resource", ...identity], queryFn: () => k8s.getResource(namespace, kind, name, context), retry: false });
  const pod = useQuery({ queryKey: ["investigation-pod", ...identity], queryFn: () => k8s.getPodDetails(context, namespace, name), enabled: kind === "pod" && !!namespace, retry: false });
  const events = useQuery({ queryKey: ["investigation-events", ...identity], queryFn: () => k8s.listEventsFor(namespace, kind, name, context), retry: false });
  const owner = ownerOf(resource.data);
  const ownerQuery = useQuery({ queryKey: ["investigation-owner", ...identity, owner], queryFn: () => k8s.getResource(namespace, owner!.kind, owner!.name, context), enabled: !!owner, retry: false });
  const controller = ownerOf(ownerQuery.data);
  const controllerQuery = useQuery({ queryKey: ["investigation-controller", ...identity, controller], queryFn: () => k8s.getResource(namespace, controller!.kind, controller!.name, context), enabled: !!controller, retry: false });
  const rolloutTarget = controller ?? owner ?? (OWNER_KINDS.has(kind) ? { kind, name } : null);
  const ownerEvents = useQuery({ queryKey: ["investigation-owner-events", ...identity, rolloutTarget], queryFn: () => k8s.listEventsFor(namespace, rolloutTarget!.kind, rolloutTarget!.name, context), enabled: !!rolloutTarget, retry: false });
  const containers = pod.data?.containers ?? [];
  const suggested = [...containers].sort((a, b) => Number(a.ready) - Number(b.ready) || b.restart_count - a.restart_count)[0];
  const container = containers.find((entry) => entry.name === chosenContainer) ?? suggested;
  const relatedEvents = matchingEvents(events.data, kind, name);
  const rolloutEvents = rolloutTarget ? matchingEvents(ownerEvents.data, rolloutTarget.kind, rolloutTarget.name) : [];
  const owners = [OWNER_KINDS.has(kind) ? resource.data : undefined, ownerQuery.data, controllerQuery.data].filter((entry): entry is ResourceDetail => !!entry);
  const observations = owners.map((entry) => `${entry.summary.kind}/${entry.summary.name} · ${entry.summary.ready} ready · ${entry.summary.health} (current snapshot)`);
  if (!owners.length) observations.push("Owner rollout evidence unavailable; no controller snapshot captured.");
  observations.push("Historical rollout revisions unavailable in this capture; current snapshots do not establish a rollout cause.");
  observations.push("Events are matched by namespace, kind and name. UID correlation unavailable from the current API; a recreated resource may have older events.");
  observations.push("Log contents are not captured in this report; open current or retained previous logs separately.");
  if (kind === "pod" && pod.isSuccess && !container) observations.push("Container log selection unavailable: no containers returned.");
  if (container) observations.push(`Selected container: ${container.name}; ${container.state}; ${container.restart_count} restarts.`);
  for (const event of rolloutEvents) observations.push(`Owner event ${event.involved_kind}/${event.involved_name}: ${event.ts ?? "unknown time"} · ${event.reason} · ${redactIncidentReportText(event.message)}`);
  const sources = [source("Resource", resource), source("Related events", events), source("Pod containers", pod, kind === "pod" && !!namespace), source("Owner snapshot", ownerQuery, !!owner), source("Controller snapshot", controllerQuery, !!controller), source("Owner events", ownerEvents, !!rolloutTarget)];
  const loading = resource.isPending || events.isPending || (kind === "pod" && !!namespace && pod.isPending) || (!!owner && ownerQuery.isPending) || (!!controller && controllerQuery.isPending) || (!!rolloutTarget && ownerEvents.isPending);
  function logs(previous: boolean) {
    const params = new URLSearchParams({ ns: namespace, kind: "pod", name, c: container!.name, startedAt });
    if (previous) params.set("previous", "true");
    return `/cluster/${encodeURIComponent(context)}/logs?${params}`;
  }
  return <SectionPanel>
    <section aria-label="Selected investigation" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-base font-semibold text-text-primary">Investigate {kind}/{name}</h2><p className="text-xs text-text-secondary">{context} · {namespace || "cluster scoped"} · {kind}/{name} · started {startedAt}</p></div>
        <div className="flex gap-2"><Button variant="outline" onClick={() => setReportOpen(true)} disabled={loading}>export investigation</Button><Button variant="outline" onClick={onClose}>close investigation</Button></div>
      </div>
      <ul className="text-xs text-text-secondary space-y-1">{sources.map((line) => <li key={line}>{line}</li>)}</ul>
      {kind === "pod" && container && <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-text-secondary">Container <select aria-label="Investigation container" value={container.name} onChange={(event) => setChosenContainer(event.target.value)} className="rounded-control border border-border-default bg-elevated p-1">{containers.map((entry) => <option key={entry.name} value={entry.name}>{entry.name} · {entry.state} · {entry.restart_count} restarts</option>)}</select></label>
        <Button asChild variant="outline"><Link to={logs(false)}>current logs · {container.name}</Link></Button>
        {container.restart_count > 0 && <Button asChild variant="outline"><Link to={logs(true)}>previous logs · {container.name}</Link></Button>}
      </div>}
      <div><h3 className="text-sm font-medium text-text-primary">Related events</h3><p className="text-xs text-text-secondary">Fetched for {namespace || "cluster"}/{kind}/{name}; event timestamps are shown below.</p>
        {events.isSuccess && relatedEvents.length === 0 && <p className="text-xs text-text-secondary">No related events returned.</p>}
        <ul className="space-y-1 text-xs text-text-secondary">{relatedEvents.map((event, index) => <li key={index}>{event.ts ?? "unknown time"} · {event.type_} · {event.reason}: {redactIncidentReportText(event.message)}</li>)}</ul>
      </div>
      <div><h3 className="text-sm font-medium text-text-primary">Owner and rollout evidence</h3><ul className="space-y-1 text-xs text-text-secondary">{observations.map((line, index) => <li key={index}>{redactIncidentReportText(line)}</li>)}</ul></div>
    </section>
    <IncidentReportDialog open={reportOpen} onClose={() => setReportOpen(false)} loading={loading} input={{ clusterContext: context, namespace, selectedResource: issue.resource, triageIssues: [issue], warningEvents: relatedEvents.map((event) => ({ ...event, kind: "Event", involved: `${event.involved_kind}/${event.involved_name}` })), rolloutEntries: [], investigation: { startedAt, sources, observations: [...observations, ...relatedEvents.map((event) => `Related event ${event.ts ?? "unknown time"} · ${event.type_} · ${event.reason}: ${redactIncidentReportText(event.message)}`)] } }} />
  </SectionPanel>;
}
