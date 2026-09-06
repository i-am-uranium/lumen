import { useCallback, useSyncExternalStore } from "react";
import type { LogStream } from "@/state/logStream";

type Snapshot = {
  buffer: ReturnType<LogStream["getBuffer"]>;
  paused: boolean;
  dropCount: number;
  pendingCount: number;
  error: string | null;
  status: LogStream["status"];
};

/**
 * Subscribe a component to a LogStream's notifications. The snapshot is
 * a primitive version counter, so React's bailout works correctly — only
 * actual state changes trigger re-renders. Field-level values are read
 * fresh from the stream on each render after the version changes.
 */
export function useLogStream(stream: LogStream): Snapshot {
  const subscribe = useCallback(
    (onChange: () => void) => stream.subscribe(onChange),
    [stream],
  );
  useSyncExternalStore(subscribe, () => stream.getVersion());
  return {
    buffer: stream.getBuffer(),
    paused: stream.isPaused(),
    dropCount: stream.getDropCount(),
    pendingCount: stream.getPendingCount(),
    error: stream.errorMessage,
    status: stream.status,
  };
}
