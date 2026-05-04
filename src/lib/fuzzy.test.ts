import { describe, it, expect } from "vitest";
import { fuzzyRank } from "./fuzzy";

describe("fuzzyRank", () => {
  it("returns only matches, best first", () => {
    const out = fuzzyRank("auth", ["auth-service", "consultation-service", "lab-service", "ehr-fhir-service"]);
    expect(out[0]).toBe("auth-service");
    expect(out.includes("consultation-service")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(fuzzyRank("AUTH", ["auth-service"]).length).toBe(1);
  });
  it("returns all items for empty query", () => {
    const items = ["a", "b", "c"];
    expect(fuzzyRank("", items)).toEqual(items);
  });
});
