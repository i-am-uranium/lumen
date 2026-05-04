import { invoke } from "@tauri-apps/api/core";

export type ContextInfo = {
  name: string;
  cluster: string;
  user: string;
  namespace: string | null;
  is_current: boolean;
  is_prod: boolean;
};

export type DeletedContextSummary = {
  name: string;
  cluster: string;
  user: string;
  namespace: string | null;
  is_prod: boolean;
  deleted_at_ms: number;
  expires_at_ms: number;
  days_remaining: number;
  has_conflict: boolean;
};

export type WorkloadKind =
  | "deployment"
  | "statefulset"
  | "daemonset"
  | "replicaset"
  | "replicationcontroller"
  | "cronjob"
  | "job"
  | "pod"
  | "service"
  | "ingress"
  | "endpoint"
  | "endpointslice"
  | "configmap"
  | "secret"
  | "serviceaccount"
  | "role"
  | "rolebinding"
  | "clusterrole"
  | "clusterrolebinding"
  | "networkpolicy"
  | "persistentvolumeclaim"
  | "persistentvolume"
  | "storageclass"
  | "volumeattributesclass"
  | "ingressclass"
  | "resourcequota"
  | "horizontalpodautoscaler"
  | "verticalpodautoscaler"
  | "limitrange"
  | "poddisruptionbudget"
  | "priorityclass"
  | "runtimeclass"
  | "lease"
  | "controllerrevision"
  | "mutatingwebhookconfiguration"
  | "validatingwebhookconfiguration"
  | "gatewayclass"
  | "gateway"
  | "httproute"
  | "grpcroute"
  | "jobset"
  | "customresourcedefinition";

export type Health = "healthy" | "degraded" | "failed" | "unknown";

export type WorkloadSummary = {
  kind: WorkloadKind;
  name: string;
  namespace: string;
  ready: string;
  age_seconds: number;
  health: Health;
  labels: Record<string, string>;
  // Pod-only enrichment (omitted on the wire for non-pod kinds via
  // serde skip_serializing_if). Optional on the TS side.
  restart_count?: number;
  container_count?: number;
  container_ready_count?: number;
  node_name?: string;
  controlled_by?: OwnerRefLite;
  qos_class?: string;
  cpu_milli?: number;
  mem_bytes?: number;
  pod_phase?: string;
};

export type OwnerRefLite = { kind: string; name: string };

export type PodCondition = { type: string; status: string };

export type ContainerInfo = {
  name: string;
  image: string;
  ready: boolean;
  restart_count: number;
  state: string;
  cpu_request_milli: number | null;
  cpu_limit_milli: number | null;
  mem_request_bytes: number | null;
  mem_limit_bytes: number | null;
};

export type PodDetails = {
  name: string;
  namespace: string;
  status: string;
  qos_class: string;
  node_name: string | null;
  controlled_by: OwnerRefLite | null;
  service_account: string | null;
  pod_ip: string | null;
  pod_ips: string[];
  conditions: PodCondition[];
  tolerations: number;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  containers: ContainerInfo[];
  cpu_usage_milli: number | null;
  mem_usage_bytes: number | null;
  age_seconds: number;
  created_at_ms: number;
};

export type ResourceDetail = {
  summary: WorkloadSummary;
  yaml: string;
  owner_refs: OwnerRefLite[];
};

export type RbacRuleDetail = {
  api_groups: string[];
  resources: string[];
  resource_names: string[];
  non_resource_urls: string[];
  verbs: string[];
};

export type RbacSubjectDetail = {
  kind: string;
  name: string;
  namespace: string | null;
};

export type RbacDetail = {
  role_ref: string | null;
  subjects: RbacSubjectDetail[];
  rules: RbacRuleDetail[];
};

export type StorageDetail = {
  phase: string | null;
  capacity: string | null;
  access_modes: string[];
  storage_class: string | null;
  volume_name: string | null;
  reclaim_policy: string | null;
  binding_mode: string | null;
  provisioner: string | null;
  allow_expansion: boolean | null;
  claim_ref: string | null;
  parameters: Record<string, string>;
};

