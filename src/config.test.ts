import { describe, it, expect } from "bun:test";
import { isModelAllowlistEnabled, loadConfig, normalizePublicUrl } from "./config";

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

describe("public URL environment precedence", () => {
  function configured(explicit?: string, cloudron?: string): string | null {
    const keys = ["ROUTSTRD_AUTH_PUBLIC_URL", "CLOUDRON_APP_ORIGIN"] as const;
    const saved = keys.map(key => process.env[key]);
    try {
      for (const [index, value] of [explicit, cloudron].entries()) {
        if (value === undefined) delete process.env[keys[index]!];
        else process.env[keys[index]!] = value;
      }
      return loadConfig().publicUrl;
    } finally {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    }
  }

  it("uses Cloudron's origin automatically", () => {
    expect(configured(undefined, "https://App.example/")).toBe("https://app.example");
  });

  it("prefers an explicit override", () => {
    expect(configured("https://custom.example", "https://app.example"))
      .toBe("https://custom.example");
  });

  it("falls back for an empty or whitespace-only override", () => {
    for (const value of ["", "  "]) {
      expect(configured(value, "https://app.example")).toBe("https://app.example");
    }
  });

  it("preserves header-derived mode outside Cloudron without an override", () => {
    expect(configured()).toBeNull();
  });

  it("rejects invalid selected configuration rather than falling back", () => {
    expect(() => configured("invalid", "https://app.example")).toThrow();
    expect(() => configured(undefined, "invalid")).toThrow();
  });
});

describe("public URL origin validation", () => {
  it("rejects paths, credentials, queries and fragments", () => {
    for (const value of [
      "https://example.com/subpath", "https://user:secret@example.com",
      "https://example.com?x=1", "https://example.com#section",
      "https://example.com?", "https://example.com#",
    ]) {
      expect(() => normalizePublicUrl(value)).toThrow();
    }
  });

  it("preserves a configured non-default port", () => {
    expect(normalizePublicUrl(" https://Example.com:8443/ "))
      .toBe("https://example.com:8443");
  });
});
