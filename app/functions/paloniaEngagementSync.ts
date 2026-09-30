/**
 * App Event Handler function: fires on Entry.publish/unpublish/delete for every entry in the
 * space (the AppEventSubscription is topic-scoped, not content-type-scoped). Routing to a
 * specific Data Extension is entirely registry-driven — see `syncDataExtensionGeneric` below,
 * which looks up the active `deSyncLinkage` entry for the entry's content type and skips anything
 * that isn't linked. Runs inside Contentful's infrastructure — there is no public inbound
 * endpoint, so no request-signature verification is needed here.
 *
 * Mirrors the Marketing-Object-sync app's paloniaPublishSync.ts, minus its legacy Platform-Event
 * pathway (not ported to this app — every install here goes through the registry-driven Data
 * Extension pathway). Unpublish/delete are handled as a soft-deactivate upsert (IsActive=false)
 * rather than a true row delete, matching that app's own convention — the Data Extension Rows
 * (Synchronous) API has no delete operation, only upsert, so this is also the only option.
 */
import type {
  FunctionEventHandler,
  FunctionTypeEnum,
  AppEventRequest,
  FunctionEventContext,
} from '@contentful/node-apps-toolkit';

type MceCreds = {
  authBaseUrl: string;
  restBaseUrl: string;
  clientId: string;
  clientSecret: string;
};

type CachedToken = { accessToken: string; expiresAt: number };

let cachedToken: CachedToken | null = null;

type CfParams = {
  cfSpaceId: string;
  cfEnvironmentId: string;
  cfCdaToken: string;
  mceAuthBaseUrl: string;
  mceRestBaseUrl: string;
  mceClientId: string;
  mceClientSecret: string;
};

function readCfParams(context: FunctionEventContext): CfParams {
  const params = (context.appInstallationParameters as Record<string, string>) ?? {};
  return {
    cfSpaceId: params.CF_SPACE_ID || process.env.CF_SPACE_ID || '',
    cfEnvironmentId: params.CF_ENVIRONMENT_ID || process.env.CF_ENVIRONMENT_ID || 'master',
    cfCdaToken: params.CF_CDA_TOKEN || process.env.CF_CDA_TOKEN || '',
    mceAuthBaseUrl: params.MCE_AUTH_BASE_URL || process.env.MCE_AUTH_BASE_URL || '',
    mceRestBaseUrl: params.MCE_REST_BASE_URL || process.env.MCE_REST_BASE_URL || '',
    mceClientId: params.MCE_CLIENT_ID || process.env.MCE_CLIENT_ID || '',
    mceClientSecret: params.MCE_CLIENT_SECRET || process.env.MCE_CLIENT_SECRET || '',
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function cdaGet(params: CfParams, pathSuffix: string): Promise<any> {
  const url = `https://cdn.contentful.com/spaces/${params.cfSpaceId}/environments/${params.cfEnvironmentId}${pathSuffix}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${params.cfCdaToken}` } });
  if (!res.ok) throw new Error(`Contentful CDA ${res.status} for ${pathSuffix}: ${await res.text()}`);
  return res.json();
}

function firstNonLocalizedValue(fields: any, fieldId: string): string | null {
  const byLocale = fields?.[fieldId];
  if (!byLocale) return null;
  const val = Object.values(byLocale).find((v) => v != null);
  return val == null ? null : String(val);
}

function localizedValue(fields: any, fieldId: string, locale: string): string | null {
  const byLocale = fields?.[fieldId];
  if (!byLocale) return null;
  const val = byLocale[locale];
  return val == null ? null : String(val);
}

async function getMceToken(creds: MceCreds): Promise<CachedToken> {
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
  cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 1080) * 1000 };
  return cachedToken;
}

// Classic Contentful webhooks send `X-Contentful-Topic: ContentManagement.Entry.publish` — App
// Events carry the same header shape.
function extractEventType(headers: Record<string, string | string[] | undefined> | undefined): string {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'x-contentful-topic');
  const raw = entry?.[1];
  const topic = Array.isArray(raw) ? raw[0] : raw;
  if (!topic) return 'publish';
  const parts = topic.split('.');
  return parts[parts.length - 1] || 'publish';
}

// --- Data Extension pathway (registry-driven, any linked content type) ------------------------

