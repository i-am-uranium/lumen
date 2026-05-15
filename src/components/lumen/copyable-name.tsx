import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Click-to-copy wrapper for resource names in drawer headers.
 *
 * The full label (children) is the click target; a small Copy icon sits to
 * the right and swaps to a Check for ~1.2s after a successful copy. Falls
 * back silently if the clipboard API is unavailable (e.g. insecure context).
 */
export function CopyableName({
  value,
  className,
  iconClassName,
  children,
  ariaLabel,
}: {
  value: string;
  className?: string;
  iconClassName?: string;
  children: React.ReactNode;
  /** Override for screen-reader label; defaults to "copy <value>". */
  ariaLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`copied "${value}"`);
    } catch {
      toast.error("copy failed");
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "copied" : `click to copy "${value}"`}
      aria-label={ariaLabel ?? `copy ${value}`}
      className={cn(
        "group inline-flex min-w-0 items-center gap-1.5 rounded text-left",
        "hover:bg-elevated focus-visible:bg-elevated",
        "outline-none focus-visible:ring-1 focus-visible:ring-accent-primary",
        "transition-colors",
        className,
      )}
    >
      {children}
      {copied ? (
        <Check
          className={cn("size-3 shrink-0 text-success", iconClassName)}
          aria-hidden="true"
        />
      ) : (
        <Copy
          className={cn(
            "size-3 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
            iconClassName,
          )}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
