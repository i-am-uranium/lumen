import { useEffect } from "react";
import { NavLink, Outlet, useParams, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Clock,
  Cpu,
  Database,
  FileBox,
  Folder,
  Layers,
  Lock,
  Map as MapIcon,
  Network,
  Package,
  Repeat,
  Server,
  ShieldAlert,
  Sparkles,
  Star,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { PortForwardsChip } from "@/components/PortForwardsChip";
import { k8s } from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { useClusterStore } from "@/state/cluster";
import { useRailState } from "@/hooks/useRailState";
import { usePinnedResources, type PinnedRef } from "@/hooks/usePinnedResources";
import { useRecentResources } from "@/hooks/useRecentResources";

const RAIL_W = 220;
const RAIL_W_COLLAPSED = 56;
const COLLAPSED_ROW =
  "mx-auto flex size-10 items-center justify-center rounded-control border text-text-secondary transition-colors";

type LeafItem = {
  kind: "leaf";
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
};

type GroupItem = {
  kind: "group";
  id: string;
  label: string;
  icon: LucideIcon;
  // Optional: clicking the row also navigates to a default route.
  defaultTo?: string;
  children: { to: string; label: string; end?: boolean }[];
};

type StubItem = {
  kind: "stub";
  id: string;
  label: string;
  icon: LucideIcon;
};

type Divider = { kind: "divider" };

type Item = LeafItem | GroupItem | StubItem | Divider;

const SECTIONS: Item[] = [
  {
    kind: "group",
    id: "triage",
    label: "triage",
    icon: Layers,
    defaultTo: "workloads",
    children: [
      { to: "workloads", label: "workloads", end: true },
      { to: "workloads/pods", label: "pods" },
      { to: "events", label: "events" },
      { to: "logs", label: "logs" },
    ],
  },
  { kind: "leaf", to: "nodes", label: "nodes", icon: Server },
  { kind: "leaf", to: "namespaces", label: "namespaces", icon: Folder },

  { kind: "divider" },
  {
    kind: "group",
    id: "workloads",
    label: "workloads",
    icon: Boxes,
    children: [
      { to: "workloads/deployments", label: "deployments" },
      { to: "workloads/statefulsets", label: "statefulsets" },
      { to: "workloads/daemonsets", label: "daemonsets" },
      { to: "workloads/replicasets", label: "replica sets" },
      { to: "workloads/replicationcontrollers", label: "replication controllers" },
      { to: "workloads/jobs", label: "jobs" },
      { to: "workloads/cronjobs", label: "cronjobs" },
      { to: "workloads/jobsets", label: "job sets" },
    ],
  },
  // Config / Network / Storage groups — list views are routed through
  // WorkloadsView with kind-specific slugs (PR B v1: ConfigMaps, Secrets,
  // Services, Ingresses, NetworkPolicies, PVCs). Cluster-scoped resources
  // (PV, StorageClass, IngressClass, etc.) come in PR B+1.
  {
    kind: "group",
    id: "config",
    label: "config",
    icon: Cpu,
    children: [
      { to: "workloads/configmaps", label: "configmaps" },
      { to: "workloads/secrets", label: "secrets" },
      { to: "workloads/resourcequotas", label: "resource quotas" },
      { to: "workloads/limitranges", label: "limit ranges" },
      { to: "workloads/hpas", label: "hpas" },
      { to: "workloads/vpas", label: "vpas" },
      { to: "workloads/pdbs", label: "pdbs" },
      { to: "workloads/priorityclasses", label: "priority classes" },
      { to: "workloads/runtimeclasses", label: "runtime classes" },
      { to: "workloads/mutatingwebhooks", label: "mutating webhooks" },
      { to: "workloads/validatingwebhooks", label: "validating webhooks" },
    ],
  },
  {
    kind: "group",
    id: "network",
    label: "network",
    icon: Network,
    children: [
      { to: "workloads/services", label: "services" },
      { to: "workloads/endpoints", label: "endpoints" },
      { to: "workloads/endpointslices", label: "endpoint slices" },
      { to: "workloads/ingresses", label: "ingresses" },
      { to: "workloads/ingressclasses", label: "ingress classes" },
      { to: "workloads/gatewayclasses", label: "gateway classes" },
      { to: "workloads/gateways", label: "gateways" },
      { to: "workloads/httproutes", label: "http routes" },
      { to: "workloads/grpcroutes", label: "grpc routes" },
      { to: "workloads/networkpolicies", label: "network policies" },
    ],
  },
  {
    kind: "group",
    id: "storage",
    label: "storage",
    icon: Database,
    children: [
      { to: "workloads/pvcs", label: "pvcs" },
      { to: "workloads/pvs", label: "persistent volumes" },
      { to: "workloads/storageclasses", label: "storage classes" },
      { to: "workloads/volumeattributesclasses", label: "volume attributes" },
    ],
  },

  {
    kind: "group",
    id: "rbac",
    label: "rbac",
    icon: Lock,
    children: [
      { to: "workloads/serviceaccounts", label: "service accounts" },
      { to: "workloads/roles", label: "roles" },
      { to: "workloads/rolebindings", label: "role bindings" },
      { to: "workloads/clusterroles", label: "cluster roles" },
      { to: "workloads/clusterrolebindings", label: "cluster role bindings" },
    ],
  },

  {
    kind: "group",
    id: "cluster-meta",
    label: "cluster metadata",
    icon: FileBox,
    children: [
      { to: "workloads/leases", label: "leases" },
      { to: "workloads/controllerrevisions", label: "controller revisions" },
    ],
  },

  { kind: "divider" },
  { kind: "leaf", to: "access", label: "access control", icon: UserPlus },
  { kind: "leaf", to: "ai", label: "AI assistant", icon: Sparkles },
  { kind: "leaf", to: "helm", label: "helm", icon: Package },
  { kind: "leaf", to: "crds", label: "custom resources", icon: Boxes },
  { kind: "leaf", to: "security", label: "security", icon: ShieldAlert },

  { kind: "divider" },
  { kind: "leaf", to: "map", label: "cloudmap", icon: MapIcon },
];

const navRow = ({ isActive }: { isActive: boolean }, collapsed: boolean) =>
  cn(
    "group relative flex items-center gap-2 rounded-md text-[12px] transition-colors border",
    collapsed ? COLLAPSED_ROW : "h-7 px-2 mx-1.5",
    isActive
      ? "bg-accent-primary-soft text-accent-primary border-accent-primary/40"
      : "text-text-secondary hover:text-text-primary hover:bg-hover border-transparent",
  );

const childRow = ({ isActive }: { isActive: boolean }) =>
  cn(
    "flex items-center h-6 rounded-md text-[12px] pl-9 pr-2 mx-1.5 transition-colors border",
    isActive
      ? "bg-accent-primary-soft text-accent-primary border-accent-primary/40"
      : "text-text-secondary hover:text-text-primary hover:bg-hover border-transparent",
  );

function inferIcon(kind: string): LucideIcon {
  const k = kind.toLowerCase();
  if (k === "pod") return Box;
  if (k === "deployment") return Layers;
  if (k === "statefulset") return Database;
  if (k === "daemonset") return Server;
  if (k === "job") return Repeat;
  if (k === "cronjob") return Clock;
  if (k === "node") return Server;
  if (k === "namespace") return Folder;
  if (k === "configmap") return FileBox;
  if (k === "secret") return Lock;
  return Boxes;
}

function refKey(r: PinnedRef): string {
  return `${r.kind}|${r.namespace ?? ""}|${r.name}`;
}

function refToPath(r: PinnedRef): string {
  // For now there are no per-resource detail routes wired up — we route
  // pinned/recent items to the corresponding list view as a best-effort. The
  // route wiring (App.tsx) is the main agent's job; if/when detail routes
  // exist, this can be updated.
  const k = r.kind.toLowerCase();
  const map: Record<string, string> = {
    pod: "workloads/pods",
    deployment: "workloads/deployments",
    statefulset: "workloads/statefulsets",
    daemonset: "workloads/daemonsets",
    job: "workloads/jobs",
    cronjob: "workloads/cronjobs",
    node: "nodes",
    namespace: "namespaces",
  };
  return map[k] ?? "workloads";
}

function Header({
  context,
  isProd,
  cluster,
  collapsed,
  onBack,
}: {
  context: string;
  isProd: boolean;
  cluster?: string | null;
  collapsed: boolean;
  onBack: () => void;
}) {
  if (collapsed) {
    return (
      <button
        onClick={onBack}
        className="flex h-12 w-full items-center justify-center border-b border-border-default text-text-secondary hover:text-text-primary"
        title={`back to fleet · ${context}`}
        aria-label="back to fleet"
      >
        <ChevronLeft className="size-4" />
      </button>
    );
  }
  return (
    <div className="h-12 px-3 flex items-center gap-2 border-b border-border-default shrink-0">
      <button
        onClick={onBack}
        className="text-text-secondary hover:text-text-primary inline-flex items-center gap-1 text-[11px] shrink-0"
        title="back to fleet"
      >
        <ChevronLeft className="size-3.5" /> fleet
      </button>
      <span className="text-text-muted">/</span>
      <div className="flex flex-col min-w-0 flex-1">
        <span
          className="mds-heading text-[13px] text-text-primary truncate"
          title={context}
        >
          {context}
        </span>
        <div className="flex items-center gap-1.5 mt-0.5">
          {isProd && (
            <span className="px-1 py-px text-[9px] rounded bg-danger/15 text-danger border border-danger/40 font-semibold uppercase tracking-wide">
              prod
            </span>
          )}
          {cluster && (
            <span className="text-[10px] text-text-muted truncate" title={cluster}>
              {cluster}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupHeader({
  label,
  icon: Icon,
  open,
  onToggle,
  collapsed,
  to,
}: {
  label: string;
  icon: LucideIcon;
  open: boolean;
  onToggle: () => void;
  collapsed: boolean;
  to?: string;
}) {
  if (collapsed) {
    // In collapsed mode, render the icon as a NavLink (or button) that just
    // routes to the default path. Group expansion is hidden.
    if (to) {
      return (
        <NavLink
          to={to}
          className={(s) => navRow(s, true)}
          title={label}
          end={to === "workloads"}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </NavLink>
      );
    }
    return (
      <button
        onClick={onToggle}
        className={cn(
          COLLAPSED_ROW,
          "border-transparent hover:bg-hover hover:text-text-primary",
        )}
        title={label}
        aria-label={label}
      >
        <Icon className="size-3.5" />
      </button>
    );
  }
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex items-center mx-1.5 h-7 rounded-md text-[12px] text-text-secondary hover:bg-hover hover:text-text-primary">
      {to ? (
        <NavLink
          to={to}
          end={to === "workloads"}
          className={({ isActive }) =>
            cn(
              "flex-1 flex items-center gap-2 h-7 px-2 rounded-md",
              isActive && "text-accent-primary",
            )
          }
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </NavLink>
      ) : (
        <button
          onClick={onToggle}
          className="flex-1 flex items-center gap-2 h-7 px-2 rounded-md text-left"
          aria-expanded={open}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </button>
      )}
      <button
        onClick={onToggle}
        aria-label={`${open ? "collapse" : "expand"} ${label}`}
        className="px-1.5 h-7 inline-flex items-center text-text-muted hover:text-text-primary"
      >
        <Chevron className="size-3.5" />
      </button>
    </div>
  );
}

function StubRow({
  label,
  icon: Icon,
  collapsed,
}: {
  label: string;
  icon: LucideIcon;
  collapsed: boolean;
}) {
  if (collapsed) {
    return (
      <div
        className={cn(COLLAPSED_ROW, "cursor-not-allowed border-transparent text-text-muted/60")}
        title={`${label} — coming soon`}
        aria-disabled="true"
      >
        <Icon className="size-3.5" />
      </div>
    );
  }
  return (
    <div
      className="flex items-center mx-1.5 h-7 px-2 rounded-md text-[12px] text-text-muted/70 cursor-not-allowed select-none"
      title="coming soon"
      aria-disabled="true"
    >
      <Icon className="size-3.5 mr-2" aria-hidden="true" />
      <span className="truncate flex-1">{label}</span>
      <ChevronRight className="size-3.5 opacity-60" />
      <span className="ml-1 text-[9px] uppercase tracking-wide opacity-60">
        soon
      </span>
    </div>
  );
}

function PinnedSection({
  ctx,
  collapsed,
  open,
  onToggle,
}: {
  ctx: string;
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { items, unpin } = usePinnedResources(ctx);
  if (collapsed) {
    return (
      <div className="py-1.5">
        <div
          className={cn(COLLAPSED_ROW, "border-transparent text-text-muted")}
          title={`pinned (${items.length})`}
        >
          <Star className="size-3.5" />
        </div>
        {items.slice(0, 5).map((r) => {
          const Icon = inferIcon(r.kind);
          return (
            <NavLink
              key={refKey(r)}
              to={refToPath(r)}
              className={(s) => navRow(s, true)}
              title={`${r.kind}/${r.name}`}
            >
              <Icon className="size-3.5" />
            </NavLink>
          );
        })}
      </div>
    );
  }
  return (
    <div className="py-1">
      <button
        onClick={onToggle}
        className="flex items-center mx-1.5 h-6 px-2 w-[calc(100%-12px)] rounded-md text-[10px] uppercase tracking-wider text-text-muted hover:text-text-primary"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3 mr-1" />
        ) : (
          <ChevronRight className="size-3 mr-1" />
        )}
        <Star className="size-3 mr-1.5" />
        <span className="flex-1 text-left">pinned</span>
        <span className="text-text-muted/70 normal-case tracking-normal text-[10px]">
          {items.length}
        </span>
      </button>
      {open && (
        <div className="mt-1">
          {items.length === 0 ? (
            <div className="mx-3 px-2 py-1 text-[11px] text-text-muted italic">
              No pinned resources
            </div>
          ) : (
            items.map((r) => {
              const Icon = inferIcon(r.kind);
              return (
                <div
                  key={refKey(r)}
                  className="group flex items-center mx-1.5 h-7 rounded-md text-[12px] text-text-secondary hover:bg-hover hover:text-text-primary"
                >
                  <NavLink
                    to={refToPath(r)}
                    className={({ isActive }) =>
                      cn(
                        "flex-1 flex items-center gap-2 h-7 px-2 rounded-md min-w-0",
                        isActive && "text-accent-primary",
                      )
                    }
                    title={`${r.kind}/${r.namespace ? `${r.namespace}/` : ""}${r.name}`}
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{r.name}</span>
                  </NavLink>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      unpin(r);
                    }}
                    className="px-1.5 h-7 text-text-muted opacity-0 group-hover:opacity-100 hover:text-danger"
                    aria-label={`unpin ${r.kind}/${r.name}`}
                    title="unpin"
                  >
                    <Star className="size-3 fill-current" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function RecentSection({
  ctx,
  collapsed,
  open,
  onToggle,
}: {
  ctx: string;
  collapsed: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { items } = useRecentResources(ctx);
  // Spec: hide entire section when empty.
  if (items.length === 0) return null;

  if (collapsed) {
    return (
      <div className="py-1.5">
        <div
          className={cn(COLLAPSED_ROW, "border-transparent text-text-muted")}
          title={`recent (${items.length})`}
        >
          <Clock className="size-3.5" />
        </div>
        {items.slice(0, 5).map((r) => {
          const Icon = inferIcon(r.kind);
          return (
            <NavLink
              key={refKey(r)}
              to={refToPath(r)}
              className={(s) => navRow(s, true)}
              title={`${r.kind}/${r.name}`}
            >
              <Icon className="size-3.5" />
            </NavLink>
          );
        })}
      </div>
    );
  }
  return (
    <div className="py-1">
      <button
        onClick={onToggle}
        className="flex items-center mx-1.5 h-6 px-2 w-[calc(100%-12px)] rounded-md text-[10px] uppercase tracking-wider text-text-muted hover:text-text-primary"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3 mr-1" />
        ) : (
          <ChevronRight className="size-3 mr-1" />
        )}
        <Clock className="size-3 mr-1.5" />
        <span className="flex-1 text-left">recent</span>
        <span className="text-text-muted/70 normal-case tracking-normal text-[10px]">
          {items.length}
        </span>
      </button>
      {open && (
        <div className="mt-1">
          {items.map((r) => {
            const Icon = inferIcon(r.kind);
            return (
              <NavLink
                key={refKey(r)}
                to={refToPath(r)}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-2 mx-1.5 h-7 px-2 rounded-md text-[12px] border",
                    isActive
                      ? "bg-accent-primary-soft text-accent-primary border-accent-primary/40"
                      : "text-text-secondary hover:text-text-primary hover:bg-hover border-transparent",
                  )
                }
                title={`${r.kind}/${r.namespace ? `${r.namespace}/` : ""}${r.name}`}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{r.name}</span>
              </NavLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ClusterWorkspace() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const nav = useNavigate();
  const { setContext } = useClusterStore();
  const rail = useRailState(context);

  const { data: ctxs } = useQuery({
    queryKey: ["k8s", "contexts"],
    queryFn: k8s.listContexts,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (!context) return;
    setContext(context);
    k8s.setContext(context).catch(() => {
      /* non-fatal */
    });
  }, [context, setContext]);

  const info = ctxs?.find((c) => c.name === context);
  const collapsed = rail.collapsed;
  const railWidth = collapsed ? RAIL_W_COLLAPSED : RAIL_W;

  return (
    <div className="flex h-full">
      <aside
        className="flex flex-col h-full bg-surface border-r border-border-default shrink-0 transition-[width] duration-150"
        style={{ width: railWidth }}
        aria-label="cluster navigation"
      >
        <Header
          context={context}
          isProd={!!info?.is_prod}
          cluster={info?.cluster ?? null}
          collapsed={collapsed}
          onBack={() => nav("/cluster")}
        />

        <nav className={cn("flex-1 min-h-0 overflow-y-auto", collapsed ? "py-2" : "py-1.5")}>
          {SECTIONS.map((item, idx) => {
            if (item.kind === "divider") {
              return (
                <div
                  key={`div-${idx}`}
                  className={cn(
                    "border-t border-border-default",
                    collapsed ? "my-2" : "my-1.5",
                  )}
                />
              );
            }
            if (item.kind === "leaf") {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={(s) => navRow(s, collapsed)}
                  title={item.label}
                >
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </NavLink>
              );
            }
            if (item.kind === "stub") {
              return (
                <StubRow
                  key={item.id}
                  label={item.label}
                  icon={item.icon}
                  collapsed={collapsed}
                />
              );
            }
            // group
            const open = rail.isGroupOpen(item.id);
            return (
              <div key={item.id}>
                <GroupHeader
                  label={item.label}
                  icon={item.icon}
                  open={open}
                  onToggle={() => rail.toggleGroup(item.id)}
                  collapsed={collapsed}
                  to={item.defaultTo}
                />
                {!collapsed && open && (
                  <div className="mt-0.5 mb-1">
                    {item.children.map((c) => (
                      <NavLink
                        key={c.to}
                        to={c.to}
                        end={c.end}
                        className={childRow}
                      >
                        <span className="truncate">{c.label}</span>
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          <div className={cn("border-t border-border-default", collapsed ? "my-2" : "my-1.5")} />

          <PinnedSection
            ctx={context}
            collapsed={collapsed}
            open={rail.isGroupOpen("pinned")}
            onToggle={() => rail.toggleGroup("pinned")}
          />
          <RecentSection
            ctx={context}
            collapsed={collapsed}
            open={rail.isGroupOpen("recent")}
            onToggle={() => rail.toggleGroup("recent")}
          />
        </nav>

        {/* Footer: port-forwards chip + collapse toggle */}
        <div className="border-t border-border-default shrink-0">
          <div
            className={cn(
              "flex items-center gap-1 px-2 py-2",
              collapsed ? "justify-center" : "justify-between",
            )}
          >
            {!collapsed && <PortForwardsChip />}
            {collapsed && (
              <div className="flex size-10 items-center justify-center">
                <PortForwardsChip />
              </div>
            )}
            <button
              onClick={rail.toggleCollapsed}
              className={cn(
                "inline-flex items-center justify-center rounded-md text-text-muted hover:bg-hover hover:text-text-primary",
                collapsed ? "size-10" : "size-7",
              )}
              title={collapsed ? "expand rail" : "collapse rail"}
              aria-label={collapsed ? "expand rail" : "collapse rail"}
            >
              {collapsed ? (
                <ChevronsRight className="size-3.5" />
              ) : (
                <ChevronsLeft className="size-3.5" />
              )}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 min-w-0 min-h-0">
        <Outlet />
      </div>
    </div>
  );
}