const ENTRY_ID_SENTINEL = '__entryId';
const PK_API_NAME = 'ExternalKey';

type GenericDeField = { apiName: string; contentfulFieldId?: string };

type ActiveLinkage = {
  deExternalKey: string;
  pkContentfulFieldId: string;
  deFields: GenericDeField[];
};

/** Looks up the active deSyncLinkage entry for a content type and resolves its linked DE registry entry. */
async function findActiveLinkage(params: CfParams, contentTypeId: string): Promise<ActiveLinkage | null> {
  const resp = await cdaGet(
    params,
    `/entries?content_type=deSyncLinkage&fields.contentTypeId=${encodeURIComponent(contentTypeId)}&fields.isActive=true&include=1&limit=1`
  );
  const linkageEntry = resp.items?.[0];
  if (!linkageEntry) return null;

  const deId = linkageEntry.fields?.dataExtension?.sys?.id;
  const registryEntry = (resp.includes?.Entry || []).find((e: any) => e.sys.id === deId);
  if (!registryEntry) return null;

  const deExternalKey = registryEntry.fields?.deExternalKey;
  const pkContentfulFieldId = linkageEntry.fields?.pkContentfulFieldId;
  if (!deExternalKey || !pkContentfulFieldId) return null;

  return {
    deExternalKey,
    pkContentfulFieldId,
    deFields: (registryEntry.fields?.fieldMap?.fields || []) as GenericDeField[],
  };
}

function genericLocalesOf(entry: any, contentType: any): string[] {
  const byDisplayField = entry.fields?.[contentType.displayField];
  if (byDisplayField && Object.keys(byDisplayField).length > 0) return Object.keys(byDisplayField);

  const locales = new Set<string>();
  for (const value of Object.values(entry.fields || {})) {
    if (value && typeof value === 'object') Object.keys(value as object).forEach((l) => locales.add(l));
  }
  if (locales.size === 0) {
    throw new Error(`Entry ${entry.sys?.id} has no field values — cannot derive locale set.`);
  }
  return Array.from(locales);
}

type DeRowItem = { keys: Record<string, unknown>; values: Record<string, unknown> };

function genericMapEntryToDeRows(
  entry: any,
  contentType: any,
  deFields: GenericDeField[],
  pkContentfulFieldId: string
): DeRowItem[] {
  const fields = entry.fields || {};
  const pkFieldDef =
    pkContentfulFieldId === ENTRY_ID_SENTINEL ? null : contentType.fields.find((f: any) => f.id === pkContentfulFieldId);

  const items: DeRowItem[] = [];
  for (const locale of genericLocalesOf(entry, contentType)) {
    const businessKey =
      pkContentfulFieldId === ENTRY_ID_SENTINEL
        ? entry.sys.id
        : pkFieldDef?.localized
        ? localizedValue(fields, pkContentfulFieldId, locale)
        : firstNonLocalizedValue(fields, pkContentfulFieldId);

    const values: Record<string, unknown> = {
      ContentfulEntryId: entry.sys.id,
      ContentfulSpaceId: entry.sys.space.sys.id,
      ContentTypeId: contentType.sys.id,
      Locale: locale,
      ContentVersion: String(entry.sys.publishedVersion ?? ''),
      PublishedAt: entry.sys.updatedAt ?? '',
      IsActive: true,
      SourceSystem: 'Contentful',
    };
    for (const f of deFields) {
      if (!f.contentfulFieldId) continue;
      const fieldDef = contentType.fields.find((cf: any) => cf.id === f.contentfulFieldId);
      // RichText fields have no generic plaintext serialization — writing String(richTextDocument)
      // would produce "[object Object]". deriveDeFieldsFromContentType excludes them going forward;
      // this guards registry entries created before that fix.
      if (fieldDef?.type === 'RichText') continue;
      values[f.apiName] = fieldDef?.localized
        ? localizedValue(fields, f.contentfulFieldId, locale)
        : firstNonLocalizedValue(fields, f.contentfulFieldId);
    }
    items.push({ keys: { [PK_API_NAME]: `${businessKey}__${locale}` }, values });
  }
  return items;
}

