/**
 * App Event Handler: subscribed to `Entry.publish` and `Entry.unpublish` (see
 * scripts/setup-app-definition.mjs). For an entry whose content type has an active
 * `deSyncLinkage`, upserts rows into the linked Data Extension through the Data Extension Rows
 * (Synchronous) API — full rows on publish, `IsActive=false` rows on unpublish (that API has no
 * delete, only upsert). Content types with no active linkage are skipped.
 *
 * - Rows are written with a token for the BU that owns the DE (the registry's `businessUnitMid`):
 *   for a Shared Data Extension that's the parent BU, and child BUs it's shared with see the rows.
 * - `Entry.delete`/`Entry.archive` aren't subscribed: Contentful requires an entry to be
 *   unpublished first, and that unpublish already deactivated its rows.
 * - The real `Entry.unpublish` body carries only `sys`, no `fields`, so the business key is read
 *   from the still-existing entry via the CMA.
 * - Contentful doesn't retry a failed handler, and handlers have no response value — the
 *   Function log is the only record of a failure.
 */
import type { AppEventRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import { getMceToken, joinUrl, missingCredsError, readMceCreds } from './lib/mceAuth';
import { mapEntryToDeRows, mapEntryToDeactivateRows, type ContentTypeLike, type DeField, type DeRowItem } from './lib/deFieldMapping';

type EntryFields = Record<string, Record<string, unknown>>;
type CmaEntry = { sys: { id: string }; fields?: EntryFields };
type Cma = NonNullable<FunctionEventContext['cma']>;
type Ids = { spaceId: string; environmentId: string };

type ActiveLinkage = { deExternalKey: string; businessUnitMid: string; pkContentfulFieldId: string; deFields: DeField[] };

type EventBody = {
  sys?: {
    id?: string;
    space?: { sys?: { id?: string } };
    contentType?: { sys?: { id?: string } };
    publishedVersion?: number;
    updatedAt?: string;
  };
  fields?: EntryFields;
};

/** `ContentManagement.Entry.publish` → `publish`. */
export function extractEventType(headers: Record<string, unknown> | undefined): string | null {
  const raw = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'x-contentful-topic')?.[1];
  const topic = Array.isArray(raw) ? raw[0] : raw;
  if (typeof topic !== 'string' || !topic) return null;
  return topic.split('.').pop() || null;
}

/** The registry/linkage content types' fields are all non-localized — read whatever locale holds the value. */
function value<T>(entry: CmaEntry | undefined, fieldId: string): T | undefined {
  const byLocale = entry?.fields?.[fieldId];
  if (!byLocale) return undefined;
  return Object.values(byLocale).find((v) => v != null) as T | undefined;
}

async function findActiveLinkage(cma: Cma, ids: Ids, contentTypeId: string): Promise<ActiveLinkage | null> {
  const linkages = await cma.entry.getMany({
    ...ids,
    query: { content_type: 'deSyncLinkage', 'fields.contentTypeId': contentTypeId, 'fields.isActive': true, limit: 1 },
  });
  const linkage = linkages.items[0] as unknown as CmaEntry | undefined;
  const registryId = value<{ sys: { id: string } }>(linkage, 'dataExtension')?.sys?.id;
  const pkContentfulFieldId = value<string>(linkage, 'pkContentfulFieldId');
  if (!registryId || !pkContentfulFieldId) return null;

  const registry = (await cma.entry.get({ ...ids, entryId: registryId })) as unknown as CmaEntry;
  const deExternalKey = value<string>(registry, 'deExternalKey');
  if (!deExternalKey) return null;

  const fieldMap = value<{ fields?: DeField[] }>(registry, 'fieldMap');
  return {
    deExternalKey,
    businessUnitMid: value<string>(registry, 'businessUnitMid') ?? '',
    pkContentfulFieldId,
    deFields: fieldMap?.fields ?? [],
  };
}

export const handler: FunctionEventHandler<FunctionTypeEnum.AppEventHandler> = async (event: AppEventRequest, context: FunctionEventContext) => {
  const body = event.body as EventBody;
  const entryId = body?.sys?.id;
  const contentTypeId = body?.sys?.contentType?.sys?.id;
  const eventType = extractEventType(event.headers as Record<string, unknown>);
  if (!entryId || !contentTypeId || (eventType !== 'publish' && eventType !== 'unpublish')) return;

  const creds = readMceCreds(context);
  const credsError = missingCredsError(creds, ['rest']);
  if (credsError) {
    console.error(`Data Extension sync skipped: ${credsError}`);
    return;
  }
  const cma = context.cma;
  if (!cma) {
    console.error('Data Extension sync skipped: CMA client is not available in this function context.');
    return;
  }
  const ids = { spaceId: context.spaceId, environmentId: context.environmentId };

  try {
    const linkage = await findActiveLinkage(cma, ids, contentTypeId);
    if (!linkage) return;

    const contentType = (await cma.contentType.get({ ...ids, contentTypeId })) as unknown as ContentTypeLike;

    let items: DeRowItem[];
    if (eventType === 'publish') {
      // The publish body is the published snapshot itself — no refetch needed.
      const entry = {
        sys: {
          id: entryId,
          space: { sys: { id: body.sys?.space?.sys?.id ?? context.spaceId } },
          publishedVersion: body.sys?.publishedVersion,
          updatedAt: body.sys?.updatedAt,
        },
        fields: body.fields,
      };
      items = mapEntryToDeRows(entry, contentType, linkage.deFields, linkage.pkContentfulFieldId);
    } else {
      const entry = (await cma.entry.get({ ...ids, entryId })) as unknown as CmaEntry;
      items = mapEntryToDeactivateRows(entry, contentType, linkage.pkContentfulFieldId);
    }
    if (items.length === 0) return;

    const token = await getMceToken(creds, linkage.businessUnitMid);
    const rowsetUrl = joinUrl(creds.restBaseUrl, `hub/v1/dataevents/key:${encodeURIComponent(linkage.deExternalKey)}/rowset`);
    const res = await fetch(rowsetUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    });
    if (!res.ok) throw new Error(`Rowset upsert failed (${res.status}) for DE "${linkage.deExternalKey}": ${await res.text()}`);
    const where = linkage.businessUnitMid ? `BU ${linkage.businessUnitMid}` : 'default BU';
    console.log(`Data Extension sync: upserted ${items.length} row(s) into ${linkage.deExternalKey} (${where}; ${eventType}, entry ${entryId})`);
  } catch (err) {
    console.error(`Data Extension sync failed for entry ${entryId} (${eventType}):`, (err as Error).message);
  }
};
