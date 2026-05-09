export type SmartDiffCategory =
  | "image"
  | "replicas"
  | "env"
  | "probe"
  | "resources"
  | "service"
  | "ingress"
  | "networkPolicy"
  | "rbac"
  | "metadata"
  | "other";

export type SmartDiffSeverity = "high" | "medium" | "low";

export type SmartDiffChange = {
  category: SmartDiffCategory;
  severity: SmartDiffSeverity;
  title: string;
  path: string;
  before: string | null;
  after: string | null;
};

export type SmartDiffSummary = {
  isNoOp: boolean;
  changes: SmartDiffChange[];
  byCategory: Partial<Record<SmartDiffCategory, number>>;
  ignoredCount: number;
};

const CATEGORY_ORDER: SmartDiffCategory[] = [
  "image",
  "replicas",
  "env",
  "probe",
  "resources",
  "service",
  "ingress",
  "networkPolicy",
  "rbac",
  "metadata",
  "other",
];

const NOISE_PATHS = [
  /^metadata\.annotations\.kubectl\.kubernetes\.io\/last-applied-configuration$/,
  /^metadata\.creationTimestamp$/,
  /^metadata\.generation$/,
  /^metadata\.managedFields/,
  /^metadata\.resourceVersion$/,
  /^metadata\.uid$/,
  /^status(\.|$)/,
];

type FlatMap = Record<string, string>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableString(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableString).join(", ")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${key}: ${stableString((value as Record<string, unknown>)[key])}`)
    .join(", ")}}`;
}

function pathForArrayItem(parent: string, value: unknown, index: number): string {
  if (isObject(value) && typeof value.name === "string" && value.name.trim()) {
    return `${parent}[${value.name}]`;
  }
  return `${parent}[${index}]`;
}

function flattenOperational(value: unknown, prefix = ""): FlatMap {
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? { [prefix]: "[]" } : {};
    return value.reduce<FlatMap>((acc, item, index) => {
      Object.assign(acc, flattenOperational(item, pathForArrayItem(prefix, item, index)));
      return acc;
    }, {});
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return prefix ? { [prefix]: "{}" } : {};
    return keys.reduce<FlatMap>((acc, key) => {
      const path = prefix ? `${prefix}.${key}` : key;
      Object.assign(acc, flattenOperational(value[key], path));
      return acc;
    }, {});
  }
  return prefix ? { [prefix]: stableString(value) } : {};
}

function isNoisePath(path: string): boolean {
  return NOISE_PATHS.some((pattern) => pattern.test(path));
}