function genericMapDeactivateRowsFromBody(
  bodyFields: Record<string, Record<string, unknown>> | undefined,
  contentType: any,
  pkContentfulFieldId: string,
  entryId: string
): DeRowItem[] {
  const displayLocales = bodyFields?.[contentType.displayField];
  const locales = displayLocales ? Object.keys(displayLocales) : [];
  if (locales.length === 0) return [];

  return locales.map((locale) => {
    const businessKey =
      pkContentfulFieldId === ENTRY_ID_SENTINEL ? entryId : firstNonLocalizedValue(bodyFields, pkContentfulFieldId) ?? entryId;
    return { keys: { [PK_API_NAME]: `${businessKey}__${locale}` }, values: { IsActive: false } };
  });
}

/**
 * Runs the Data Extension pathway for one event, routed via the content type's active
 * deSyncLinkage entry (works for any content type linked through the app's Page UI). Content
 * types with no active linkage entry are skipped — see findActiveLinkage above.
 */
async function syncDataExtensionGeneric(
  context: FunctionEventContext,
  contentTypeId: string,
  entryId: string,
  eventType: string,
  bodyFields: Record<string, Record<string, unknown>> | undefined
): Promise<void> {
  const params = readCfParams(context);
  if (!params.cfSpaceId || !params.cfCdaToken || !params.mceClientId || !params.mceClientSecret) {
    console.error('Data Extension sync skipped: CF_SPACE_ID/CF_CDA_TOKEN/MCE_CLIENT_ID/MCE_CLIENT_SECRET not configured.');
    return;
  }

  const linkage = await findActiveLinkage(params, contentTypeId);
  if (!linkage) {
    console.log(`Data Extension sync: no active deSyncLinkage for content type "${contentTypeId}" — skipping.`);
    return;
  }

  let items: DeRowItem[];
  if (eventType === 'publish') {
    const [entry, contentType] = await Promise.all([
      cdaGet(params, `/entries/${encodeURIComponent(entryId)}?locale=*&include=2`),
      cdaGet(params, `/content_types/${encodeURIComponent(contentTypeId)}`),
    ]);
    items = genericMapEntryToDeRows(entry, contentType, linkage.deFields, linkage.pkContentfulFieldId);
  } else {
    const contentType = await cdaGet(params, `/content_types/${encodeURIComponent(contentTypeId)}`);
    items = genericMapDeactivateRowsFromBody(bodyFields, contentType, linkage.pkContentfulFieldId, entryId);
  }

  if (items.length === 0) {
    console.log(`Data Extension sync: nothing to upsert for entry ${entryId} (eventType=${eventType}).`);
    return;
  }

  const mceCreds: MceCreds = {
    authBaseUrl: params.mceAuthBaseUrl,
    restBaseUrl: params.mceRestBaseUrl,
    clientId: params.mceClientId,
    clientSecret: params.mceClientSecret,
  };
  const token = await getMceToken(mceCreds);
  const rowsetUrl = joinUrl(params.mceRestBaseUrl, `hub/v1/dataevents/key:${encodeURIComponent(linkage.deExternalKey)}/rowset`);
  const res = await fetch(rowsetUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  });
  if (!res.ok) {
    throw new Error(`Rowset upsert failed (${res.status}) for DE "${linkage.deExternalKey}": ${await res.text()}`);
  }
  console.log(
    `Data Extension sync: upserted ${items.length} row(s) into ${linkage.deExternalKey} (entry ${entryId}, eventType=${eventType}).`
  );
}

export const handler: FunctionEventHandler<FunctionTypeEnum.AppEventHandler> = async (
  event: AppEventRequest,
  context: FunctionEventContext
) => {
  const body = event.body as {
    sys?: {
      id?: string;
      contentType?: { sys?: { id?: string } };
    };
    fields?: Record<string, Record<string, unknown>>;
  };

  const contentTypeId = body?.sys?.contentType?.sys?.id;
  const entryId = body?.sys?.id;
  if (!contentTypeId || !entryId) {
    console.log('skipped: event body missing content type or entry id');
    return;
  }

  const eventType = extractEventType(event.headers as Record<string, string | string[] | undefined>);

  try {
    await syncDataExtensionGeneric(context, contentTypeId, entryId, eventType, body?.fields);
  } catch (err) {
    console.error('Data Extension sync failed', (err as Error).message);
  }

  return;
};
