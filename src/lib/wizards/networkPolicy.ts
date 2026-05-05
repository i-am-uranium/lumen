/**
 * Pure helpers for the NetworkPolicy wizard (D12).
 *
 * Lives outside the route file so the YAML construction logic is unit-
 * testable without rendering. The shape mirrors networking.k8s.io/v1
 * NetworkPolicy; see
 * https://kubernetes.io/docs/concepts/services-networking/network-policies/
 *
 * Design choices:
 *
 * - We intentionally only support the most common subset of NetworkPolicy:
 *   pod label selectors, namespace label selectors (single label each), and
 *   ipBlock CIDRs. matchExpressions are out of scope for v1 — they're rare
 *   and the wizard doesn't have UX for them yet.
 *
 * - Empty selector arrays represent "deny all" for that direction (a
 *   policyType with no rules listed). This matches Kubernetes semantics
 *   exactly and is a common deny-by-default pattern.
 *
 * - The output is a JS object, not a YAML string. The route stringifies
 *   it via `js-yaml` for the preview and posts it to apply_resource which
 *   takes YAML; keeping the helper object-shaped makes the unit tests
 *   trivial (no whitespace fiddling).
 */

export type Label = { key: string; value: string };

export type WizardPort = {
  protocol: "TCP" | "UDP" | "SCTP";
  port: string; // numeric or named — kept as string for the form
};

export type WizardPeer = {
  podLabel?: Label;
  namespaceLabel?: Label;
  cidr?: string;
  except?: string[];
};

export type WizardRule = {
  peers: WizardPeer[];
  ports: WizardPort[];
};

export type WizardSpec = {
  name: string;
  namespace: string;
  // Empty matchLabels = applies to ALL pods in the namespace.
  podSelector: Label[];
  ingress: { enabled: boolean; rules: WizardRule[] };
  egress: { enabled: boolean; rules: WizardRule[] };
};

export type ManifestObject = Record<string, unknown>;

export function buildNetworkPolicyManifest(spec: WizardSpec): ManifestObject {
  const policyTypes: string[] = [];
  if (spec.ingress.enabled) policyTypes.push("Ingress");
  if (spec.egress.enabled) policyTypes.push("Egress");

  const podSelectorMatchLabels = labelsToObject(spec.podSelector);

  const manifest: ManifestObject = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: spec.name.trim(),
      namespace: spec.namespace.trim(),
    },
    spec: {
      podSelector:
        Object.keys(podSelectorMatchLabels).length > 0
          ? { matchLabels: podSelectorMatchLabels }
          : {},
      ...(policyTypes.length > 0 ? { policyTypes } : {}),
    },
  };

  // policyTypes that are "enabled but with no rules" express deny-by-default;
  // K8s requires the policyTypes entry plus an empty list. We always emit
  // the array explicitly when enabled to keep that semantic clear.
  if (spec.ingress.enabled) {
    (manifest.spec as Record<string, unknown>).ingress = spec.ingress.rules
      .map(serializeRule)
      .filter(Boolean);
  }
  if (spec.egress.enabled) {
    (manifest.spec as Record<string, unknown>).egress = spec.egress.rules
      .map(serializeRule)
      .filter(Boolean);
  }

  return manifest;
}

function serializeRule(rule: WizardRule): Record<string, unknown> | null {
  const peers = rule.peers.map(serializePeer).filter(Boolean) as Record<
    string,
    unknown
  >[];
  const ports = rule.ports
    .filter((p) => p.port.trim().length > 0)
    .map((p) => {
      const num = Number.parseInt(p.port, 10);
      return {
        protocol: p.protocol,
        port: Number.isFinite(num) && String(num) === p.port.trim() ? num : p.port.trim(),
      };
    });
  if (peers.length === 0 && ports.length === 0) {
    // An entirely empty rule means "allow all" for the direction —
    // express it as the empty object {} which K8s also accepts.
    return {};
  }
  const out: Record<string, unknown> = {};
  // The from / to key depends on direction; the route swaps it before
  // assembling the final manifest. We use a sentinel key here that the
  // caller will rename (cleaner than threading direction down).
  if (peers.length > 0) out._peers = peers;
  if (ports.length > 0) out.ports = ports;
  return out;
}