function classifyPath(path: string): {
  category: SmartDiffCategory;
  severity: SmartDiffSeverity;
  title: string;
} {
  if (/\.image$/.test(path) && /containers?\[/.test(path)) {
    return { category: "image", severity: "high", title: "Container image changed" };
  }
  if (path === "spec.replicas") {
    return { category: "replicas", severity: "medium", title: "Replica count changed" };
  }
  if (/\.(env|envFrom)(\.|\[|$)|configMapRef|secretRef|valueFrom/.test(path)) {
    return { category: "env", severity: "high", title: "Environment or config reference changed" };
  }
  if (/(livenessProbe|readinessProbe|startupProbe)/.test(path)) {
    return { category: "probe", severity: "medium", title: "Health probe changed" };
  }
  if (/\.resources(\.|$)/.test(path)) {
    return { category: "resources", severity: "medium", title: "Container resources changed" };
  }
  if (/^spec\.(selector|ports)(\.|\[|$)/.test(path)) {
    return { category: "service", severity: "high", title: "Service routing changed" };
  }
  if (/^spec\.(rules|tls)(\.|\[|$)|host|http\.paths|pathType|backend/.test(path)) {
    return { category: "ingress", severity: "high", title: "Ingress route changed" };
  }
  if (/^spec\.(ingress|egress|podSelector|namespaceSelector|policyTypes)(\.|\[|$)|ipBlock/.test(path)) {
    return { category: "networkPolicy", severity: "high", title: "Network policy rule changed" };
  }
  if (/^(subjects|rules|roleRef)(\.|\[|$)/.test(path)) {
    return { category: "rbac", severity: "high", title: "RBAC access changed" };
  }
  if (/^metadata\.(labels|annotations)(\.|$)/.test(path)) {
    return { category: "metadata", severity: "low", title: "Metadata changed" };
  }
  return { category: "other", severity: "low", title: "Other spec changed" };
}

function categoryRank(category: SmartDiffCategory): number {
  return CATEGORY_ORDER.indexOf(category);
}

function logicalGroup(change: SmartDiffChange): string {
  if (change.category === "env") return "env";
  if (change.category === "probe") {
    const probe = change.path.match(/(livenessProbe|readinessProbe|startupProbe)/)?.[1] ?? "probe";
    return `probe:${probe}`;
  }
  if (change.category === "resources") return "resources";
  if (change.category === "service") {
    return change.path.startsWith("spec.selector") ? "service:selector" : "service:ports";
  }
  if (change.category === "ingress") return "ingress";
  if (change.category === "networkPolicy") return "networkPolicy";
  if (change.category === "rbac") {
    if (change.path.startsWith("subjects")) return "rbac:subjects";
    if (change.path.startsWith("rules")) return "rbac:rules";
    return "rbac:roleRef";
  }
  return change.path;
}

function compactChanges(changes: SmartDiffChange[]): SmartDiffChange[] {
  const groups = new Map<string, SmartDiffChange>();
  for (const change of changes) {
    const key = logicalGroup(change);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...change, path: key.includes(":") ? key.split(":")[1] : change.path });
      continue;
    }
    groups.set(key, {
      ...existing,
      before: [existing.before, change.before].filter(Boolean).join("; ") || null,
      after: [existing.after, change.after].filter(Boolean).join("; ") || null,
    });
  }
  return [...groups.values()];
}

export function summarizeSmartDiff(before: unknown, after: unknown): SmartDiffSummary {
  const a = flattenOperational(before);
  const b = flattenOperational(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  let ignoredCount = 0;
  const changes: SmartDiffChange[] = [];

  for (const path of keys) {
    const beforeValue = a[path];
    const afterValue = b[path];
    if (beforeValue === afterValue) continue;
    if (isNoisePath(path)) {
      ignoredCount += 1;
      continue;
    }
    const classified = classifyPath(path);
    changes.push({
      ...classified,
      path,
      before: beforeValue ?? null,
      after: afterValue ?? null,
    });
  }

  const compacted = compactChanges(changes);

  compacted.sort(
    (left, right) =>
      categoryRank(left.category) - categoryRank(right.category) ||
      left.path.localeCompare(right.path),
  );

  const byCategory = compacted.reduce<Partial<Record<SmartDiffCategory, number>>>(
    (acc, change) => {
      acc[change.category] = (acc[change.category] ?? 0) + 1;
      return acc;
    },
    {},
  );

  return {
    isNoOp: compacted.length === 0,
    changes: compacted,
    byCategory,
    ignoredCount,
  };
}

function extractYamlFacts(yaml: string): FlatMap {
  const facts: FlatMap = {};
  const lines = yaml.split(/\r?\n/);
  let containerName = "";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const replicas = line.match(/^replicas:\s*(.+)$/);
    if (replicas) facts["spec.replicas"] = replicas[1].trim();

    const namedContainer = line.match(/^-\s*name:\s*["']?([^"']+)["']?$/);
    if (namedContainer) {
      containerName = namedContainer[1].trim();
      continue;
    }
    const inlineContainer = line.match(/^name:\s*["']?([^"']+)["']?$/);
    if (inlineContainer && !containerName) containerName = inlineContainer[1].trim();

    const image = line.match(/^image:\s*["']?([^"']+)["']?$/);
    if (image) {
      const key = `spec.template.spec.containers[${containerName || "container"}].image`;
      facts[key] = image[1].trim();
    }

    const serviceSelector = line.match(/^selector:\s*(.+)$/);
    if (serviceSelector) facts["spec.selector"] = serviceSelector[1].trim();
    const port = line.match(/^port:\s*(.+)$/);
    if (port) facts[`spec.ports[${facts["spec.ports.count"] ?? "0"}].port`] = port[1].trim();
    const host = line.match(/^host:\s*(.+)$/);
    if (host) facts["spec.rules[0].host"] = host[1].trim();
    const path = line.match(/^path:\s*(.+)$/);
    if (path) facts["spec.rules[0].http.paths[0].path"] = path[1].trim();
  }

  delete facts["spec.ports.count"];
  return facts;
}

export function summarizeSmartYamlDiff(beforeYaml: string, afterYaml: string): SmartDiffSummary {
  return summarizeSmartDiff(extractYamlFacts(beforeYaml), extractYamlFacts(afterYaml));
}
