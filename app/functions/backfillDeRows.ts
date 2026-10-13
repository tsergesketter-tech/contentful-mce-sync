/**
 * App Action (Custom): the first time a content type is linked to a Data Extension (net-new or an
 * existing DE), copy every already-published entry over too — not just entries published after the
 * link exists. Fetches every published entry of the content type via the CMA (already available on
 * `context.cma`, no CDA token needed), maps each to DE row-upsert items with the same
 * mapEntryToDeRows used by the runtime sync path, and POSTs them in chunks to the Data Extension
 * Rows (Synchronous) rowset endpoint. Rows are written with a token for the BU that owns the DE
 * (`deMid`) — for a Shared Data Extension that's the parent BU.
 *
 * Unlike the Marketing-Object-sync app's backfill (an async Bulk API 2.0 job needing a start/poll
 * split), this REST endpoint is genuinely synchronous — the whole backfill runs to completion in
 * one App Action call. Very large content types (many thousands of published entries) could still
 * hit the Function's own execution timeout; that's a known limitation of this simplification, not
 * addressed here.
 */
import type { AppActionRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import { readMceCreds, getMceToken, joinUrl, missingCredsError } from './lib/mceAuth';
import { mapEntryToDeRows, type ContentTypeLike, type DeField, type DeRowItem } from './lib/deFieldMapping';

const PAGE_SIZE = 100;
const ROWS_PER_BATCH = 500;

type StartBackfillBody = {
  contentTypeId: string;
  deExternalKey: string;
  pkContentfulFieldId: string;
  deFieldsJson?: string;
  /** MID of the BU that owns the DE (the parent BU for Shared DEs); blank = the package's default BU. */
  deMid?: string;
};

export const handler: FunctionEventHandler<FunctionTypeEnum.AppActionCall> = async (
  event: AppActionRequest,
  context: FunctionEventContext
) => {
  const body = event.body as StartBackfillBody;
  if (!body?.contentTypeId || !body?.deExternalKey || !body?.pkContentfulFieldId) {
    return { ok: false, error: 'contentTypeId, deExternalKey and pkContentfulFieldId are required' };
  }

  const creds = readMceCreds(context);
  const credsError = missingCredsError(creds, ['rest']);
  if (credsError) return { ok: false, error: credsError };

  const cma = context.cma;
  if (!cma) return { ok: false, error: 'CMA client is not available in this function context.' };

  let deFields: DeField[] = [];
  try {
    deFields = body.deFieldsJson ? JSON.parse(body.deFieldsJson) : [];
  } catch {
    return { ok: false, error: 'deFieldsJson was not valid JSON.' };
  }

  let contentType: ContentTypeLike;
  try {
    contentType = (await cma.contentType.get({
      spaceId: context.spaceId,
      environmentId: context.environmentId,
      contentTypeId: body.contentTypeId,
    })) as unknown as ContentTypeLike;
  } catch (err) {
    return { ok: false, error: `Failed to load content type "${body.contentTypeId}": ${(err as Error).message}` };
  }

  const items: DeRowItem[] = [];
  let totalEntries = 0;
  let skip = 0;
  while (true) {
    const page = await cma.entry.getMany({
      spaceId: context.spaceId,
      environmentId: context.environmentId,
      query: { content_type: body.contentTypeId, limit: PAGE_SIZE, skip },
    });
    for (const entry of page.items) {
      if (entry.sys.publishedVersion == null) continue; // draft-only entries have nothing live to copy
      totalEntries += 1;
      items.push(...mapEntryToDeRows(entry as unknown as Parameters<typeof mapEntryToDeRows>[0], contentType, deFields, body.pkContentfulFieldId));
    }
    if (page.items.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  if (items.length === 0) {
    return { ok: true, totalEntries, totalRows: 0, processed: 0, message: 'No published entries to copy.' };
  }

  let token;
  try {
    token = await getMceToken(creds, body.deMid);
  } catch (err) {
    return { ok: false, error: `Marketing Cloud Engagement auth failed: ${(err as Error).message}` };
  }

  const rowsetUrl = joinUrl(creds.restBaseUrl, `hub/v1/dataevents/key:${encodeURIComponent(body.deExternalKey)}/rowset`);
  let processed = 0;
  for (let i = 0; i < items.length; i += ROWS_PER_BATCH) {
    const chunk = items.slice(i, i + ROWS_PER_BATCH);
    const res = await fetch(rowsetUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `Rowset upsert failed (${res.status}) at batch ${i / ROWS_PER_BATCH + 1}: ${await res.text()}`,
        totalEntries,
        totalRows: items.length,
        processed,
      };
    }
    processed += chunk.length;
  }

  return { ok: true, totalEntries, totalRows: items.length, processed };
};
