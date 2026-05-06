import { useEffect, useState } from "react";
import { Keyboard, Laptop, Lock, LockOpen, Moon, RotateCcw, Sun } from "lucide-react";
import { useThemeStore, type ThemeMode } from "@/state/theme";
import { useUiSettings } from "@/state/uiSettings";
import { cn } from "@/lib/utils";
import { captureChord, REGISTRY } from "@/lib/shortcuts";
import { APP_VERSION } from "@/lib/appInfo";

/**
 * Lumen settings page (D7 — minimal scope).
 *
 * Currently consolidates the two persisted user preferences that exist
 * today (theme + read-only mode). The page is the right home for any
 * future toggles — configurable keyboard shortcuts, default namespace,
 * activity-stream filters — once those features land. Right now it's
 * deliberately lean so users have a clear "where are my settings?"
 * answer in one place rather than hunting the topbar / Cmd-K.
 */

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun; hint: string }[] = [
  { value: "light", label: "Light", icon: Sun, hint: "Always light" },
  { value: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
  {
    value: "system",
    label: "System",
    icon: Laptop,
    hint: "Follow OS preference",
  },
];

export function Settings() {
  const themeMode = useThemeStore((s) => s.mode);
  const setThemeMode = useThemeStore((s) => s.setMode);
  const readOnly = useUiSettings((s) => s.readOnly);
  const setReadOnly = useUiSettings((s) => s.setReadOnly);

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-2xl px-6 py-6 space-y-6">
        <header>
          <h1 className="mds-heading text-[20px] text-text-primary">Settings</h1>
          <p className="mt-1 text-[12px] text-text-secondary">
            Persisted across sessions. Quick toggles also available in the topbar
            (theme picker, read-only chip) and Cmd-K palette.
          </p>
        </header>

        <Section
          title="Appearance"
          description="Theme tracks the active CSS token system across every view. System mode follows your OS preference live."
        >
          <fieldset className="grid grid-cols-3 gap-2">
            <legend className="sr-only">Theme</legend>
            {THEME_OPTIONS.map(({ value, label, icon: Icon, hint }) => {
              const active = themeMode === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setThemeMode(value)}
                  aria-pressed={active}
                  className={cn(
                    "flex flex-col items-start gap-1.5 rounded-control border px-3 py-2.5 text-left text-[12px] transition-colors",
                    active
                      ? "border-accent-primary/60 bg-accent-primary-soft text-accent-primary"
                      : "border-border-default bg-surface text-text-primary hover:bg-hover",
                  )}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    <Icon className="size-3.5" aria-hidden="true" />
                    {label}
                  </span>
                  <span className="text-[10px] text-text-muted">{hint}</span>
                </button>
              );
            })}
          </fieldset>
        </Section>

        <Section
          title="Safety"
          description="Read-only mode hides every destructive action across the app — delete, scale, restart, cordon, drain, image hot-swap. Useful on demo clusters, shared shells, or while pairing on prod incidents."
        >
          <button
            type="button"
            role="switch"
            aria-checked={readOnly}
            onClick={() => setReadOnly(!readOnly)}
            className={cn(
              "flex w-full items-center justify-between rounded-control border px-3 py-2.5 text-left transition-colors",
              readOnly
                ? "border-warning/40 bg-warning-soft"
                : "border-border-default bg-surface hover:bg-hover",
            )}
          >
            <div className="flex items-center gap-2">
              {readOnly ? (
                <Lock className="size-3.5 text-warning" aria-hidden="true" />
              ) : (
                <LockOpen className="size-3.5 text-text-muted" aria-hidden="true" />
              )}
              <div className="flex flex-col">
                <span
                  className={cn(
                    "text-[12px] font-medium",
                    readOnly ? "text-warning" : "text-text-primary",
                  )}
                >
                  Read-only mode {readOnly ? "on" : "off"}
                </span>
                <span className="text-[10px] text-text-muted">
                  {readOnly
                    ? "Destructive actions are disabled across the app."
                    : "All actions enabled — operate with care on production contexts."}
                </span>
              </div>
            </div>
            <span
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors",
                readOnly
                  ? "border-warning/40 bg-warning"
                  : "border-border-default bg-elevated",
              )}
              aria-hidden="true"
            >
              <span
                className={cn(
                  "absolute top-0.5 size-3.5 rounded-full bg-surface shadow-sm transition-all",
                  readOnly ? "left-[18px]" : "left-0.5",
                )}
              />
            </span>
          </button>
        </Section>

        <ShortcutsSection />

        <Section title="About" description="Installed Lumen build information.">
          <div className="flex items-center justify-between rounded border border-border-subtle bg-elevated px-3 py-2.5">
            <span className="text-[12px] font-medium text-text-primary">Version</span>
            <span className="font-mono text-[12px] text-text-secondary">
              v{APP_VERSION}
            </span>
          </div>
        </Section>

        <Section
          title="Coming soon"
          description="Settings landing here in future Lumen releases."
        >
          <ul className="space-y-1 text-[12px] text-text-secondary">
            <li>• Default cluster context + namespace</li>
            <li>• Activity-stream filter presets</li>
            <li>
              • Column reorder + favorite resources (current release ships{" "}
              <em>show/hide</em> only)
            </li>
          </ul>
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-panel border border-border-subtle bg-surface p-4">
      <h2 className="mds-heading text-[14px] text-text-primary">{title}</h2>
      {description && (
        <p className="mt-1 text-[11px] text-text-secondary">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * Shortcut editor (D7 stretch). Each row shows the active chord
 * (override or default) and a "record" button that captures the next
 * keystroke. Esc cancels the recorder. Reset clears every override.
 */
function ShortcutsSection() {
  const overrides = useUiSettings((s) => s.shortcuts);
  const setShortcut = useUiSettings((s) => s.setShortcut);
  const resetShortcuts = useUiSettings((s) => s.resetShortcuts);
  const [recording, setRecording] = useState<string | null>(null);

  // Capture the next keypress when recording is active. Bound here (not
  // in the row) so only one listener is alive at a time.
  useEffect(() => {
    if (!recording) return;
    const cleanup = captureChord((chord) => {
      if (chord !== null) setShortcut(recording, chord);
      setRecording(null);
    });
    return cleanup;
  }, [recording, setShortcut]);

  return (
    <Section
      title="Keyboard shortcuts"
      description="Override the global chords. Press a key combination to record. Esc cancels."
    >
      <div className="space-y-2">
        {REGISTRY.map((action) => {
          const active = overrides[action.id] ?? action.defaultChord;
          const isOverride = !!overrides[action.id];
          const isRecording = recording === action.id;
          return (
            <div
              key={action.id}
              className="flex items-center justify-between gap-3 rounded border border-border-subtle bg-elevated p-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Keyboard className="size-3 text-text-muted" />
                  <span className="text-[12px] font-medium text-text-primary">
                    {action.label}
                  </span>
                  {action.scope === "drawer" && (
                    <span
                      className="rounded bg-elevated px-1 text-[9px] uppercase tracking-wide text-text-muted"
                      title="Only fires while the resource detail drawer is open"
                    >
                      when drawer is open
                    </span>
                  )}
                  {isOverride && (
                    <span className="rounded bg-accent-primary-soft px-1 text-[9px] uppercase tracking-wide text-accent-primary">
                      custom
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-text-muted">
                  {action.description}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setRecording(isRecording ? null : action.id)}
                  className={cn(
                    "rounded border px-2 py-1 font-mono text-[11px]",
                    isRecording
                      ? "border-accent-primary bg-accent-primary-soft text-accent-primary"
                      : "border-border-default bg-surface text-text-primary hover:bg-hover",
                  )}
                >
                  {isRecording ? "press a key…" : active}
                </button>
                {isOverride && (
                  <button
                    type="button"
                    onClick={() => setShortcut(action.id, null)}
                    title="reset to default"
                    className="rounded p-1 text-text-muted hover:bg-elevated hover:text-text-primary"
                  >
                    <RotateCcw className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {Object.keys(overrides).length > 0 && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={resetShortcuts}
            className="text-[11px] text-text-muted hover:text-text-primary"
          >
            reset all overrides
          </button>
        </div>
      )}
    </Section>
  );
}
