import { Play, Square, Download } from "lucide-react";
import type { ShellState } from "@/state/shellSession";
import { ShellSearchBox, type ShellSearchState } from "./ShellSearchBox";

const PRESETS = [
  { label: "/bin/sh", cmd: ["/bin/sh"] },
  { label: "/bin/bash", cmd: ["/bin/bash"] },
  { label: "/bin/ash", cmd: ["/bin/ash"] },
  { label: "sh", cmd: ["sh"] },
];

export function ShellToolbar({
  containers, container, onContainerChange,
  command, onCommandChange,
  state,
  search, matchCount, currentMatch, onSearchChange, onSearchPrev, onSearchNext,
  onStart, onStop, onDownload,
}: {
  containers: { name: string }[];
  container: string;
  onContainerChange: (c: string) => void;
  command: string;
  onCommandChange: (c: string) => void;
  state: ShellState;
  search: ShellSearchState;
  matchCount: number;
  currentMatch: number;
  onSearchChange: (s: ShellSearchState) => void;
  onSearchPrev: () => void;
  onSearchNext: () => void;
  onStart: () => void;
  onStop: () => void;
  onDownload: () => void;
}) {
  const live = state === "live" || state === "starting";
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-term-border-soft bg-term-panel-2">
      <select
        aria-label="shell container"
        value={container}
        onChange={(e) => onContainerChange(e.target.value)}
        disabled={live}
        className="h-6 px-1.5 text-[11px] rounded bg-term-bg border border-term-border-soft text-term-fg disabled:opacity-50"
      >
        {containers.map((c) => (
          <option key={c.name} value={c.name}>{c.name}</option>
        ))}
      </select>
      <input
        type="text"
        value={command}
        onChange={(e) => onCommandChange(e.target.value)}
        disabled={live}
        placeholder="command"
        aria-label="shell command"
        title="Command and arguments; quote arguments containing spaces. Use /bin/sh -c for shell expressions."
        className="w-[140px] h-6 px-1.5 text-[11px] rounded bg-term-bg border border-term-border-soft text-term-fg disabled:opacity-50"
      />
      <div className="flex items-center gap-0.5">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" disabled={live}
            onClick={() => onCommandChange(p.cmd.join(" "))}
            className="px-1.5 h-6 rounded border border-term-border-soft text-[10px] text-term-muted hover:text-term-fg disabled:opacity-50 font-mono">
            {p.label}
          </button>
        ))}
      </div>
      <div className="h-4 w-px bg-term-border-soft mx-1" />
      <ShellSearchBox
        query={search.query}
        caseSensitive={search.caseSensitive}
        matchCount={matchCount}
        currentMatch={currentMatch}
        onChange={onSearchChange}
        onPrev={onSearchPrev}
        onNext={onSearchNext}
      />
      <div className="flex items-center gap-0.5 ml-auto">
        {!live ? (
          <button type="button" onClick={onStart}
            className="px-2 py-0.5 rounded text-[10px] border border-term-green/40 bg-term-green/15 text-term-green flex items-center gap-1">
            <Play className="size-3" /> start
          </button>
        ) : (
          <button type="button" onClick={onStop}
            className="px-2 py-0.5 rounded text-[10px] border border-term-red/40 text-term-red flex items-center gap-1">
            <Square className="size-3" /> stop
          </button>
        )}
        <button type="button" onClick={onDownload}
          className="p-1 text-term-muted hover:text-term-fg" title="download scrollback">
          <Download className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
