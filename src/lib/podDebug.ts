export type DebugProfile = "restricted" | "baseline";
export type DebugContainer = { name: string; image: string; target_container: string | null; state: "waiting" | "running" | "terminated"; message: string | null };
export type DebugTarget = { context: string; namespace: string; pod: string; pod_uid: string; phase: string; deleting: boolean; containers: string[]; ephemeral_containers: DebugContainer[] };
export type DebugRequest = { context: string; namespace: string; pod: string; pod_uid: string; target_container: string; name: string; image: string; command: string[]; profile: DebugProfile };
export type DebugResult = { container: DebugContainer; reused: boolean };
