import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { k8s } from "@/lib/k8s";
import { useUiSettings } from "@/state/uiSettings";

function hasOwnNamespace(
  selectedNamespaces: Record<string, string>,
  context: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(selectedNamespaces, context);
}

export function useNamespaceScope(
  context: string,
  requestedNamespace?: string | null,
): {
  namespace: string;
  setNamespace: (next: string) => void;
  namespaces: string[];
  discoveryError: unknown;
  isLoading: boolean;
} {
  const selectedNamespaces = useUiSettings((state) => state.selectedNamespaces);
  const setSelectedNamespace = useUiSettings((state) => state.setSelectedNamespace);
  const hasPersistedNamespace = hasOwnNamespace(selectedNamespaces, context);
  const persistedNamespace = selectedNamespaces[context];
  const hasUrlOverride = requestedNamespace !== undefined && requestedNamespace !== null;
  const needsContextDefault = Boolean(context) && !hasUrlOverride && !hasPersistedNamespace;

  const contextsQuery = useQuery({
    queryKey: ["k8s", "contexts", "namespace-scope"],
    queryFn: k8s.listContexts,
    enabled: needsContextDefault,
    staleTime: 60_000,
  });
  const namespacesQuery = useQuery({
    queryKey: ["k8s", "namespaces", context],
    queryFn: () => k8s.listNamespaces(context || undefined),
    enabled: Boolean(context),
    staleTime: 60_000,
  });

  const contextDefault = contextsQuery.data?.find((item) => item.name === context)?.namespace ?? "";
  const namespace = hasUrlOverride
    ? requestedNamespace
    : hasPersistedNamespace
      ? persistedNamespace
      : contextDefault;
  const isLoading = needsContextDefault && contextsQuery.isPending;

  useEffect(() => {
    if (!context || !hasUrlOverride) return;
    setSelectedNamespace(context, requestedNamespace);
  }, [context, hasUrlOverride, requestedNamespace, setSelectedNamespace]);

  useEffect(() => {
    if (!context || !needsContextDefault || contextsQuery.isPending || contextsQuery.error) return;
    setSelectedNamespace(context, contextDefault);
  }, [context, contextDefault, contextsQuery.error, contextsQuery.isPending, needsContextDefault, setSelectedNamespace]);

  const setNamespace = useCallback(
    (next: string) => setSelectedNamespace(context, next),
    [context, setSelectedNamespace],
  );
  const namespaces = useMemo(() => {
    const discovered = namespacesQuery.data ?? [];
    return Array.from(new Set(namespace ? [...discovered, namespace] : discovered)).sort();
  }, [namespace, namespacesQuery.data]);

  return {
    namespace,
    setNamespace,
    namespaces,
    discoveryError: namespacesQuery.error ?? contextsQuery.error,
    isLoading,
  };
}
