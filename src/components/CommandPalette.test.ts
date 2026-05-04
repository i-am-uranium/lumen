import { describe, expect, it } from "vitest";
import { COMMAND_PALETTE_RESOURCE_KINDS } from "./CommandPalette";
import { listResourceDefinitions } from "@/lib/k8s/resourceRegistry";

describe("CommandPalette resource coverage", () => {
  it("searches every registered Kubernetes resource kind", () => {
    const registeredKinds = listResourceDefinitions().map((definition) => definition.kind);

    expect(COMMAND_PALETTE_RESOURCE_KINDS).toEqual(registeredKinds);
  });
});
