import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { YamlModal } from "@/components/YamlModal";
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog";
import { EventsModal } from "@/components/EventsModal";
import { PortForwardDialog } from "@/components/PortForwardDialog";
import { PinButton } from "@/components/PinButton";
import { useShellDock } from "@/hooks/useShellDock";
import { useRecentResources } from "@/hooks/useRecentResources";
import { aiResourceUrl } from "@/lib/aiNavigation";
// Lazy-load the terminal: xterm.js + addons + their CSS together weigh
// ~200KB and only matter when a user actually opens a pod shell. Keeping
// it out of the main bundle means cluster browsing pays nothing for the
// feature until it's used.
// PodTerminal modal removed in favor of ShellDock; "shell" action now
// dispatches openSession into the bottom dock.
import {
  Boxes,
  Database,
  Eye,
  Globe,
  Layers,
  Link as LinkIcon,
  Lock,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Search,
  Server,
  Sparkles,
  Target,
  Terminal,
  TerminalSquare,
  Trash2,
  RotateCw,
  ScrollText,
  Scaling,
  FileCode,
  Radio,
  X,
  Zap,
} from "lucide-react";
import {
  k8s,
  type CloudMap as CM,
  type MapNode,
  type MapEdge,
  type Health,
  type WorkloadKind,
} from "@/lib/k8s";
import { cn } from "@/lib/utils";
import { useK8sWatch } from "@/hooks/useK8sWatch";

// ─── Layout: a small hand-rolled force simulation. ───────────────────────
//
// Nodes repel each other (inverse-square), edges act as springs pulling
// connected nodes together, namespaces act as soft attractors for their
// members, and a weak center gravity keeps the graph from drifting. We run
// the simulation on the main thread with a capped alpha cooling schedule.
// For graphs up to ~400 nodes this feels responsive on a Mac.

type Sim = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  id: string;
  kind: MapNode["kind"];
  namespace: string | null;
  fixed: boolean;
};

const KIND_PALETTE: Record<MapNode["kind"], string> = {
  namespace: "rgba(178, 182, 189, 0.18)",
  deployment: "#60a5fa",
  statefulset: "#a78bfa",
  daemonset: "#f472b6",
  cronjob: "#fbbf24",
  job: "#fb923c",
  pod: "#10b981",
  service: "#ffcf25",
  ingress: "#ef4444",
  configmap: "#94a3b8",
  secret: "#d946ef",
  persistent_volume_claim: "#22d3ee",
  node: "#818cf8",
  hpa: "#facc15",
};

const KIND_RADIUS: Record<MapNode["kind"], number> = {
  namespace: 36,
  deployment: 14,
  statefulset: 14,
  daemonset: 14,
  cronjob: 11,
  job: 10,
  pod: 7,
  service: 11,
  ingress: 12,
  configmap: 8,
  secret: 8,
  persistent_volume_claim: 9,
  node: 16,
  hpa: 10,
};

const EDGE_COLOR: Record<MapEdge["kind"], string> = {
  selects: "#ffcf25",
  routes: "#ef4444",
  owned_by: "rgba(178, 182, 189, 0.22)",
  mounts: "#22d3ee",
  scales: "#facc15",
  scheduled_on: "#818cf8",
};

const HEALTH_RING: Record<Health, string> = {
  healthy: "#10b981",
  degraded: "#f59e0b",
  failed: "#ef4444",
  unknown: "rgba(178, 182, 189, 0.4)",
};

function heatColor(heat: number): string {
  // 0 green → 50 amber → 100 red
  if (heat <= 0) return "transparent";
  if (heat < 33) return "rgba(16,185,129,0.45)";
  if (heat < 66) return "rgba(245,158,11,0.55)";
  return "rgba(239,68,68,0.7)";
}

function kindIcon(k: MapNode["kind"]) {
  switch (k) {
    case "namespace":
      return <Layers className="size-3.5" />;
    case "deployment":
    case "statefulset":
    case "daemonset":
      return <Boxes className="size-3.5" />;
    case "service":
      return <Target className="size-3.5" />;
    case "ingress":
      return <Globe className="size-3.5" />;
    case "configmap":
    case "secret":
      return <Lock className="size-3.5" />;
    case "hpa":
      return <Zap className="size-3.5" />;
    case "pod":
      return <Boxes className="size-3.5" />;
    case "node":
      return <Server className="size-3.5" />;
    case "persistent_volume_claim":
      return <Database className="size-3.5" />;
    default:
      return <Boxes className="size-3.5" />;
  }
}

const KIND_FILTER_OPTIONS: { value: MapNode["kind"]; label: string }[] = [
  { value: "deployment", label: "deployments" },
  { value: "statefulset", label: "statefulsets" },
  { value: "daemonset", label: "daemonsets" },
  { value: "cronjob", label: "cronjobs" },
  { value: "pod", label: "pods" },
  { value: "service", label: "services" },
  { value: "ingress", label: "ingresses" },
  { value: "hpa", label: "hpas" },
  { value: "configmap", label: "configmaps" },
  { value: "secret", label: "secrets" },
];

