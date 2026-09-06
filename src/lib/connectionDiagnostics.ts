import { invoke } from "@tauri-apps/api/core";

export type ConnectionDiagnosticStatus =
  | "ready_to_retry"
  | "missing_config"
  | "invalid_config"
  | "context_missing"
  | "missing_credential_executable";

export type ConnectionDiagnostic = {
  context: string | null;
  config_path: string;
  status: ConnectionDiagnosticStatus;
  credential_executable: string | null;
  credential_executable_available: boolean | null;
  message: string;
  single_source_only: boolean;
};

export type ConnectionFailureStatus =
  | "authentication"
  | "permission_denied"
  | "tls"
  | "network"
  | "unknown";

export type ConnectionFailure = {
  status: ConnectionFailureStatus;
  title: string;
  guidance: string;
};

export function diagnoseConnection(context?: string | null): Promise<ConnectionDiagnostic> {
  return invoke("diagnose_connection", { context: context ?? null });
}

export function classifyConnectionError(error: unknown): ConnectionFailure {
  const value = String(
    error && typeof error === "object" && "message" in error
      ? (error as { message?: unknown }).message
      : error,
  ).toLowerCase();
  if (/x509|certificate|tls|ssl/.test(value)) {
    return {
      status: "tls",
      title: "TLS verification failed",
      guidance: "Check the cluster server name and trusted certificate configuration, then retry.",
    };
  }
  if (/forbidden|status.?403|cannot (get|list|watch)/.test(value)) {
    return {
      status: "permission_denied",
      title: "Permission denied",
      guidance: "Your Kubernetes identity connected, but it cannot perform the requested read. Ask for the specific read permission needed for this workflow.",
    };
  }
  if (/permission denied/.test(value)) {
    return {
      status: "permission_denied",
      title: "Permission denied",
      guidance: "A local file, credential tool, or Kubernetes API request was denied. Check the relevant access permissions, then retry.",
    };
  }
  if (/unauthorized|authentication|login|credential|status.?401|expired/.test(value)) {
    return {
      status: "authentication",
      title: "Authentication required",
      guidance: "Refresh your provider login or credentials, then retry the connection.",
    };
  }
  if (/network|dial tcp|connection refused|timed? out|timeout|dns|no such host|unreachable/.test(value)) {
    return {
      status: "network",
      title: "Cluster network unavailable",
      guidance: "Check VPN, DNS, proxy, and cluster endpoint reachability, then retry.",
    };
  }
  return {
    status: "unknown",
    title: "Connection failed",
    guidance: "Review your kubeconfig and local access prerequisites, then retry.",
  };
}
