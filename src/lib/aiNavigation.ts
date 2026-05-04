export type AiResourceContext = {
  kind: string;
  namespace?: string | null;
  name: string;
};

export function aiResourceUrl(ctx: string, resource: AiResourceContext): string {
  const params = new URLSearchParams({
    kind: resource.kind,
    name: resource.name,
    task: "root-cause",
    question: `Investigate ${resource.kind}/${resource.name}. What should I check first?`,
  });
  if (resource.namespace) params.set("namespace", resource.namespace);
  return `/cluster/${encodeURIComponent(ctx)}/ai?${params.toString()}`;
}