export type ResourceInsightRow = {
  label: string;
  value: string;
};

export type ResourceInsightSection = {
  title: string;
  rows: ResourceInsightRow[];
};

export type ResourceInsights = {
  sections: ResourceInsightSection[];
};

// ─── Fleet ────────────────────────────────────────────────────────────────

export type FleetHealth = {
  pods_total: number;
  pods_ready: number;
  pods_pending: number;
  pods_failed: number;
};

export type FleetCard = {
  context: ContextInfo;
  reachable: boolean;
  error: string | null;
  server_version: string | null;
  node_count: number;
  node_ready: number;
  namespace_count: number;
  workload_count: number;
  health: FleetHealth;
  cpu_percent: number | null;
  mem_percent: number | null;
  fetched_at_ms: number;
};

export type NodeSummary = {
  name: string;
  roles: string[];
  version: string;
  ready: boolean;
  os_image: string;
  arch: string;
  cpu_capacity_milli: number;
  mem_capacity_bytes: number;
  pods_capacity: number;
  cpu_allocatable_milli: number;
  mem_allocatable_bytes: number;
  taints: string[];
  age_seconds: number;
  cpu_usage_milli: number | null;
  mem_usage_bytes: number | null;
};

// ─── CloudMap ─────────────────────────────────────────────────────────────

export type MapNodeKind =
  | "namespace"
  | "deployment"
  | "statefulset"
  | "daemonset"
  | "cronjob"
  | "job"
  | "pod"
  | "service"
  | "ingress"
  | "configmap"
  | "secret"
  | "persistent_volume_claim"
  | "node"
  | "hpa";

export type EdgeKind =
  | "selects"
  | "routes"
  | "owned_by"
  | "mounts"
  | "scales"
  | "scheduled_on";

export type MapNode = {
  id: string;
  kind: MapNodeKind;
  name: string;
  namespace: string | null;
  health: Health;
  heat: number;
  ready: string | null;
  labels: Record<string, string>;
  replicas: number | null;
  extra: Record<string, string>;
};

export type MapEdge = { from: string; to: string; kind: EdgeKind };

export type CloudMap = {
  context: string;
  nodes: MapNode[];
  edges: MapEdge[];
  fetched_at_ms: number;
};

// ─── Security ─────────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Finding = {
  rule_id: string;
  title: string;
  severity: Severity;
  category: string;
  resource_kind: string;
  resource_name: string;
  namespace: string | null;
  detail: string;
  remediation: string;
};

export type SecurityReport = {
  context: string;
  findings: Finding[];
  scanned_at_ms: number;
  counts_by_severity: Record<string, number>;
  resources_scanned: number;
};

export type AccessReviewRequest = {
  kind: WorkloadKind;
  verb: string;
  namespace?: string | null;
  name?: string | null;
  subresource?: string | null;
};

export type AccessReviewResult = {
  allowed: boolean;
  denied: boolean;
  reason: string | null;
  evaluation_error: string | null;
};

// ─── CRD Browser ──────────────────────────────────────────────────────────

export type CrdSummary = {
  name: string;
  group: string;
  kind: string;
  plural: string;
  short_names: string[];
  scope: string;
  versions: string[];
  preferred_version: string;
  age_seconds: number;
};

export type CrInstance = {
  name: string;
  namespace: string | null;
  age_seconds: number;
  status_hint: string | null;
};

// ─── Team Access ──────────────────────────────────────────────────────────

export type AccessTemplate = "viewer" | "editor" | "admin";

export type TokenMode = "short" | "long";

export type TeamAccessRequest = {
  member_id: string;
  namespaces: string[];
  template: AccessTemplate;
  ttl_hours: number;
  long_lived: boolean;
  service_account_namespace: string | null;
};

export type CreatedObject = {
  kind: string;
  name: string;
  namespace: string | null;
};

