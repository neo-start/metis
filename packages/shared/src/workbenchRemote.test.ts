import { describe, expect, it } from "vitest";
import { buildWorkbenchPairingUrl, normalizeSecureRelayUrl } from "./workbenchRemote";

describe("Workbench remote URL boundary", () => {
  it.each([
    "http://example.com",
    "https://a:b@example.com",
    "https://example.com/path",
    "https://example.com/?token=secret",
    "https://example.com/#secret",
    "javascript:alert(1)",
  ])("rejects ambiguous or insecure origin %s", (url) => {
    expect(normalizeSecureRelayUrl(url)).toBeNull();
    expect(() => buildWorkbenchPairingUrl(url, "PAIRING")).toThrow();
  });
  it("places the one-time credential only in the fragment on the Synara pairing route", () => {
    const url = new URL(buildWorkbenchPairingUrl(" https://phone.example.com/ ", "A+B&C"));
    expect(url.origin).toBe("https://phone.example.com");
    expect(url.pathname).toBe("/pair");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe("A+B&C");
  });
});
