export type RedactionFinding = {
  label: string;
  count: number;
};

export type RedactionResult = {
  text: string;
  findings: RedactionFinding[];
};

type Rule = {
  label: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
};

const RULES: Rule[] = [
  {
    label: "kubeconfig tokens",
    pattern: /(\b(?:token|client-certificate-data|client-key-data|certificate-authority-data)\s*:\s*)([^\s]+)/gi,
    replacement: "$1<redacted>",
  },
  {
    label: "authorization headers",
    pattern: /(authorization\s*[:=]\s*)(bearer\s+)?([A-Za-z0-9._~+/=-]{12,})/gi,
    replacement: (_match, prefix, bearer = "") => `${prefix}${bearer}<redacted>`,
  },
  {
    label: "environment secrets",
    pattern: /(-\s*name:\s*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*\n\s*value:\s*)(["']?)([^"'\s,}]{4,})(["']?)/gi,
    replacement: (_match, prefix, quote = "") => `${prefix}${quote}<redacted>${quote}`,
  },
  {
    label: "environment secrets",
    pattern: /(\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*)(["']?)([^"'\s,}]{4,})(["']?)/gi,
    replacement: (_match, prefix, quote = "") => `${prefix}${quote}<redacted>${quote}`,
  },
  {
    label: "base64-like values",
    pattern: /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
    replacement: "<redacted-base64>",
  },
  {
    label: "private keys",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "<redacted-private-key>",
  },
];

export function redactForAi(input: string): RedactionResult {
  let text = input;
  const findings = new Map<string, number>();

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args) => {
      findings.set(rule.label, (findings.get(rule.label) ?? 0) + 1);
      const replacement = rule.replacement;
      if (typeof replacement === "function") {
        return replacement(args[0], ...args.slice(1, -2));
      }
      return replacement.replace(/\$(\d+)/g, (_match, index) => {
        const value = args[Number(index)];
        return typeof value === "string" ? value : "";
      });
    });
  }

  return {
    text,
    findings: Array.from(findings.entries()).map(([label, count]) => ({
      label,
      count,
    })),
  };
}
