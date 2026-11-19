export interface CallbackRoute {
  secret: string;
  token: string;
}

export function parseCallbackPath(pathname: string): CallbackRoute | null {
  const match = /^\/callback\/([^/]+)\/(.+)$/.exec(pathname);
  const secretPart = match?.[1];
  const tokenPart = match?.[2];
  if (secretPart === undefined || tokenPart === undefined) return null;
  try {
    const secret = decodeURIComponent(secretPart);
    const token = decodeURIComponent(tokenPart);
    if (secret.length === 0 || token.length === 0) return null;
    return { secret, token };
  } catch {
    return null;
  }
}

export async function verifyLineSignature(input: {
  secret: string;
  body: ArrayBuffer;
  signature: string | null;
}): Promise<boolean> {
  if (input.signature === null || input.signature.length === 0) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, input.body),
  );
  return timingSafeEqual(base64Encode(mac), input.signature);
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
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
