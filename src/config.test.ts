import { describe, it, expect } from "bun:test";
import { isModelAllowlistEnabled } from "./config";

describe("isModelAllowlistEnabled", () => {
  it("defaults to disabled when the env value is unset", () => {
    expect(isModelAllowlistEnabled(undefined)).toBe(false);
  });

  it("enables only for the exact string 'true'", () => {
    expect(isModelAllowlistEnabled("true")).toBe(true);
  });

  it("disables for 'false'", () => {
    expect(isModelAllowlistEnabled("false")).toBe(false);
  });

  it("disables for unrecognized values", () => {
    expect(isModelAllowlistEnabled("1")).toBe(false);
    expect(isModelAllowlistEnabled("yes")).toBe(false);
    expect(isModelAllowlistEnabled("")).toBe(false);
  });
});