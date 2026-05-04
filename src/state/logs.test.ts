import { describe, it, expect, beforeEach } from "vitest";
import { useLogsStore } from "./logs";

describe("useLogsStore", () => {
  beforeEach(() => {
    useLogsStore.setState({ streams: {} });
  });

  it("appends lines and evicts oldest when capped", () => {
    const { openStream, appendLine } = useLogsStore.getState();
    openStream("s1");
    for (let i = 0; i < 10_005; i++) {
      appendLine("s1", { pod: "api-1", container: "app", text: `line ${i}` });
    }
    const buf = useLogsStore.getState().streams["s1"].buffer;
    expect(buf.length).toBe(10_000);
    expect(buf[0].text).toBe("line 5");
    expect(buf[9_999].text).toBe("line 10004");
  });

  it("assigns deterministic color per pod", () => {
    const { openStream, appendLine } = useLogsStore.getState();
    openStream("s1");
    appendLine("s1", { pod: "api-1", container: "app", text: "a" });
    appendLine("s1", { pod: "api-2", container: "app", text: "b" });
    const colors = useLogsStore.getState().streams["s1"].colorByPod;
    expect(colors["api-1"]).not.toBe(colors["api-2"]);
    expect(colors["api-1"]).toBeDefined();
  });
});
