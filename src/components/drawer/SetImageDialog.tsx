import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Resource = { kind: string; namespace: string; name: string };

/**
 * Image hot-swap dialog (C4).
 *
 * Lazy-loaded from {@link ResourceDetailDrawer} so the strategic-merge
 * patch UI doesn't bloat the workloads route chunk for users who never
 * trigger an image rollout.
 */
export function SetImageDialog({
  resource,
  busy,
  onCancel,
  onSubmit,
}: {
  resource: Resource;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (container: string, image: string) => void;
}) {
  const [container, setContainer] = useState("");
  const [image, setImage] = useState("");
  const canSubmit =
    container.trim().length > 0 && image.trim().length > 0 && !busy;
  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-panel border border-border-default bg-surface shadow-[var(--shadow-popover)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-default px-4 py-3">
          <div className="flex flex-col">
            <span className="text-[13px] font-medium text-text-primary">
              set image · {resource.kind}/{resource.name}
            </span>
            <span className="text-[11px] text-text-muted">
              {resource.namespace}
            </span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-text-muted hover:bg-elevated hover:text-text-primary"
            aria-label="cancel"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="space-y-3 px-4 py-3">
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
              container
            </span>
            <input
              type="text"
              autoFocus
              value={container}
              onChange={(e) => setContainer(e.target.value)}
              placeholder="e.g. api"
              className="term-input w-full"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
              new image
            </span>
            <input
              type="text"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="e.g. registry/api:v1.2.3"
              className="term-input w-full"
            />
          </label>
          <p className="text-[11px] text-text-muted">
            Strategic merge patch — Kubernetes will roll the workload through
            its normal update strategy. Only the named container is touched.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border-default px-4 py-3">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!canSubmit}
            onClick={() => onSubmit(container.trim(), image.trim())}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "set image"}
          </Button>
        </div>
      </div>
    </div>
  );
}
