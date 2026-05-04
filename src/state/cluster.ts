import { create } from "zustand";
import { persist } from "zustand/middleware";

type ClusterState = {
  contextName: string | null;
  namespace: string | null;
  setContext: (name: string) => void;
  setNamespace: (ns: string) => void;
  lastNamespaceByContext: Record<string, string>;
};

export const useClusterStore = create<ClusterState>()(
  persist(
    (set, get) => ({
      contextName: null,
      namespace: null,
      lastNamespaceByContext: {},
      setContext: (name) => {
        const last = get().lastNamespaceByContext[name] ?? null;
        set({ contextName: name, namespace: last });
      },
      setNamespace: (ns) =>
        set((s) => ({
          namespace: ns,
          lastNamespaceByContext: s.contextName
            ? { ...s.lastNamespaceByContext, [s.contextName]: ns }
            : s.lastNamespaceByContext,
        })),
    }),
    { name: "lumen-cluster" }
  )
);
