// OAuth client-credentials exchange against the target Marketing Cloud Engagement tenant, shared
// by the two App Action functions. ../paloniaEngagementSync.ts duplicates this same logic rather
// than importing it, since Contentful bundles each Function independently.
import type { FunctionEventContext } from '@contentful/node-apps-toolkit';

export type MceCreds = {
  authBaseUrl: string;
  restBaseUrl: string;
  soapBaseUrl: string;
  clientId: string;
  clientSecret: string;
};
export type MceToken = { accessToken: string; expiresAt: number };

let cachedToken: MceToken | null = null;

export function readMceCreds(context: FunctionEventContext): MceCreds {
  const params = (context.appInstallationParameters as Record<string, string>) ?? {};
  return {
    authBaseUrl: params.MCE_AUTH_BASE_URL || process.env.MCE_AUTH_BASE_URL || '',
    restBaseUrl: params.MCE_REST_BASE_URL || process.env.MCE_REST_BASE_URL || '',
    soapBaseUrl: params.MCE_SOAP_BASE_URL || process.env.MCE_SOAP_BASE_URL || '',
    clientId: params.MCE_CLIENT_ID || process.env.MCE_CLIENT_ID || '',
    clientSecret: params.MCE_CLIENT_SECRET || process.env.MCE_CLIENT_SECRET || '',
  };
}

/** Joins a base URL (with or without a trailing slash) to a path (with or without a leading slash). */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export async function getMceToken(creds: MceCreds): Promise<MceToken> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken;

  const res = await fetch(joinUrl(creds.authBaseUrl, 'v2/token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`Marketing Cloud Engagement OAuth failed (${res.status}): ${await res.text()}`);

  const json = (await res.json()) as { access_token: string; expires_in?: number };
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (Number(json.expires_in) || 1080) * 1000,
  };
  return cachedToken;
}
