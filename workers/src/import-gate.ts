declare global {
  interface Env {
    IMPORT_SECRET?: string;
  }
  namespace Cloudflare {
    interface Env {
      IMPORT_SECRET?: string;
    }
  }
}

export const IMPORT_SECRET_HEADER = "x-import-secret";

export function importGate(
  expected: string | undefined,
  presented: string | null,
): "disabled" | "reject" | "ok" {
  if (expected === undefined || expected.length === 0) return "disabled";
  // An empty header still runs the compare. Returning first would be faster than a wrong secret.
  return timingSafeEqual(expected, presented ?? "") ? "ok" : "reject";
}

function timingSafeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  const length = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