function useSimulation(
  map: CM | undefined,
  kindFilter: Set<MapNode["kind"]>,
  namespaceFilter: string | null,
  search: string,
  running: boolean,
  width: number,
  height: number,
) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const simRef = useRef<Map<string, Sim> | null>(null);
  const rafRef = useRef<number | null>(null);
  const alphaRef = useRef(1);

  const filtered = useMemo(() => {
    if (!map) return { nodes: [] as MapNode[], edges: [] as MapEdge[] };
    const term = search.trim().toLowerCase();
    const matches = (n: MapNode) =>
      (n.kind === "namespace" || kindFilter.size === 0 || kindFilter.has(n.kind)) &&
      (!namespaceFilter || n.namespace === namespaceFilter || n.name === namespaceFilter) &&
      (!term ||
        n.name.toLowerCase().includes(term) ||
        (n.namespace ?? "").toLowerCase().includes(term));
    const nodes = map.nodes.filter(matches);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = map.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    return { nodes, edges };
  }, [map, kindFilter, namespaceFilter, search]);

  // Reseed simulation when filtered node set changes.
  useEffect(() => {
    if (!filtered.nodes.length) {
      simRef.current = null;
      setPositions({});
      return;
    }
    const prev = simRef.current;
    const m = new Map<string, Sim>();
    const nsCount = filtered.nodes.filter((n) => n.kind === "namespace").length;
    const nsIndex = new Map<string, number>();
    let ni = 0;
    for (const n of filtered.nodes) {
      if (n.kind === "namespace") {
        nsIndex.set(n.name, ni++);
      }
    }
    filtered.nodes.forEach((n, i) => {
      const carry = prev?.get(n.id);
      let x: number;
      let y: number;
      if (carry) {
        x = carry.x;
        y = carry.y;
      } else if (n.kind === "namespace") {
        const idx = nsIndex.get(n.name) ?? 0;
        const angle = (idx / Math.max(1, nsCount)) * Math.PI * 2;
        const r = Math.min(width, height) * 0.28;
        x = width / 2 + Math.cos(angle) * r;
        y = height / 2 + Math.sin(angle) * r;
      } else {
        // Seed near namespace center if known.
        const nsIdx = n.namespace ? nsIndex.get(n.namespace) : undefined;
        if (nsIdx !== undefined) {
          const angle = (nsIdx / Math.max(1, nsCount)) * Math.PI * 2;
          const r = Math.min(width, height) * 0.28;
          const cx = width / 2 + Math.cos(angle) * r;
          const cy = height / 2 + Math.sin(angle) * r;
          x = cx + (Math.random() - 0.5) * 120;
          y = cy + (Math.random() - 0.5) * 120;
        } else {
          const a = (i / filtered.nodes.length) * Math.PI * 2;
          x = width / 2 + Math.cos(a) * Math.min(width, height) * 0.35;
          y = height / 2 + Math.sin(a) * Math.min(width, height) * 0.35;
        }
      }
      m.set(n.id, {
        id: n.id,
        x,
        y,
        vx: 0,
        vy: 0,
        kind: n.kind,
        namespace: n.namespace,
        fixed: false,
      });
    });
    simRef.current = m;
    alphaRef.current = 1;
  }, [filtered.nodes, width, height]);

  // Animation loop.
  useEffect(() => {
    if (!running || !simRef.current) return;
    const edgesByNode = new Map<string, string[]>();
    for (const e of filtered.edges) {
      if (!edgesByNode.has(e.from)) edgesByNode.set(e.from, []);
      if (!edgesByNode.has(e.to)) edgesByNode.set(e.to, []);
      edgesByNode.get(e.from)!.push(e.to);
      edgesByNode.get(e.to)!.push(e.from);
    }
    const nsMap = new Map<string, Sim>();
    for (const s of simRef.current.values()) {
      if (s.kind === "namespace") nsMap.set(s.id.replace("ns/", ""), s);
    }

    let frameCounter = 0;
    const step = () => {
      const sim = simRef.current;
      if (!sim) return;
      const alpha = alphaRef.current;
      if (alpha < 0.02) {
        rafRef.current = null;
        return;
      }
      const nodes = Array.from(sim.values());

      // Repulsion via spatial hash grid: avoids the O(n²) inner loop that
      // used to stutter at >150 nodes. Each node only repels against
      // neighbours in its 3×3 cell window. Cell size ~150px loosely matches
      // the spring rest length for `owned_by` (70) + node radius padding,
      // so most real edges fall within one cell window.
      const CELL = 150;
      const grid = new Map<string, Sim[]>();
      for (const n of nodes) {
        const key = `${Math.floor(n.x / CELL)},${Math.floor(n.y / CELL)}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(n);
        else grid.set(key, [n]);
      }
      for (const n of nodes) {
        const cx = Math.floor(n.x / CELL);
        const cy = Math.floor(n.y / CELL);
        for (let dxg = -1; dxg <= 1; dxg++) {
          for (let dyg = -1; dyg <= 1; dyg++) {
            const bucket = grid.get(`${cx + dxg},${cy + dyg}`);
            if (!bucket) continue;
            for (const o of bucket) {
              if (o === n) continue;
              const dx = n.x - o.x;
              const dy = n.y - o.y;
              let d2 = dx * dx + dy * dy;
              if (d2 < 1) d2 = 1;
              if (d2 > CELL * CELL * 4) continue;
              const d = Math.sqrt(d2);
              const force = 1400 / d2;
              n.vx += (dx / d) * force;
              n.vy += (dy / d) * force;
            }
          }
        }
      }

      // Spring attraction along edges.
      for (const e of filtered.edges) {
        const a = sim.get(e.from);
        const b = sim.get(e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const target = e.kind === "owned_by" ? 70 : 110;
        const k = 0.02;
        const f = ((d - target) / d) * k;
        const fx = dx * f;
        const fy = dy * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }

      // Namespace gravity: pull members toward their ns node.
      for (const n of nodes) {
        if (!n.namespace) continue;
        const ns = nsMap.get(n.namespace);
        if (!ns) continue;
        const dx = ns.x - n.x;
        const dy = ns.y - n.y;
        n.vx += dx * 0.003;
        n.vy += dy * 0.003;
      }

      // Weak center gravity.
      const cx = width / 2;
      const cy = height / 2;
      for (const n of nodes) {
        n.vx += (cx - n.x) * 0.0008;
        n.vy += (cy - n.y) * 0.0008;
      }

      // Integrate with damping. Render only every 2nd frame — sim still
      // ticks at 60fps internally, but React only re-flows the SVG at 30fps,
      // halving the DOM update cost for big graphs without visible jitter.
      for (const n of nodes) {
        if (n.fixed) continue;
        n.vx *= 0.78;
        n.vy *= 0.78;
        n.x += n.vx * alpha;
        n.y += n.vy * alpha;
      }
      frameCounter++;
      if (frameCounter % 2 === 0) {
        const out: Record<string, { x: number; y: number }> = {};
        for (const n of nodes) out[n.id] = { x: n.x, y: n.y };
        setPositions(out);
      }
      alphaRef.current *= 0.985;
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [filtered.edges, running, width, height]);

  // Pinning (used by drag handler).
  const pin = (id: string, x: number, y: number) => {
    const s = simRef.current?.get(id);
    if (!s) return;
    s.x = x;
    s.y = y;
    s.vx = 0;
    s.vy = 0;
    s.fixed = true;
    alphaRef.current = Math.max(alphaRef.current, 0.4);
  };
  const unpin = (id: string) => {
    const s = simRef.current?.get(id);
    if (s) s.fixed = false;
  };

  return { filtered, positions, pin, unpin, reheat: () => (alphaRef.current = 1) };
}

type Viewport = { x: number; y: number; scale: number };

export function CloudMap() {
  const { ctx = "" } = useParams();
  const context = decodeURIComponent(ctx);
  const [kindFilter, setKindFilter] = useState<Set<MapNode["kind"]>>(new Set());
  const [namespaceFilter, setNamespaceFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState(true);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [selected, setSelected] = useState<MapNode | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });

  const cloudmapKey = ["k8s", "cloudmap", context, namespaceFilter];
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: cloudmapKey,
    queryFn: () =>
      k8s.cloudMap(context || undefined, namespaceFilter ?? undefined),
    staleTime: 10_000,
    // Long fallback poll for things the watch can't catch (network drops,
    // metrics-server-only changes); the workload watch handles the common case.
    refetchInterval: 60_000,
  });
  useK8sWatch({
    queryKeys: [cloudmapKey],
    command: "watch_workloads",
    args: {
      namespace: namespaceFilter ?? undefined,
      context: context || undefined,
    },
  });

  const { filtered, positions, pin, unpin, reheat } = useSimulation(
    data,
    kindFilter,
    namespaceFilter,
    search,
    running,
    size.w,
    size.h,
  );

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSize({
          w: Math.max(400, entry.contentRect.width),
          h: Math.max(400, entry.contentRect.height),
        });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Pan / zoom handlers.
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest("[data-node]")) return;
    panRef.current = { x: e.clientX, y: e.clientY };
  };
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!panRef.current) return;
    const dx = e.clientX - panRef.current.x;
    const dy = e.clientY - panRef.current.y;
    panRef.current = { x: e.clientX, y: e.clientY };
    setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onMouseUp = () => {
    panRef.current = null;
  };
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setViewport((v) => {
      const scale = Math.min(3, Math.max(0.25, v.scale * factor));
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { ...v, scale };
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Keep the point under the cursor stable.
      const wx = (cx - v.x) / v.scale;
      const wy = (cy - v.y) / v.scale;
      return { scale, x: cx - wx * scale, y: cy - wy * scale };
    });
  };

  // Drag individual nodes.
  const dragRef = useRef<string | null>(null);
  const nodeDown = (id: string) => {
    dragRef.current = id;
  };
  const nodeMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left - viewport.x) / viewport.scale;
    const y = (e.clientY - rect.top - viewport.y) / viewport.scale;
    pin(dragRef.current, x, y);
  };
  const nodeUp = () => {
    if (dragRef.current) {
      // Leave it pinned where the user dropped it. They can reheat to unpin all.
      dragRef.current = null;
    }
  };

  const onReheat = () => {
    for (const n of filtered.nodes) unpin(n.id);
    reheat();
    setRunning(true);
  };

  const namespaces = useMemo(() => {
    if (!data) return [] as string[];
    return Array.from(new Set(data.nodes.filter((n) => n.kind === "namespace").map((n) => n.name))).sort();
  }, [data]);

  // World-space viewport bounds with a generous margin so panning doesn't
  // immediately cull, and so just-offscreen edges still draw an edge into the
  // visible region. The SVG transform is `translate(viewport.x viewport.y)
  // scale(viewport.scale)`, so screen point (sx, sy) ↔ world (sx - vx) / scale.
  const cullMargin = Math.max(size.w, size.h) / Math.max(viewport.scale, 0.25);
  const wx0 = -viewport.x / viewport.scale - cullMargin;
  const wy0 = -viewport.y / viewport.scale - cullMargin;
  const wx1 = (size.w - viewport.x) / viewport.scale + cullMargin;
  const wy1 = (size.h - viewport.y) / viewport.scale + cullMargin;
  const isVisible = (id: string): boolean => {
    const p = positions[id];
    if (!p) return false;
    return p.x >= wx0 && p.x <= wx1 && p.y >= wy0 && p.y <= wy1;
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 px-4 h-12 border-b border-term-border-soft bg-term-panel">
          <div className="flex items-center gap-2 mr-2">
            <h2 className="mds-heading text-[15px] text-term-fg truncate max-w-[320px]">{context}</h2>
            <span className="text-[11px] text-term-subtle">
              {filtered.nodes.length} nodes · {filtered.edges.length} edges
            </span>
          </div>
          <div className="flex items-center gap-1 h-8 px-2 rounded-md bg-term-bg border border-term-border-soft flex-1 max-w-xs">
            <Search className="size-3.5 text-term-subtle" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filter by name..."
              className="flex-1 bg-transparent outline-none text-[12px] text-term-fg placeholder:text-term-subtle"
            />
          </div>
          <select
            value={namespaceFilter ?? ""}
            onChange={(e) => setNamespaceFilter(e.target.value || null)}
            className="h-8 px-2 text-[12px] rounded-md bg-term-bg border border-term-border-soft text-term-fg"
          >
            <option value="">all namespaces</option>
            {namespaces.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          <button
            onClick={() => setRunning((r) => !r)}
            className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
            title={running ? "pause layout" : "resume layout"}
          >
            {running ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </button>
          <button
            onClick={onReheat}
            className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
            title="re-run layout"
          >
            <Repeat className="size-3.5" />
          </button>
          <button
            onClick={() => refetch()}
            className="term-btn !min-h-[32px] !py-1.5 !px-3 !text-[12px]"
            disabled={isFetching}
          >
            <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
          </button>
        </div>

        <KindLegend filter={kindFilter} onToggle={(k) => {
          const next = new Set(kindFilter);
          if (next.has(k)) next.delete(k);
          else next.add(k);
          setKindFilter(next);
        }} />

        <div className="relative flex-1 overflow-hidden bg-[radial-gradient(ellipse_at_center,_var(--term-panel)_0%,_var(--term-bg)_100%)]">
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center text-[13px] text-term-muted">
              <RefreshCw className="size-4 mr-2 animate-spin" />
              building cluster map...
            </div>
          ) : (
            <svg
              ref={svgRef}
              className="w-full h-full cursor-grab active:cursor-grabbing"
              onMouseDown={onMouseDown}
              onMouseMove={(e) => {
                onMouseMove(e);
                nodeMove(e);
              }}
              onMouseUp={() => {
                onMouseUp();
                nodeUp();
              }}
              onMouseLeave={() => {
                onMouseUp();
                nodeUp();
              }}
              onWheel={onWheel}
            >
              <defs>
                {Object.entries(EDGE_COLOR).map(([k, color]) => (
                  <marker
                    key={k}
                    id={`arrow-${k}`}
                    markerWidth="6"
                    markerHeight="6"
                    refX="6"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L6,3 L0,6 z" fill={color} opacity="0.8" />
                  </marker>
                ))}
              </defs>
              <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
                {/* Namespace halos behind everything */}
                {filtered.nodes
                  .filter((n) => n.kind === "namespace")
                  .map((n) => {
                    const p = positions[n.id];
                    if (!p) return null;
                    return (
                      <g key={n.id}>
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={130}
                          fill="var(--term-panel-2)"
                          opacity="0.35"
                        />
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={130}
                          fill="none"
                          stroke="rgba(255,207,37,0.18)"
                          strokeDasharray="4 4"
                        />
                        <text
                          x={p.x}
                          y={p.y - 140}
                          textAnchor="middle"
                          className="fill-term-muted"
                          fontSize="11"
                          fontFamily="Avenir Next, sans-serif"
                        >
                          ns · {n.name}
                        </text>
                      </g>
                    );
                  })}

                {/* Edges */}
                {filtered.edges.map((e, i) => {
                  const a = positions[e.from];
                  const b = positions[e.to];
                  if (!a || !b) return null;
                  if (!isVisible(e.from) && !isVisible(e.to)) return null;
                  return (
                    <line
                      key={i}
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={EDGE_COLOR[e.kind]}
                      strokeOpacity={e.kind === "owned_by" ? 0.35 : 0.7}
                      strokeWidth={e.kind === "selects" || e.kind === "routes" ? 1.4 : 1}
                      markerEnd={`url(#arrow-${e.kind})`}
                    />
                  );
                })}

                {/* Nodes */}
                {filtered.nodes
                  .filter((n) => n.kind !== "namespace" && isVisible(n.id))
                  .map((n) => {
                    const p = positions[n.id];
                    if (!p) return null;
                    const r = KIND_RADIUS[n.kind];
                    const isSel = selected?.id === n.id;
                    return (
                      <g
                        key={n.id}
                        data-node="1"
                        transform={`translate(${p.x} ${p.y})`}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          nodeDown(n.id);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(n);
                        }}
                        style={{ cursor: "pointer" }}
                      >
                        {n.heat > 0 && (
                          <circle r={r + 6} fill={heatColor(n.heat)} />
                        )}
                        <circle
                          r={r}
                          fill={KIND_PALETTE[n.kind]}
                          stroke={HEALTH_RING[n.health]}
                          strokeWidth={isSel ? 3 : 2}
                          opacity={0.92}
                        />
                        {isSel && (
                          <circle
                            r={r + 4}
                            fill="none"
                            stroke="#ffcf25"
                            strokeWidth="2"
                            strokeDasharray="2 3"
                          />
                        )}
                        <text
                          y={r + 12}
                          textAnchor="middle"
                          fontSize="10"
                          fontFamily="JetBrains Mono, monospace"
                          className="fill-term-fg select-none pointer-events-none"
                        >
                          {n.name.length > 22 ? `${n.name.slice(0, 21)}…` : n.name}
                        </text>
                      </g>
                    );
                  })}
              </g>
            </svg>
          )}
          <div className="absolute left-3 bottom-3 px-2 py-1 rounded bg-term-panel/80 backdrop-blur text-[10px] text-term-subtle pointer-events-none">
            scroll to zoom · drag to pan · click node to inspect
          </div>
        </div>
      </div>

      {selected && (
        <InspectorPanel
          context={context}
          node={selected}
          edges={data?.edges ?? []}
          nodes={data?.nodes ?? []}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function KindLegend({
  filter,
  onToggle,
}: {
  filter: Set<MapNode["kind"]>;
  onToggle: (k: MapNode["kind"]) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 px-4 py-2 border-b border-term-border-soft bg-term-panel/50">
      <span className="text-[10px] uppercase tracking-wider text-term-subtle mr-2">kinds:</span>
      {KIND_FILTER_OPTIONS.map((k) => {
        const active = filter.size === 0 || filter.has(k.value);
        return (
          <button
            key={k.value}
            onClick={() => onToggle(k.value)}
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border transition-colors",
              active
                ? "border-term-border-soft text-term-fg hover:bg-term-panel-2"
                : "border-transparent text-term-subtle line-through",
            )}
          >
            <span
              className="size-2 rounded-full"
              style={{ background: KIND_PALETTE[k.value] }}
            />
            {k.label}
          </button>
        );
      })}
    </div>
  );
}

const LOG_KINDS: MapNode["kind"][] = [
  "pod",
  "deployment",
  "statefulset",
  "daemonset",
];
// Which kinds support inspection via `get_resource` (our YAML fetcher).
// ConfigMap/Secret/PVC/Ingress etc. aren't surfaced in CloudMap yet for
// actions, so we scope this to what the inspector actually shows.
const YAML_KINDS: MapNode["kind"][] = [
  "deployment",
  "statefulset",
  "daemonset",
  "cronjob",
  "job",
  "pod",
  "service",
  "ingress",
  "configmap",
];
const EVENTS_KINDS: MapNode["kind"][] = [
  "deployment",
  "statefulset",
  "daemonset",
  "cronjob",
  "job",
  "pod",
  "service",
  "ingress",
];
const RESTART_KINDS: MapNode["kind"][] = [
  "deployment",
  "statefulset",
  "daemonset",
];
const SCALE_KINDS: MapNode["kind"][] = ["deployment", "statefulset"];
const FORWARD_KINDS: MapNode["kind"][] = ["pod", "service"];

/** Bridge MapNode kinds to the WorkloadKind backend enum when the two
 * overlap (everything except namespace / node / pvc / secret / hpa). */
function toWorkloadKind(k: MapNode["kind"]): WorkloadKind | null {
  switch (k) {
    case "deployment":
    case "statefulset":
    case "daemonset":
    case "cronjob":
    case "job":
    case "pod":
    case "service":
    case "ingress":
    case "configmap":
      return k;
    default:
      return null;
  }
}

type PendingAction =
  | { kind: "restart" }
  | { kind: "scale"; replicas: number }
  | { kind: "delete-pod" };

function InspectorPanel({
  context,
  node,
  edges,
  nodes,
  onClose,
}: {
  context: string;
  node: MapNode;
  edges: MapEdge[];
  nodes: MapNode[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const byId = useMemo(() => {
    const m = new Map<string, MapNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);
  const incoming = edges.filter((e) => e.to === node.id);
  const outgoing = edges.filter((e) => e.from === node.id);

  const canLogs = LOG_KINDS.includes(node.kind) && !!node.namespace;
  const canYaml = YAML_KINDS.includes(node.kind) && !!node.namespace;
  const canEvents = EVENTS_KINDS.includes(node.kind) && !!node.namespace;
  const canRestart = RESTART_KINDS.includes(node.kind) && !!node.namespace;
  const canScale =
    SCALE_KINDS.includes(node.kind) &&
    !!node.namespace &&
    typeof node.replicas === "number";
  const canDelete = node.kind === "pod" && !!node.namespace;
  const canForward = FORWARD_KINDS.includes(node.kind) && !!node.namespace;
  const canAttach = node.kind === "pod" && !!node.namespace;
  const canAsk = true;
  const workloadKind = toWorkloadKind(node.kind);

  // Modal + confirm state.
  const [showYaml, setShowYaml] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const { openSession } = useShellDock();
  const [actionBusy, setActionBusy] = useState(false);

  // Recent-resources MRU list, keyed by cluster context. Push happens on
  // user-initiated YAML opens (not every render) so the list reflects what
  // the user actually inspected.
  const recent = useRecentResources(context);

  const openYaml = () => {
    recent.push({
      kind: node.kind,
      namespace: node.namespace ?? null,
      name: node.name,
    });
    setShowYaml(true);
  };

  // Parse hinted ports from the extra map we pack in CloudMap's builder.
  // Pods don't carry explicit port info here; services stash a comma list.
  const suggestedPorts = useMemo(() => {
    const raw = node.extra["ports"];
    if (!raw) return undefined;
    const parsed = raw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 65536);
    return parsed.length ? parsed : undefined;
  }, [node.extra]);

  const yamlQuery = useQuery({
    queryKey: [
      "k8s",
      "yaml",
      context,
      node.namespace,
      node.kind,
      node.name,
    ],
    queryFn: () =>
      k8s.getResource(
        node.namespace ?? "",
        workloadKind!,
        node.name,
        context || undefined,
      ),
    enabled: showYaml && !!workloadKind,
  });

  const openLogs = () => {
    if (!canLogs) return;
    const params = new URLSearchParams({
      ns: node.namespace ?? "",
      kind: node.kind,
      name: node.name,
    });
    navigate(`/cluster/${encodeURIComponent(context)}/logs?${params.toString()}`);
  };

  const askLumen = () => {
    navigate(aiResourceUrl(context, {
      kind: node.kind,
      namespace: node.namespace,
      name: node.name,
    }));
  };

  const runPending = async () => {
    if (!pending || !workloadKind || !node.namespace) return;
    setActionBusy(true);
    try {
      if (pending.kind === "restart") {
        await k8s.restartWorkload(
          node.namespace,
          workloadKind,
          node.name,
          context || undefined,
        );
        toast.success(`restart triggered for ${node.name}`);
      } else if (pending.kind === "scale") {
        await k8s.scaleWorkload(
          node.namespace,
          workloadKind,
          node.name,
          pending.replicas,
          context || undefined,
        );
        toast.success(`scaled ${node.name} to ${pending.replicas}`);
      } else if (pending.kind === "delete-pod") {
        await k8s.deletePod(node.namespace, node.name, context || undefined);
        toast.success(`pod ${node.name} deleted — controller will recreate`);
      }
      qc.invalidateQueries({ queryKey: ["k8s", "cloudmap", context] });
      qc.invalidateQueries({ queryKey: ["k8s", "workloads"] });
      setPending(null);
    } catch (e) {
      toast.error(`action failed: ${(e as Error).message ?? e}`);
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <aside className="w-[340px] border-l border-term-border-soft bg-term-panel overflow-y-auto flex flex-col">
      <div className="flex items-center justify-between px-4 h-12 border-b border-term-border-soft shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ color: KIND_PALETTE[node.kind] }}>{kindIcon(node.kind)}</span>
          <span className="text-[13px] font-semibold text-term-fg truncate">{node.name}</span>
        </div>
        <button onClick={onClose} className="text-term-subtle hover:text-term-fg">
          <X className="size-4" />
        </button>
      </div>
      {(canAsk ||
        canLogs ||
        canYaml ||
        canEvents ||
        canRestart ||
        canScale ||
        canDelete ||
        canForward ||
        canAttach) && (
        <div className="px-3 py-2 border-b border-term-border-soft space-y-1.5">
          <button
            onClick={askLumen}
            className="w-full term-btn term-btn-primary !min-h-[30px] !text-[12px] justify-center"
          >
            <Sparkles className="size-3.5" /> ask Lumen
          </button>
          {canLogs && (
            <button
              onClick={openLogs}
              className="w-full term-btn !min-h-[30px] !text-[12px] justify-center"
            >
              <Terminal className="size-3.5" /> view logs
            </button>
          )}
          <div className="grid grid-cols-2 gap-1.5">
            {canYaml && (
              <button
                onClick={openYaml}
                className="term-btn !min-h-[28px] !text-[11px] justify-center"
              >
                <FileCode className="size-3" /> yaml
              </button>
            )}
            {canEvents && (
              <button
                onClick={() => setShowEvents(true)}
                className="term-btn !min-h-[28px] !text-[11px] justify-center"
              >
                <ScrollText className="size-3" /> events
              </button>
            )}
            {canRestart && (
              <button
                onClick={() => setPending({ kind: "restart" })}
                className="term-btn !min-h-[28px] !text-[11px] justify-center"
                title="rolling restart (kubectl rollout restart)"
              >
                <RotateCw className="size-3" /> restart
              </button>
            )}
            {canForward && (
              <button
                onClick={() => setShowForward(true)}
                className="term-btn !min-h-[28px] !text-[11px] justify-center"
                title="port-forward to localhost"
              >
                <Radio className="size-3" /> forward
              </button>
            )}
            {canAttach && (
              <button
                onClick={() => {
                  if (!node.namespace) return;
                  openSession({
                    pod: node.name,
                    namespace: node.namespace,
                    context,
                    container: "",
                    command: ["/bin/sh"],
                  });
                }}
                className="term-btn !min-h-[28px] !text-[11px] justify-center"
                title="attach an interactive shell"
              >
                <TerminalSquare className="size-3" /> shell
              </button>
            )}
            {canScale && (
              <ScaleControl
                current={node.replicas ?? 0}
                onPick={(n) => setPending({ kind: "scale", replicas: n })}
              />
            )}
            {canDelete && (
              <button
                onClick={() => setPending({ kind: "delete-pod" })}
                className="term-btn !min-h-[28px] !text-[11px] justify-center !text-term-red !border-term-red/40 col-span-2"
              >
                <Trash2 className="size-3" /> delete pod
              </button>
            )}
          </div>
        </div>
      )}

      {showYaml && (
        <YamlModal
          title={`${node.kind}/${node.name}`}
          subtitle={node.namespace ?? undefined}
          yaml={yamlQuery.data?.yaml}
          loading={yamlQuery.isLoading}
          error={yamlQuery.error ? (yamlQuery.error as Error).message : null}
          sensitive={node.kind === "secret"}
          onClose={() => setShowYaml(false)}
          pinSlot={
            <PinButton
              ctx={context}
              resource={{
                kind: node.kind,
                namespace: node.namespace ?? null,
                name: node.name,
              }}
            />
          }
          editable={
            workloadKind && node.namespace && node.kind !== "secret"
              ? {
                  namespace: node.namespace,
                  kind: workloadKind,
                  name: node.name,
                  context: context || undefined,
                  onApplied: () => {
                    qc.invalidateQueries({ queryKey: ["k8s", "cloudmap", context] });
                    qc.invalidateQueries({ queryKey: ["k8s", "yaml", context] });
                  },
                }
              : undefined
          }
        />
      )}

      {showEvents && workloadKind && node.namespace && (
        <EventsModal
          context={context}
          namespace={node.namespace}
          kind={workloadKind}
          name={node.name}
          onClose={() => setShowEvents(false)}
        />
      )}

      {showForward && node.namespace && (
        <PortForwardDialog
          context={context}
          namespace={node.namespace}
          targetKind={node.kind === "service" ? "service" : "pod"}
          targetName={node.name}
          suggestedPorts={suggestedPorts}
          onClose={() => setShowForward(false)}
          onStarted={() =>
            qc.invalidateQueries({ queryKey: ["k8s", "forwards"] })
          }
        />
      )}

      {pending && (
        <ConfirmAction
          node={node}
          pending={pending}
          busy={actionBusy}
          onCancel={() => setPending(null)}
          onConfirm={runPending}
        />
      )}
      <div className="px-4 py-3 border-b border-term-border-soft space-y-1.5 text-[12px]">
        <Kv label="kind" value={node.kind} />
        {node.namespace && <Kv label="namespace" value={node.namespace} />}
        <Kv
          label="health"
          value={
            <span
              className="inline-flex items-center gap-1.5"
              style={{ color: HEALTH_RING[node.health] }}
            >
              <span
                className="size-2 rounded-full"
                style={{ background: HEALTH_RING[node.health] }}
              />
              {node.health}
            </span>
          }
        />
        {node.ready && <Kv label="ready" value={node.ready} />}
        {typeof node.replicas === "number" && <Kv label="replicas" value={node.replicas} />}
        {node.heat > 0 && (
          <Kv
            label="heat"
            value={
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="size-2 rounded-full"
                  style={{ background: heatColor(node.heat) }}
                />
                {Math.round(node.heat)}%
              </span>
            }
          />
        )}
        {Object.entries(node.extra).map(([k, v]) => (
          <Kv key={k} label={k} value={v} />
        ))}
      </div>
      {Object.keys(node.labels).length > 0 && (
        <div className="px-4 py-3 border-b border-term-border-soft">
          <h4 className="text-[10px] uppercase tracking-wider text-term-subtle mb-1.5">labels</h4>
          <div className="flex flex-wrap gap-1">
            {Object.entries(node.labels).map(([k, v]) => (
              <span
                key={k}
                className="px-1.5 py-0.5 text-[10px] rounded bg-term-bg border border-term-border-soft text-term-muted font-mono"
              >
                {k}={v}
              </span>
            ))}
          </div>
        </div>
      )}
      <ConnSection
        title="incoming"
        icon={<LinkIcon className="size-3 rotate-180" />}
        edges={incoming}
        resolve={(id) => byId.get(id)}
        endpointOf={(e) => e.from}
      />
      <ConnSection
        title="outgoing"
        icon={<LinkIcon className="size-3" />}
        edges={outgoing}
        resolve={(id) => byId.get(id)}
        endpointOf={(e) => e.to}
      />
      <div className="px-4 py-3 mt-auto border-t border-term-border-soft text-[11px] text-term-subtle">
        <span>
          <Eye className="size-3 inline mr-1" />
          drag to pin · click empty space to close
        </span>
      </div>
    </aside>
  );
}

function Kv({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-term-subtle w-20 shrink-0 text-[11px] uppercase tracking-wider">
        {label}
      </span>
      <span className="text-term-fg break-all">{value}</span>
    </div>
  );
}

function ConnSection({
  title,
  icon,
  edges,
  resolve,
  endpointOf,
}: {
  title: string;
  icon: React.ReactNode;
  edges: MapEdge[];
  resolve: (id: string) => MapNode | undefined;
  endpointOf: (e: MapEdge) => string;
}) {
  if (edges.length === 0) return null;
  return (
    <div className="px-4 py-3 border-b border-term-border-soft">
      <h4 className="text-[10px] uppercase tracking-wider text-term-subtle mb-1.5 flex items-center gap-1">
        {icon}
        {title} ({edges.length})
      </h4>
      <ul className="space-y-1">
        {edges.map((e, i) => {
          const t = resolve(endpointOf(e));
          return (
            <li key={i} className="flex items-center gap-2 text-[11px]">
              <span className="text-term-subtle" style={{ color: EDGE_COLOR[e.kind] }}>
                {e.kind}
              </span>
              <span className="text-term-fg truncate" title={t?.name ?? endpointOf(e)}>
                {t?.name ?? endpointOf(e)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScaleControl({
  current,
  onPick,
}: {
  current: number;
  onPick: (n: number) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-term-border-soft overflow-hidden h-[28px] text-[11px]">
      <button
        onClick={() => onPick(Math.max(0, current - 1))}
        disabled={current <= 0}
        className="px-2 text-term-muted hover:text-term-fg hover:bg-term-panel-2 disabled:opacity-30 disabled:cursor-not-allowed"
        title="scale down"
      >
        −
      </button>
      <span className="px-2 text-term-fg tabular-nums border-x border-term-border-soft inline-flex items-center gap-1">
        <Scaling className="size-3 text-term-subtle" />
        {current}
      </span>
      <button
        onClick={() => onPick(current + 1)}
        className="px-2 text-term-muted hover:text-term-fg hover:bg-term-panel-2"
        title="scale up"
      >
        +
      </button>
    </div>
  );
}

function ConfirmAction({
  node,
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  node: MapNode;
  pending: PendingAction;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title =
    pending.kind === "restart"
      ? "rolling restart"
      : pending.kind === "scale"
        ? `scale to ${pending.replicas}`
        : "delete pod";
  const body =
    pending.kind === "restart"
      ? `Triggers a rolling restart of ${node.kind} '${node.name}' by stamping a timestamp annotation on the pod template. Pods will be replaced one at a time respecting the rollout strategy.`
      : pending.kind === "scale"
        ? `Sets replicas for ${node.kind} '${node.name}' from ${node.replicas ?? 0} to ${pending.replicas}. This takes effect immediately.`
        : `Deletes pod '${node.name}'. The owning controller will recreate it unless this is a bare pod — in which case the pod is gone for good.`;
  return (
    <ConfirmActionDialog
      open
      title={`${title} · ${node.name}`}
      description={body}
      target={`${node.namespace ?? "cluster"}/${node.name}`}
      confirmLabel={pending.kind === "delete-pod" ? "delete" : "confirm"}
      intent={pending.kind === "delete-pod" || pending.kind === "restart" ? "danger" : "warning"}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
