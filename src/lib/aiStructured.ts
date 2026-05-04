export type StructuredSectionTone =
  | "summary"
  | "evidence"
  | "cause"
  | "checks"
  | "commands"
  | "remediation"
  | "confirmation";

export type CommandSafety = "read-only" | "requires-confirmation";

export type StructuredAnswerSection = {
  title: string;
  tone: StructuredSectionTone;
  content: string;
  lines: string[];
};

export type StructuredCommand = {
  command: string;
  raw: string;
  safety: CommandSafety;
  sourceTone: StructuredSectionTone;
};

export type StructuredAnswer = {
  answer: string;
  sections: StructuredAnswerSection[];
  commands: StructuredCommand[];
  requiresConfirmation: boolean;
};

type HeadingMeta = {
  label: string;
  tone: StructuredSectionTone;
  jsonKeys: string[];
};

const SECTION_HEADINGS: HeadingMeta[] = [
  { label: "Summary", tone: "summary", jsonKeys: ["summary"] },
  { label: "Evidence", tone: "evidence", jsonKeys: ["evidence"] },
  {
    label: "Most likely cause",
    tone: "cause",
    jsonKeys: ["most_likely_cause", "cause"],
  },
  { label: "Next checks", tone: "checks", jsonKeys: ["next_checks", "checks"] },
  {
    label: "Safe kubectl commands",
    tone: "commands",
    jsonKeys: ["safe_kubectl_commands", "commands"],
  },
  {
    label: "Remediation suggestions",
    tone: "remediation",
    jsonKeys: ["remediation_suggestions", "remediation"],
  },
  {
    label: "Requires confirmation",
    tone: "confirmation",
    jsonKeys: ["requires_confirmation"],
  },
];

const KNOWN_HEADING_PATTERN = SECTION_HEADINGS.map((h) =>
  escapeRegExp(h.label),
).join("|");

export function parseStructuredAnswer(stdout: string): StructuredAnswer {
  const answer = extractAssistantAnswer(stdout);
  const jsonObject = parseJsonAnswer(answer);
  const sections = jsonObject
    ? sectionsFromJson(jsonObject)
    : sectionsFromHeadings(answer);
  const commands = sections.flatMap(commandsFromSection);
  const confirmationValue = jsonObject
    ? readFirstJsonValue(jsonObject, ["requires_confirmation"])
    : undefined;
  const explicitConfirmation =
    confirmationValue === true ||
    (typeof confirmationValue === "string" && confirmationValue.trim().length > 0) ||
    (Array.isArray(confirmationValue) && confirmationValue.length > 0);

  return {
    answer,
    sections,
    commands,
    requiresConfirmation:
      explicitConfirmation ||
      commands.some((command) => command.safety === "requires-confirmation") ||
      sections.some((section) => section.tone === "confirmation"),
  };
}

export function extractAssistantAnswer(stdout: string): string {
  const text = stripAnsi(stdout).trim();
  if (!text) return "";

  const assistantMarkers = [
    /\nassistant\s*\n+/gi,
    /\nassistant response\s*:?\s*\n+/gi,
    /\nfinal answer\s*:?\s*\n+/gi,
  ];

  for (const marker of assistantMarkers) {
    const matches = Array.from(text.matchAll(marker));
    const last = matches[matches.length - 1];
    if (last?.index !== undefined) {
      const answer = text.slice(last.index + last[0].length).trim();
      if (answer && !looksLikePromptEcho(answer)) return answer;
    }
  }

  return looksLikePromptEcho(text) ? "" : text;
}

export function normalizeSectionLines(content: string): string[] {
  return content
    .replace(/```(?:bash|sh|shell|json)?/gi, "")
    .replace(/```/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/^\*\*(.+)\*\*$/, "$1"))
    .filter(Boolean);
}

