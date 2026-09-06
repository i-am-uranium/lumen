export type LegacyResourceFocus = {
  kind: string;
  namespace?: string | null;
  name: string;
};

export function legacyAssistantTarget(
  ctx: string,
  resource: LegacyResourceFocus,
  originalSearch = "",
): string {
  const params = new URLSearchParams(originalSearch);
  if (resource.namespace) params.set("ns", resource.namespace);
  if (resource.name) params.set("q", resource.name);
  const query = params.toString();
  return `/cluster/${encodeURIComponent(ctx)}/workloads${query ? `?${query}` : ""}`;
}
