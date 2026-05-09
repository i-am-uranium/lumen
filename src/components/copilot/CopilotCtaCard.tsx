import { Link } from "react-router-dom";
import { ChevronRight, GitBranch, Search, Siren, Sparkles, Terminal } from "lucide-react";
import type { CopilotCta } from "@/lib/copilotNavigation";
import { cn } from "@/lib/utils";

type Props = {
  cta: CopilotCta;
  onNavigate?: () => void;
};

const ICONS = {
  "argocd-app": GitBranch,
  events: Siren,
  logs: Terminal,
  search: Search,
  timeline: GitBranch,
  sparkles: Sparkles,
  siren: Siren,
};

export function CopilotCtaCard({ cta, onNavigate }: Props) {
  const Icon = ICONS[cta.icon as keyof typeof ICONS] ?? ICONS[cta.intent] ?? ChevronRight;

  return (
    <Link
      to={cta.to}
      onClick={onNavigate}
      className={cn(
        "group flex min-h-16 items-center gap-3 rounded-control border border-border-default bg-elevated px-3 py-2 text-left",
        "transition-colors hover:border-accent-primary/50 hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-control border border-border-default bg-surface text-accent-primary">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-text-primary">
          {cta.label}
        </span>
        <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-text-secondary">
          {cta.description}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}