export type TeamAccessResult = {
  service_account: string;
  sa_namespace: string;
  token_expires_at: string;
  kubeconfig_yaml: string;
  created: CreatedObject[];
};

export type TeamGrant = {
  member_id: string;
  template: AccessTemplate | null;
  token_mode: TokenMode | null;
  service_account: string | null;
  sa_namespace: string | null;
  sa_age_seconds: number;
  cluster_wide: boolean;
  namespaces: string[];
  object_count: number;
};

// ─── Port forwards ────────────────────────────────────────────────────────

export type ForwardTargetKind = "pod" | "service";

export type ForwardSession = {
  id: string;
  context: string;
  namespace: string;
  target_kind: ForwardTargetKind;
  target_name: string;
  pod_name: string;
  local_port: number;
  remote_port: number;
  started_at_ms: number;
  bytes_in: number;
  bytes_out: number;
  connections: number;
  last_error: string | null;
};

export type PodContainerInfo = {
  name: string;
  image: string;
  is_init: boolean;
  is_default: boolean;
};

export type ApplyOutcome = {
  yaml: string;
  dry_run: boolean;
};

// ─── Helm ─────────────────────────────────────────────────────────────────

export type HelmReleaseSummary = {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart_name: string;
  chart_version: string;
  app_version: string;
  last_deployed: string | null;
  description: string | null;
};

export type HelmReleaseDetail = {
  summary: HelmReleaseSummary;
  first_deployed: string | null;
  chart_description: string | null;
  chart_home: string | null;
  chart_icon: string | null;
  chart_sources: string[];
  chart_api_version: string | null;
  chart_type: string | null;
  chart_kube_version: string | null;
  user_values_yaml: string;
  chart_values_yaml: string;
  manifest: string;
  notes: string | null;
};

// ─── Events + actions ─────────────────────────────────────────────────────

export type EventSummary = {
  ts: string | null;
  type_: string;
  reason: string;
  message: string;
  involved_kind: string;
  involved_name: string;
  count: number | null;
};

// ─── API ──────────────────────────────────────────────────────────────────

