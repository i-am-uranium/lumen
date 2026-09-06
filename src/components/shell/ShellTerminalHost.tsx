import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import type { ShellSession } from "@/state/shellSession";

const XTERM_DEFAULTS = {
  cursorBlink: true,
  fontFamily:
    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.2,
  scrollback: 5000,
  theme: {
    background: "#0d0e12",
    foreground: "#efeff1",
    cursor: "#ffcf25",
    cursorAccent: "#15181e",
    selectionBackground: "rgba(255, 207, 37, 0.25)",
    black: "#15181e",
    red: "#e26b73",
    green: "#84cf80",
    yellow: "#ffcf25",
    blue: "#7aa6ff",
    magenta: "#d987ff",
    cyan: "#7be0e0",
    white: "#d5d7db",
  },
} as const;

export function ShellTerminalHost({
  session,
  searchAddonRef,
}: {
  session: ShellSession;
  searchAddonRef?: React.MutableRefObject<SearchAddon | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const encoderRef = useRef<TextEncoder | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal(XTERM_DEFAULTS);
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(search);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    encoderRef.current = new TextEncoder();
    if (searchAddonRef) searchAddonRef.current = search;

    // Replay scrollback in one batch.
    for (const chunk of session.getScrollbackChunks()) {
      term.write(chunk);
    }

    // A replacement may already have run and exited before this host mounts.
    // Mounting/reopening its terminal must never execute the command again.
    if (session.getState() === "idle") void session.start(term.cols, term.rows);

    // Live output is pushed directly into xterm without notifying React.
    const offOutput = session.subscribeOutput((chunk) => {
      term.write(chunk);
    });

    // stdin → backend.
    const onData = term.onData((data) => {
      const enc = encoderRef.current;
      if (!enc) return;
      void session.sendStdin(enc.encode(data));
    });

    // Resize observer.
    const ro = new ResizeObserver(() => {
      const f = fitRef.current;
      const t = termRef.current;
      if (!f || !t) return;
      f.fit();
      void session.resize(t.cols, t.rows);
    });
    ro.observe(hostRef.current);

    return () => {
      offOutput();
      onData.dispose();
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      encoderRef.current = null;
      if (searchAddonRef) searchAddonRef.current = null;
    };
  }, [session, searchAddonRef]);

  return (
    <div
      ref={hostRef}
      className="flex-1 min-h-0 bg-[#0d0e12] p-2"
      onClick={() => termRef.current?.focus()}
    />
  );
}