function serializePeer(peer: WizardPeer): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (peer.podLabel && peer.podLabel.key.trim()) {
    out.podSelector = {
      matchLabels: { [peer.podLabel.key.trim()]: peer.podLabel.value.trim() },
    };
  }
  if (peer.namespaceLabel && peer.namespaceLabel.key.trim()) {
    out.namespaceSelector = {
      matchLabels: {
        [peer.namespaceLabel.key.trim()]: peer.namespaceLabel.value.trim(),
      },
    };
  }
  if (peer.cidr && peer.cidr.trim()) {
    const ipBlock: Record<string, unknown> = { cidr: peer.cidr.trim() };
    if (peer.except && peer.except.length > 0) {
      ipBlock.except = peer.except.filter((c) => c.trim().length > 0);
    }
    out.ipBlock = ipBlock;
  }
  return Object.keys(out).length === 0 ? null : out;
}

function labelsToObject(labels: Label[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of labels) {
    if (l.key.trim()) out[l.key.trim()] = l.value.trim();
  }
  return out;
}

/**
 * Final cleanup: rename the `_peers` sentinel into `from` (ingress) or
 * `to` (egress). Run after buildNetworkPolicyManifest so the helper
 * stays direction-agnostic.
 */
export function finalizeManifest(manifest: ManifestObject): ManifestObject {
  const spec = manifest.spec as Record<string, unknown> | undefined;
  if (!spec) return manifest;
  for (const dir of ["ingress", "egress"] as const) {
    const list = spec[dir] as Array<Record<string, unknown>> | undefined;
    if (!list) continue;
    spec[dir] = list.map((rule) => {
      if (!rule._peers) return rule;
      const peers = rule._peers;
      const fromOrTo = dir === "ingress" ? "from" : "to";
      const out: Record<string, unknown> = { [fromOrTo]: peers };
      if (rule.ports) out.ports = rule.ports;
      return out;
    });
  }
  return manifest;
}

/**
 * Tiny YAML serializer for the restricted manifest shape we produce
 * (objects, arrays, strings, numbers, booleans). We avoid pulling in
 * js-yaml just for the wizard preview — the full library would add
 * 60+ KiB to a route that only needs maybe 30 lines of formatter code.
 *
 * Rules:
 *   - Strings get quoted only when they could be misread as YAML literals
 *     (start with special chars, contain colons followed by spaces, equal
 *     "true"/"false"/"null"/"yes"/"no", or are empty).
 *   - Arrays use the block (`- `) form.
 *   - Empty objects render as `{}`; empty arrays as `[]`.
 *   - Field order is preserved (important for K8s manifest readability).
 */
export function manifestToYaml(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") return formatString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${manifestToYaml(item, 0)}`;
        const inner = manifestToYaml(item, indent + 2);
        return `${pad}-\n${inner}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return entries
      .map(([k, v]) => {
        if (isScalar(v)) return `${pad}${k}: ${manifestToYaml(v, 0)}`;
        if (Array.isArray(v) && v.length === 0) return `${pad}${k}: []`;
        if (
          typeof v === "object" &&
          v !== null &&
          !Array.isArray(v) &&
          Object.keys(v as Record<string, unknown>).length === 0
        ) {
          return `${pad}${k}: {}`;
        }
        return `${pad}${k}:\n${manifestToYaml(v, indent + 2)}`;
      })
      .join("\n");
  }
  return String(value);
}

function isScalar(v: unknown): boolean {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

function formatString(s: string): string {
  if (s === "") return '""';
  if (
    /^[-?:&*!%@`"',\[\]{}]/.test(s) ||
    /[:#]\s/.test(s) ||
    /\n/.test(s) ||
    /^(true|false|null|yes|no|~)$/i.test(s) ||
    /^\d+(\.\d+)?$/.test(s)
  ) {
    // Single-quote, escape any embedded single quotes.
    return `'${s.replace(/'/g, "''")}'`;
  }
  return s;
}

/**
 * Quick validation surfaces blocking errors before we let the user hit
 * Apply. Returns an empty array when everything is good.
 */
export function validate(spec: WizardSpec): string[] {
  const errs: string[] = [];
  if (!spec.name.trim()) errs.push("name is required");
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(spec.name.trim())) {
    if (spec.name.trim()) {
      errs.push("name must match DNS-1123 (lowercase, digits, dashes)");
    }
  }
  if (!spec.namespace.trim()) errs.push("namespace is required");
  if (!spec.ingress.enabled && !spec.egress.enabled) {
    errs.push("select at least one direction (Ingress or Egress)");
  }
  return errs;
}