export const k8s = {
  listContexts: () => invoke<ContextInfo[]>("list_contexts"),
  setContext: (name: string) => invoke<ContextInfo>("set_context", { name }),
  deleteContext: (name: string) => invoke<void>("delete_context", { name }),
  listDeletedContexts: () =>
    invoke<DeletedContextSummary[]>("list_deleted_contexts"),
  restoreDeletedContext: (name: string, overwrite = false) =>
    invoke<void>("restore_deleted_context", { name, overwrite }),
  listNamespaces: (context?: string) =>
    invoke<string[]>("list_namespaces", { context }),
  listWorkloads: (namespace: string, kind: WorkloadKind, context?: string) =>
    invoke<WorkloadSummary[]>("list_workloads", { namespace, kind, context }),
  getResource: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) => invoke<ResourceDetail>("get_resource", { namespace, kind, name, context }),
  listPodsFor: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) =>
    invoke<WorkloadSummary[]>("list_pods_for", { namespace, kind, name, context }),
  getPodDetails: (ctx: string, namespace: string, name: string) =>
    invoke<PodDetails>("get_pod_details", { ctx, namespace, name }),
  listFleet: () => invoke<FleetCard[]>("list_fleet"),
  probeFleetContext: (context: string) =>
    invoke<FleetCard>("probe_fleet_context", { context }),
  disconnectContext: (context: string) =>
    invoke<void>("disconnect_context", { context }),
  reconnectAll: () => invoke<void>("reconnect_all"),
  listNodes: (context?: string) =>
    invoke<NodeSummary[]>("list_nodes", { context }),
  cloudMap: (context?: string, namespace?: string) =>
    invoke<CloudMap>("cloud_map", { context, namespace }),
  securityScan: (context?: string) =>
    invoke<SecurityReport>("security_scan", { context }),
  checkAccess: (request: AccessReviewRequest, context?: string) =>
    invoke<AccessReviewResult>("check_access", { request, context }),
  getRbacDetails: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) => invoke<RbacDetail>("get_rbac_details", { namespace, kind, name, context }),
  getStorageDetails: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) =>
    invoke<StorageDetail>("get_storage_details", {
      namespace,
      kind,
      name,
      context,
    }),
  getResourceInsights: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) =>
    invoke<ResourceInsights>("get_resource_insights", {
      namespace,
      kind,
      name,
      context,
    }),
  listCrds: (context?: string) => invoke<CrdSummary[]>("list_crds", { context }),
  listCrInstances: (
    group: string,
    version: string,
    kind: string,
    plural: string,
    namespace?: string,
    context?: string,
  ) =>
    invoke<CrInstance[]>("list_cr_instances", {
      group,
      version,
      kind,
      plural,
      namespace,
      context,
    }),
  getCrYaml: (
    group: string,
    version: string,
    kind: string,
    plural: string,
    name: string,
    namespace?: string,
    context?: string,
  ) =>
    invoke<string>("get_cr_yaml", {
      group,
      version,
      kind,
      plural,
      name,
      namespace,
      context,
    }),
  provisionTeamAccess: (request: TeamAccessRequest, context?: string) =>
    invoke<TeamAccessResult>("provision_team_access", { request, context }),
  revokeTeamAccess: (
    memberId: string,
    namespaces: string[],
    context?: string,
  ) =>
    invoke<CreatedObject[]>("revoke_team_access", {
      memberId,
      namespaces,
      context,
    }),
  listTeamAccess: (context?: string) =>
    invoke<TeamGrant[]>("list_team_access", { context }),
  renewTeamToken: (memberId: string, ttlHours: number, context?: string) =>
    invoke<TeamAccessResult>("renew_team_token", {
      memberId,
      ttlHours,
      context,
    }),
  rotateTeamToken: (memberId: string, context?: string) =>
    invoke<TeamAccessResult>("rotate_team_token", { memberId, context }),
  listEventsFor: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) =>
    invoke<EventSummary[]>("list_events_for", {
      namespace,
      kind,
      name,
      context,
    }),
  restartWorkload: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) => invoke<void>("restart_workload", { namespace, kind, name, context }),
  scaleWorkload: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    replicas: number,
    context?: string,
  ) =>
    invoke<void>("scale_workload", {
      namespace,
      kind,
      name,
      replicas,
      context,
    }),
  deletePod: (namespace: string, name: string, context?: string) =>
    invoke<void>("delete_pod", { namespace, name, context }),
  deleteResource: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    context?: string,
  ) => invoke<void>("delete_resource", { namespace, kind, name, context }),
  listPodContainers: (namespace: string, pod: string, context?: string) =>
    invoke<PodContainerInfo[]>("list_pod_containers", { namespace, pod, context }),
  startPortForward: (opts: {
    namespace: string;
    targetKind: ForwardTargetKind;
    targetName: string;
    localPort: number;
    remotePort: number;
    context?: string;
  }) =>
    invoke<ForwardSession>("start_port_forward", {
      namespace: opts.namespace,
      targetKind: opts.targetKind,
      targetName: opts.targetName,
      localPort: opts.localPort,
      remotePort: opts.remotePort,
      context: opts.context,
    }),
  listPortForwards: () => invoke<ForwardSession[]>("list_port_forwards"),
  stopPortForward: (id: string) => invoke<boolean>("stop_port_forward", { id }),
  applyResource: (
    namespace: string,
    kind: WorkloadKind,
    name: string,
    yaml: string,
    dryRun: boolean,
    context?: string,
  ) =>
    invoke<ApplyOutcome>("apply_resource", {
      namespace,
      kind,
      name,
      yaml,
      dryRun,
      context,
    }),
  listHelmReleases: (context?: string) =>
    invoke<HelmReleaseSummary[]>("list_helm_releases", { context }),
  getHelmRelease: (
    namespace: string,
    name: string,
    revision?: number,
    context?: string,
  ) =>
    invoke<HelmReleaseDetail>("get_helm_release", {
      namespace,
      name,
      revision: revision ?? null,
      context,
    }),
  listHelmHistory: (namespace: string, name: string, context?: string) =>
    invoke<HelmReleaseSummary[]>("list_helm_history", { namespace, name, context }),
  helmInstall: (
    request: HelmInstallRequest,
    streamId: string,
    channel: import("@tauri-apps/api/core").Channel<HelmEvent>,
    context?: string,
  ) =>
    invoke<void>("helm_install", { request, streamId, channel, context }),
  helmUpgrade: (
    request: HelmUpgradeRequest,
    streamId: string,
    channel: import("@tauri-apps/api/core").Channel<HelmEvent>,
    context?: string,
  ) =>
    invoke<void>("helm_upgrade", { request, streamId, channel, context }),
  helmRollback: (
    request: HelmRollbackRequest,
    streamId: string,
    channel: import("@tauri-apps/api/core").Channel<HelmEvent>,
    context?: string,
  ) =>
    invoke<void>("helm_rollback", { request, streamId, channel, context }),
  helmUninstall: (
    request: HelmUninstallRequest,
    streamId: string,
    channel: import("@tauri-apps/api/core").Channel<HelmEvent>,
    context?: string,
  ) =>
    invoke<void>("helm_uninstall", { request, streamId, channel, context }),
  // Pod attach commands. See PodTerminal for end-to-end usage.
  startPodAttach: (
    request: {
      namespace: string;
      pod: string;
      container: string | null;
      command: string[];
      tty: boolean;
      cols?: number;
      rows?: number;
    },
    channel: import("@tauri-apps/api/core").Channel<AttachEvent>,
    context?: string,
  ) =>
    invoke<string>("start_pod_attach", {
      request,
      channel,
      context,
    }),
  podAttachStdin: (id: string, bytes: number[]) =>
    invoke<void>("pod_attach_stdin", { id, bytes }),
  podAttachResize: (id: string, cols: number, rows: number) =>
    invoke<void>("pod_attach_resize", { id, cols, rows }),
  podAttachClose: (id: string) => invoke<void>("pod_attach_close", { id }),
};

