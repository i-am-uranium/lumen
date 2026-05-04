import { describe, expect, it } from "vitest";
import { redactForAi } from "./aiRedaction";

describe("redactForAi", () => {
  it("redacts common Kubernetes and application secrets", () => {
    const result = redactForAi(`
apiVersion: v1
users:
- user:
    token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9superlongtokenvalue
env:
- name: API_KEY
  value: live_1234567890abcdef
authorization: Bearer abcdefghijklmnopqrstuvwxyz1234567890
`);

    expect(result.text).not.toContain("live_1234567890abcdef");
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    expect(result.text).toContain("<redacted>");
    expect(result.findings.length).toBeGreaterThan(0);
  });
});
