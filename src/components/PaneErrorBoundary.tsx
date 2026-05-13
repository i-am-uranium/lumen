import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  /** Resets the boundary when `resetKey` changes — typically the pane url. */
  resetKey?: string;
  /** Called when the user clicks "back to fleet" / reset. */
  onReset?: () => void;
  children: ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * Catches render errors inside a single pane so an exception in one
 * route (e.g. a transient Tauri API failure during mount) only blanks
 * that pane's content, never the whole app. Mounted around `<Routes>`
 * inside `PaneShell` — the TabBar, NavBar, and StatusBar all sit
 * outside the boundary and stay interactive, so the user can switch
 * tabs, close the pane, or click "reset" to recover.
 *
 * Resets automatically when `resetKey` changes — set it to the pane's
 * URL so a different navigation re-attempts rendering. Also resets on
 * the explicit button click.
 */
export class PaneErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console so the user (or their dev tools) can see what
    // went wrong. Don't toast — a route-render error usually retriggers
    // on every re-render and toasting would spam the screen.
    // eslint-disable-next-line no-console
    console.error("[pane error]", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <AlertTriangle
          className="size-7 text-warning"
          aria-hidden="true"
        />
        <div className="space-y-1">
          <h2 className="mds-heading text-[14px] text-term-fg">
            this view crashed
          </h2>
          <p className="max-w-md text-[12px] text-term-muted">
            {this.state.error.message || "An unexpected error occurred while rendering this route."}
          </p>
        </div>
        <button
          type="button"
          onClick={this.handleReset}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-term-border-soft bg-term-bg/70 px-3 text-[12px] text-term-muted transition-colors",
            "hover:border-accent-primary/35 hover:text-term-fg",
          )}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          back to fleet
        </button>
      </div>
    );
  }
}