export function isCommandLine(line: string): boolean {
  return /^(?:[-*]\s*|\d+\.\s*)?(?:`{0,3})?(?:[$>]\s*)?kubectl\b/i.test(
    line.trim(),
  );
}

export function cleanCommand(line: string): string {
  return cleanListMarker(line)
    .replace(/^`+|`+$/g, "")
    .replace(/^[$>]\s*/, "")
    .trim();
}

export function getCommandSafety(
  command: string,
  sourceTone?: StructuredSectionTone,
): CommandSafety {
  if (sourceTone === "confirmation") return "requires-confirmation";
  return looksMutatingCommand(command) ? "requires-confirmation" : "read-only";
}

function sectionsFromJson(
  jsonObject: Record<string, unknown>,
): StructuredAnswerSection[] {
  return SECTION_HEADINGS.flatMap((heading) => {
    const value = readFirstJsonValue(jsonObject, heading.jsonKeys);
    const content = stringifySectionValue(value);
    if (!content) return [];

    return [
      {
        title: heading.label,
        tone: heading.tone,
        content,
        lines: normalizeSectionLines(content),
      },
    ];
  });
}

function sectionsFromHeadings(answer: string): StructuredAnswerSection[] {
  const text = answer.trim();
  if (!text) return [];

  const pattern = new RegExp(
    `(?:^|\\n)\\s*(?:#{1,6}\\s*)?(?:\\d+\\.\\s*)?\\*{0,2}(${KNOWN_HEADING_PATTERN})\\*{0,2}\\s*:?\\s*(?:\\n|$)`,
    "gi",
  );
  const matches = Array.from(text.matchAll(pattern));
  if (!matches.length) {
    return [
      {
        title: "Summary",
        tone: "summary",
        content: text,
        lines: normalizeSectionLines(text),
      },
    ];
  }

  return matches
    .map((match, index) => {
      const title = match[1];
      const start = match.index! + match[0].length;
      const end = matches[index + 1]?.index ?? text.length;
      const meta = SECTION_HEADINGS.find(
        (h) => h.label.toLowerCase() === title.toLowerCase(),
      );
      const content = text.slice(start, end).trim();

      return {
        title: meta?.label ?? title,
        tone: meta?.tone ?? "summary",
        content,
        lines: normalizeSectionLines(content),
      };
    })
    .filter((section) => section.content.length > 0);
}

function commandsFromSection(section: StructuredAnswerSection): StructuredCommand[] {
  if (section.tone !== "commands" && section.tone !== "confirmation") return [];

  return section.lines.filter(isCommandLine).map((raw) => {
    const command = cleanCommand(raw);
    return {
      command,
      raw,
      safety: getCommandSafety(command, section.tone),
      sourceTone: section.tone,
    };
  });
}

function parseJsonAnswer(answer: string): Record<string, unknown> | null {
  const candidates = [
    ...Array.from(answer.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map(
      (match) => match[1],
    ),
    answer,
    extractJsonObjectCandidate(answer),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Keep trying less exact candidates.
    }
  }

  return null;
}

function extractJsonObjectCandidate(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function readFirstJsonValue(
  jsonObject: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(jsonObject, key)) {
      return jsonObject[key];
    }
  }
  return undefined;
}

function stringifySectionValue(value: unknown): string {
  if (value === undefined || value === null || value === false) return "";
  if (value === true) return "Yes";
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifySectionValue(item))
      .filter(Boolean)
      .join("\n");
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, entry]) => `${humanizeKey(key)}: ${stringifySectionValue(entry)}`)
      .filter(Boolean)
      .join("\n");
  }
  return String(value).trim();
}

function cleanListMarker(line: string): string {
  return line.replace(/^[-*]\s*/, "").replace(/^\d+\.\s*/, "").trim();
}

function looksLikePromptEcho(text: string): boolean {
  return (
    text.includes("You are Lumen's local Kubernetes assistant.") &&
    text.includes("Redacted context:") &&
    (text.includes("Return this structure:") ||
      text.includes("Return one JSON object"))
  );
}

function looksMutatingCommand(command: string): boolean {
  return (
    /\bkubectl\s+(?:apply|create|delete|edit|patch|replace|rollout\s+restart|scale|set|cordon|uncordon|drain|taint|annotate|label)\b/i.test(
      command,
    ) ||
    /\bkubectl\s+config\s+(?:set|set-cluster|set-context|set-credentials|unset|use-context|rename-context|delete-cluster|delete-context|delete-user)\b/i.test(
      command,
    ) ||
    /\bkubectl\s+auth\s+reconcile\b/i.test(command)
  );
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
