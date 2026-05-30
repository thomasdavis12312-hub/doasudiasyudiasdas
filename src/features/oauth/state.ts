import crypto from "node:crypto";

export function createDiscordOAuthState(tgId: number, secret: string): string {
  const ts = Date.now().toString();
  const payload = `${tgId}.${ts}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function parseDiscordOAuthState(state: string, secret: string): { tgId: number; valid: boolean; expired: boolean } {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 3) return { tgId: 0, valid: false, expired: false };
    const [tgIdRaw, tsRaw, sig] = parts;
    const tgId = Number(tgIdRaw);
    const ts = Number(tsRaw);
    if (!Number.isFinite(tgId) || !Number.isFinite(ts)) return { tgId: 0, valid: false, expired: false };
    const payload = `${tgIdRaw}.${tsRaw}`;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    if (expected !== sig) return { tgId, valid: false, expired: false };
    const expired = Date.now() - ts > 10 * 60 * 1000;
    return { tgId, valid: true, expired };
  } catch {
    return { tgId: 0, valid: false, expired: false };
  }
}

export function buildDiscordAuthUrl(opts: {
  tgId: number;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
}): string | null {
  const { tgId, clientId, clientSecret, redirectUri, stateSecret } = opts;
  if (!clientId || !clientSecret || !redirectUri) return null;
  const state = createDiscordOAuthState(tgId, stateSecret);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify",
    state,
    prompt: "consent",
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
