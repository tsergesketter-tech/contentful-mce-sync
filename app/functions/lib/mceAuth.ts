// OAuth client-credentials exchange against the target Marketing Cloud Engagement tenant, shared
// by every Function (esbuild inlines lib/ into each Function bundle separately).
//
// Business units: a token is scoped to one BU. Without `account_id` it lands in the Installed
// Package's default BU (often a child BU); with `account_id` = a MID it acts in that BU, provided
// the package has been granted access to it. Shared Data Extensions live in the parent
// (Enterprise) BU, so creating them and writing their rows needs a parent-BU token — see
// MCE_PARENT_MID and the registry's `businessUnitMid` field.
import type { FunctionEventContext } from '@contentful/node-apps-toolkit';

export type MceCreds = {
  authBaseUrl: string;
  restBaseUrl: string;
  soapBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** Parent (Enterprise) BU MID. When set, new Data Extensions are created as Shared Data Extensions there. */
  parentMid: string;
};
export type MceToken = { accessToken: string; expiresAt: number };

// Keyed by credentials + BU, never a single slot: one Function runtime can serve many app
// installations, and a token must never cross installations or business units.
const tokenCache = new Map<string, MceToken>();

export function readMceCreds(context: FunctionEventContext): MceCreds {
  const params = (context.appInstallationParameters as Record<string, string>) ?? {};
  return {
    authBaseUrl: params.MCE_AUTH_BASE_URL || process.env.MCE_AUTH_BASE_URL || '',
    restBaseUrl: params.MCE_REST_BASE_URL || process.env.MCE_REST_BASE_URL || '',
    soapBaseUrl: params.MCE_SOAP_BASE_URL || process.env.MCE_SOAP_BASE_URL || '',
    clientId: params.MCE_CLIENT_ID || process.env.MCE_CLIENT_ID || '',
    clientSecret: params.MCE_CLIENT_SECRET || process.env.MCE_CLIENT_SECRET || '',
    parentMid: String(params.MCE_PARENT_MID || process.env.MCE_PARENT_MID || '').trim(),
  };
}

/** Null when the installation has everything `needs` lists, else a message naming what's missing. */
export function missingCredsError(creds: MceCreds, needs: Array<'rest' | 'soap'>): string | null {
  const missing = [
    !creds.authBaseUrl && 'MCE_AUTH_BASE_URL',
    needs.includes('rest') && !creds.restBaseUrl && 'MCE_REST_BASE_URL',
    needs.includes('soap') && !creds.soapBaseUrl && 'MCE_SOAP_BASE_URL',
    !creds.clientId && 'MCE_CLIENT_ID',
    !creds.clientSecret && 'MCE_CLIENT_SECRET',
  ].filter(Boolean);
  return missing.length ? `Marketing Cloud Engagement is not configured on this app installation (${missing.join(', ')}).` : null;
}

/** Joins a base URL (with or without a trailing slash) to a path (with or without a leading slash). */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Token for `mid`'s business unit, or the Installed Package's default BU when `mid` is blank. */
export async function getMceToken(creds: MceCreds, mid?: string): Promise<MceToken> {
  const accountId = (mid ?? '').trim();
  const cacheKey = [creds.authBaseUrl, creds.clientId, creds.clientSecret, accountId].join('\n');
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached;

  const res = await fetch(joinUrl(creds.authBaseUrl, 'v2/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      ...(accountId ? { account_id: Number(accountId) } : {}),
    }),
  });
  if (!res.ok) {
    const where = accountId ? ` for business unit ${accountId}` : '';
    throw new Error(`Marketing Cloud Engagement OAuth failed${where} (${res.status}): ${await res.text()}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const token = { accessToken: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 1080) * 1000 };
  tokenCache.set(cacheKey, token);
  return token;
}

/** The BU a token acts in, from the auth server's userinfo endpoint. */
export async function getTokenBusinessUnit(creds: MceCreds, token: MceToken): Promise<{ memberId: number; enterpriseId: number }> {
  const res = await fetch(joinUrl(creds.authBaseUrl, 'v2/userinfo'), { headers: { Authorization: `Bearer ${token.accessToken}` } });
  if (!res.ok) throw new Error(`Marketing Cloud Engagement userinfo failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { organization?: { member_id?: number; enterprise_id?: number } };
  return { memberId: Number(json.organization?.member_id), enterpriseId: Number(json.organization?.enterprise_id) };
}
