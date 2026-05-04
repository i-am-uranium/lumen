import { describe, expect, it } from "vitest";
import {
  cleanCommand,
  extractAssistantAnswer,
  getCommandSafety,
  isCommandLine,
  normalizeSectionLines,
  parseStructuredAnswer,
} from "./aiStructured";

describe("parseStructuredAnswer", () => {
  it("parses a raw JSON object with structured fields", () => {
    const parsed = parseStructuredAnswer(
      JSON.stringify({
        summary: "Pods are crash looping.",
        evidence: ["pod/api-0 restarted 8 times", "last exit code 1"],
        most_likely_cause: "Bad database credentials.",
        next_checks: ["Inspect secret references", "Check recent rollout"],
        safe_kubectl_commands: [
          "kubectl get pods -n app",
          "kubectl describe pod api-0 -n app",
        ],
        remediation_suggestions: ["Rotate the secret after confirming owner."],
        requires_confirmation: ["kubectl rollout restart deployment/api -n app"],
      }),
    );

    expect(parsed.sections.map((section) => section.tone)).toEqual([
      "summary",
      "evidence",
      "cause",
      "checks",
      "commands",
      "remediation",
      "confirmation",
    ]);
    expect(parsed.commands).toEqual([
      {
        command: "kubectl get pods -n app",
        raw: "kubectl get pods -n app",
        safety: "read-only",
        sourceTone: "commands",
      },
      {
        command: "kubectl describe pod api-0 -n app",
        raw: "kubectl describe pod api-0 -n app",
        safety: "read-only",
        sourceTone: "commands",
      },
      {
        command: "kubectl rollout restart deployment/api -n app",
        raw: "kubectl rollout restart deployment/api -n app",
        safety: "requires-confirmation",
        sourceTone: "confirmation",
      },
    ]);
    expect(parsed.requiresConfirmation).toBe(true);
  });

  it("parses a fenced JSON object after assistant transcript markers", () => {
    const parsed = parseStructuredAnswer(`
provider log
assistant response:

\`\`\`json
{
  "summary": "Node pressure is affecting scheduling.",
  "cause": "DiskPressure on worker-1",
  "safe_kubectl_commands": ["kubectl get nodes", "kubectl describe node worker-1"],
  "requires_confirmation": false
}
\`\`\`
`);

    expect(parsed.answer).toContain('"summary"');
    expect(parsed.sections.find((section) => section.tone === "cause")?.content).toBe(
      "DiskPressure on worker-1",
    );
    expect(parsed.commands.map((command) => command.command)).toEqual([
      "kubectl get nodes",
      "kubectl describe node worker-1",
    ]);
    expect(parsed.requiresConfirmation).toBe(false);
  });

  it("falls back to exact markdown/text headings", () => {
    const parsed = parseStructuredAnswer(`
Summary
API errors increased after deploy.

Evidence:
- deployment/api image changed
- 503s began at 10:01

Most likely cause
Bad upstream configuration.

Next checks
1. Compare configmaps
2. Review ingress events

Safe kubectl commands
- \`kubectl get deploy api -n prod\`
- kubectl logs deploy/api -n prod --tail=100

Remediation suggestions
- Roll back after owner approval.

Requires confirmation
- kubectl rollout undo deployment/api -n prod
`);

    expect(parsed.sections).toHaveLength(7);
    expect(parsed.sections[0]).toMatchObject({
      title: "Summary",
      tone: "summary",
      lines: ["API errors increased after deploy."],
    });
    expect(parsed.commands.map((command) => command.safety)).toEqual([
      "read-only",
      "read-only",
      "requires-confirmation",
    ]);
  });

  it("returns no sections for empty output", () => {
    expect(parseStructuredAnswer(" \n\t ")).toEqual({
      answer: "",
      sections: [],
      commands: [],
      requiresConfirmation: false,
    });
  });

  it("does not mark empty JSON confirmation arrays as requiring confirmation", () => {
    const parsed = parseStructuredAnswer(
      JSON.stringify({
        summary: "No action required.",
        safe_kubectl_commands: ["kubectl get pods"],
        requires_confirmation: [],
      }),
    );

    expect(parsed.requiresConfirmation).toBe(false);
  });
});

describe("structured answer helpers", () => {
  it("extracts final assistant answers and ignores full prompt echoes", () => {
    expect(
      extractAssistantAnswer(`
prompt echoed here
final answer:

Summary
Only this should remain.
`),
    ).toBe("Summary\nOnly this should remain.");

    expect(
      extractAssistantAnswer(`
You are Lumen's local Kubernetes assistant.
Redacted context:
Return this structure:
`),
    ).toBe("");

    expect(
      extractAssistantAnswer(`
You are Lumen's local Kubernetes assistant.
Return one JSON object without markdown fences.
Redacted context:
`),
    ).toBe("");
  });

  it("normalizes section lines and command text", () => {
    expect(
      normalizeSectionLines(`
\`\`\`bash
- kubectl get pods
**Evidence: restart count increased**
\`\`\`
`),
    ).toEqual(["- kubectl get pods", "Evidence: restart count increased"]);

    expect(isCommandLine("- `kubectl get pods -A`")).toBe(true);
    expect(isCommandLine("$ kubectl describe node worker-1")).toBe(true);
    expect(isCommandLine("helm list")).toBe(false);
    expect(cleanCommand("1. `$ kubectl get pods -n prod`")).toBe(
      "kubectl get pods -n prod",
    );
  });

  it("classifies command safety from section tone with heuristic fallback", () => {
    expect(getCommandSafety("kubectl delete pod api-0", "commands")).toBe(
      "requires-confirmation",
    );
    expect(getCommandSafety("kubectl get pods", "confirmation")).toBe(
      "requires-confirmation",
    );
    expect(getCommandSafety("kubectl delete pod api-0")).toBe(
      "requires-confirmation",
    );
    expect(getCommandSafety("kubectl config set-context --current --namespace prod")).toBe(
      "requires-confirmation",
    );
    expect(getCommandSafety("kubectl auth reconcile -f rbac.yaml")).toBe(
      "requires-confirmation",
    );
    expect(getCommandSafety("kubectl config current-context")).toBe("read-only");
    expect(getCommandSafety("kubectl auth can-i list pods")).toBe("read-only");
    expect(getCommandSafety("kubectl get pods")).toBe("read-only");
  });
});
