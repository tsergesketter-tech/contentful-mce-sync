// Shared App Action invocation helper for every location (Page, ConfigScreen).
import type { CMAClient } from '@contentful/app-sdk';

export type AppActionIds = { spaceId: string; environmentId: string; appDefinitionId: string };

/**
 * Every App Action in this app returns `{ ok: true, ...data }` or `{ ok: false, error }`. `T` is the
 * success payload — asserted, not validated: it mirrors the Function's return statement by hand.
 */
export type AppActionResult<T extends object = object> = ({ ok: true; error?: undefined } & T) | { ok: false; error?: string };

// Success payloads, mirroring each Function's `return { ok: true, ... }`.
export type DeFieldSpec = { apiName: string; label: string; fieldType: string; length?: number; contentfulFieldId?: string };
export type CreateDataExtensionResult = {
  deExternalKey: string;
  deLabel: string;
  pkFieldApiName: string;
  fields: DeFieldSpec[];
  excludedFieldIds: string[];
  /** MID of the BU the DE was created in; blank = the package's default BU. */
  businessUnitMid: string;
  isShared: boolean;
};
export type BackfillResult = { totalEntries: number; totalRows: number; processed: number; message?: string };
export type CheckConnectionResult = {
  defaultMid: string;
  enterpriseId: string;
  target: 'default' | 'shared';
  sharedFolderExists?: boolean;
  message: string;
};

// contentful-management polls for the Function's response only 10x2s (~20s) by default, then
// throws TIMEOUT_MESSAGE. A cold start plus a slow Marketing Cloud response can exceed that, and a
// backfill of many entries takes longer still — give it ~60s instead.
const RESPONSE_RETRIES = 30;
const RESPONSE_RETRY_INTERVAL_MS = 2000;
const TIMEOUT_MESSAGE = 'taking longer than expected';

export type CallAppActionOptions = {
  /**
   * Safe to re-invoke (read-only, e.g. checkMceConnection): on a response timeout the whole call
   * is retried once. Never set this for createDataExtension/backfillDeRows — a retry would create
   * a second DE or re-run the backfill.
   */
  idempotent?: boolean;
};

/** Invokes an App Action and waits for its Function's response (polling is done by the CMA client). */
export async function callAppAction<T extends object = object>(
  cma: CMAClient,
  ids: AppActionIds,
  appActionId: string,
  parameters: Record<string, unknown>,
  options: CallAppActionOptions = {},
): Promise<AppActionResult<T>> {
  // retries/retryInterval are read at runtime but missing from the plain client's param type.
  const params = { ...ids, appActionId, retries: RESPONSE_RETRIES, retryInterval: RESPONSE_RETRY_INTERVAL_MS };
  let details;
  try {
    details = await cma.appActionCall.createWithResponse(params, { parameters });
  } catch (err) {
    if (!options.idempotent || !(err as Error)?.message?.includes(TIMEOUT_MESSAGE)) throw err;
    details = await cma.appActionCall.createWithResponse(params, { parameters });
  }
  const statusCode = details.response?.statusCode;
  const rawBody = details.response?.body;
  let body: unknown = rawBody;
  if (typeof rawBody === 'string') {
    try {
      body = JSON.parse(rawBody);
    } catch {
      // leave as raw string
    }
  }
  if (statusCode && statusCode >= 400) {
    throw new Error(`${appActionId} failed (${statusCode}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  if (!body || typeof body !== 'object') {
    throw new Error(`${appActionId} returned an unexpected response.`);
  }
  return body as AppActionResult<T>;
}
