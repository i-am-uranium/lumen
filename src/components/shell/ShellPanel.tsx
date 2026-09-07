import { useMutationCapability } from "@/hooks/useMutationCapability";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import { useShellSession } from "@/hooks/useShellSession";
import type { ShellSession } from "@/state/shellSession";
import { ShellToolbar } from "./ShellToolbar";
import type { ShellSearchState } from "./ShellSearchBox";
import { cn } from "@/lib/utils";

const ShellTerminalHost = lazy(() =>
  import("./ShellTerminalHost").then((module) => ({
    default: module.ShellTerminalHost,
  })),
);

export function ShellPanel({
  session,
  containerOptions,
  onStartSelection,
}: {
  session: ShellSession;
  containerOptions: { name: string }[];
  onStartSelection: (container: string, command: string[]) => void;
}) {
  const snapshot = useShellSession(session);
  const capability = useMutationCapability(session.context);
  useEffect(() => {
    if (!capability.canMutate && (capability.status || capability.error || capability.globalReadOnly) && (session.getState() === "live" || session.getState() === "starting")) session.close();
  }, [capability.canMutate, capability.status, capability.error, capability.globalReadOnly, session]);
  const [search, setSearch] = useState<ShellSearchState>({ query: "", caseSensitive: false });
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [container, setContainer] = useState(session.container);
  const [command, setCommand] = useState(formatCommand(session.command));
  const [startError, setStartError] = useState<string | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  // Run search whenever the query or case toggle changes.
  useEffect(() => {
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (!search.query) {
      try { addon.clearDecorations(); } catch { /* ignore */ }
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }
    addon.findNext(search.query, { caseSensitive: search.caseSensitive });
  }, [search.query, search.caseSensitive]);

  // Listen for search result changes from the addon to update the counter.
  useEffect(() => {
    const addon = searchAddonRef.current;
    if (!addon) return;
    const dispose = addon.onDidChangeResults((e) => {
      setMatchCount(e.resultCount);
      setCurrentMatch(e.resultIndex < 0 ? 0 : e.resultIndex);
    });
    return () => dispose.dispose();
  }, [searchAddonRef.current]); // eslint-disable-line react-hooks/exhaustive-deps

  const stateDot = (() => {
    switch (snapshot.state) {
      case "live": return "bg-success animate-pulse";
      case "starting": return "bg-warning";
      case "exited": return snapshot.exitCode === 0 ? "bg-term-subtle" : "bg-term-red";
      case "failed": return "bg-term-red";
      default: return "bg-term-subtle";
    }
  })();

  function onStart() {
    try {
      if (!capability.canMutate) throw new Error(capability.reason);
      const args = parseCommand(command);
      if (!container) throw new Error("Select a container.");
      setStartError(null);
      onStartSelection(container, args);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  }
  function onStop() {
    session.close();
  }
  function onDownload() {
    const chunks = session.getScrollbackChunks();
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    const text = new TextDecoder().decode(merged);
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session.namespace}-${session.pod}-${session.container}-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 py-1 border-b border-term-border-soft text-[11px] text-term-subtle truncate flex items-center gap-2">
        <span>{session.namespace} / {session.pod}</span>
        <span>·</span>
        <span>container {session.container}</span>
        <span>·</span>
        <span className="font-mono">{formatCommand(session.command)}</span>
        <span className={cn("ml-1 size-2 rounded-full", stateDot)} title={snapshot.state} />
      </div>
      <ShellToolbar
        mutationBlocked={!capability.canMutate}
        containers={containerOptions}
        container={container}
        onContainerChange={setContainer}
        command={command}
        onCommandChange={setCommand}
        state={snapshot.state}
        search={search}
        matchCount={matchCount}
        currentMatch={currentMatch}
        onSearchChange={setSearch}
        onSearchPrev={() => searchAddonRef.current?.findPrevious(search.query, { caseSensitive: search.caseSensitive })}
        onSearchNext={() => searchAddonRef.current?.findNext(search.query, { caseSensitive: search.caseSensitive })}
        onStart={onStart}
        onStop={onStop}
        onDownload={onDownload}
      />
      {!capability.canMutate && <div role="status" className="px-3 py-2 text-[11px] text-warning">{session.context} · {capability.reason}</div>}
      {startError && <div role="alert" className="px-3 py-2 text-[11px] text-term-red">{startError}</div>}
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-[12px] text-term-muted">
            <span className="animate-pulse">starting terminal...</span>
          </div>
        }
      >
        {capability.canMutate && <ShellTerminalHost session={session} searchAddonRef={searchAddonRef} />}
      </Suspense>
    </div>
  );
}

// Parse argv only: expansion, pipes, and redirects require an explicit shell
// command such as /bin/sh -c '...'. Quotes group arguments without being sent.
function formatCommand(args: ReadonlyArray<string>): string {
  return args.map((arg) => /^[\w/.=:+-]+$/.test(arg) ? arg : `'${arg.split("'").join("'\\''")}'`).join(" ");
}

function parseCommand(text: string): string[] {
  const args: string[] = [];
  let word = "";
  let quote: string | null = null;
  let escaped = false;
  let started = false;
  for (const char of text) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { args.push(word); word = ""; started = false; }
    } else { word += char; started = true; }
  }
  if (quote || escaped) throw new Error("Close the command quote or escape before starting.");
  if (started) args.push(word);
  if (!args[0]) throw new Error("Enter a command before starting.");
  return args;
}
