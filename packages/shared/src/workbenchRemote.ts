// URL policy adapted from T3 Code; see THIRD_PARTY_NOTICES.md.
export function normalizeSecureRelayUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !/^\/+$/u.test(url.pathname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function isSecureRelayUrl(value: string): boolean {
  return normalizeSecureRelayUrl(value) !== null;
}

/** Synara consumes one-time credentials on /pair; T3 supplies fragment handling. */
export function buildWorkbenchPairingUrl(origin: string, credential: string): string {
  const secureOrigin = normalizeSecureRelayUrl(origin);
  if (!secureOrigin) throw new Error("A root HTTPS address is required for phone pairing.");
  const next = new URL("/pair", secureOrigin);
  next.searchParams.delete("token");
  next.hash = new URLSearchParams([["token", credential]]).toString();
  return next.toString();
}