// ─── Helm write ops (CLI shell-out) ───────────────────────────────────────

export type HelmEvent =
  | { kind: "stdout"; line: string }
  | { kind: "stderr"; line: string }
  | { kind: "exited"; code: number }
  | { kind: "error"; message: string };

export type HelmInstallRequest = {
  release: string;
  chart: string;
  namespace: string;
  version: string | null;
  values_yaml: string | null;
  create_namespace: boolean;
  wait: boolean;
};

export type HelmUpgradeRequest = {
  release: string;
  chart: string;
  namespace: string;
  version: string | null;
  values_yaml: string | null;
  install: boolean;
  wait: boolean;
  atomic: boolean;
};

export type HelmRollbackRequest = {
  release: string;
  namespace: string;
  revision: number;
  wait: boolean;
};

export type HelmUninstallRequest = {
  release: string;
  namespace: string;
  keep_history: boolean;
};

// ─── Watches ──────────────────────────────────────────────────────────────
//
// Watches stream `WatchEvent<T>`s through a Tauri Channel. The frontend only
// uses them as cache-invalidation triggers today (not as the data source) —
// the existing `useQuery` keeps working and simply re-runs when the watch
// reports an Apply/Delete. Cancellation is via `stop_stream` with the same
// `streamId` used to open the watch.

export type WatchEvent<T> =
  | { kind: "applied"; item: T }
  | { kind: "deleted"; name: string }
  | { kind: "init_done" }
  | { kind: "error"; message: string };

// ─── Pod attach (terminal) ────────────────────────────────────────────────

export type AttachEvent =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "closed"; message: string | null; exit_code: number | null };
