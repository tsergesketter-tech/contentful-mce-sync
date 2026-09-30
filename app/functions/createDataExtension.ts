/**
 * App Action (Custom): given a Contentful content type, derives a brand-new Data Extension
 * schema from its fields and creates it synchronously in Marketing Cloud Engagement via SOAP
 * CreateRequest. Unlike the Marketing-Object-sync app's net-new deploy (an async Salesforce
 * Metadata REST deploy needing a start/poll split), SFMC's DE schema CreateRequest returns
 * success/failure in the same SOAP response — no polling counterpart is needed.
 */
import type { AppActionRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import { readMceCreds, getMceToken } from './lib/mceAuth';
import { createDataExtension as soapCreateDataExtension, dataExtensionExists } from './lib/mceSoap';
import {
  PK_FIELD,
  FIXED_FIELDS,
  deriveDeFieldsFromContentType,
  deriveDeExternalKey,
  sanitizeApiNameBase,
  type DeField,
} from './lib/deFieldMapping';

type StartCreateBody = {
  contentTypeId: string;
  deExternalKey?: string;
  deLabel?: string;
  excludedFieldIds?: string;
  extraFieldLabels?: string;
};

const MAX_NAME_ATTEMPTS = 20;

export const handler: FunctionEventHandler<FunctionTypeEnum.AppActionCall> = async (
  event: AppActionRequest,
  context: FunctionEventContext
) => {
  const body = event.body as StartCreateBody;
  if (!body?.contentTypeId) {
    return { ok: false, error: 'contentTypeId is required' };
  }

  const creds = readMceCreds(context);
  if (!creds.authBaseUrl || !creds.soapBaseUrl || !creds.clientId || !creds.clientSecret) {
    return {
      ok: false,
      error: 'Marketing Cloud Engagement credentials are not configured on this app installation.',
    };
  }

  const cma = context.cma;
  if (!cma) return { ok: false, error: 'CMA client is not available in this function context.' };

  let contentType;
  try {
    contentType = await cma.contentType.get({
      spaceId: context.spaceId,
      environmentId: context.environmentId,
      contentTypeId: body.contentTypeId,
    });
  } catch (err) {
    return { ok: false, error: `Failed to load content type "${body.contentTypeId}": ${(err as Error).message}` };
  }

  const excludedFieldIds = (body.excludedFieldIds || '').split(',').map((s) => s.trim()).filter(Boolean);
  const fixedApiNames = new Set(FIXED_FIELDS.map((f) => f.apiName));
  const derivedFields = deriveDeFieldsFromContentType(contentType as any, excludedFieldIds).filter(
    (f) => !fixedApiNames.has(f.apiName)
  );

  const extraLabels = (body.extraFieldLabels || '').split(',').map((s) => s.trim()).filter(Boolean);
  const usedApiNames = new Set([...fixedApiNames, ...derivedFields.map((f) => f.apiName)]);
  const extraFields: DeField[] = [];
  for (const label of extraLabels) {
    let apiName = sanitizeApiNameBase(label);
    let n = 2;
    while (usedApiNames.has(apiName)) {
      apiName = `${sanitizeApiNameBase(label)}${n++}`;
    }
    usedApiNames.add(apiName);
    extraFields.push({ apiName, label, fieldType: 'Text', length: 4000 });
  }

  // FIXED_FIELDS are the sync bookkeeping columns mapEntryToDeRows always writes (ContentfulEntryId,
  // IsActive, etc.) — every net-new DE needs them created up front, not just the content-type-derived ones.
  const allFields = [...FIXED_FIELDS, ...derivedFields, ...extraFields];
  const deLabel = body.deLabel?.trim() || contentType.name;

  let token;
  try {
    token = await getMceToken(creds);
  } catch (err) {
    return { ok: false, error: `Marketing Cloud Engagement auth failed: ${(err as Error).message}` };
  }

  // If the caller already picked an explicit external key (e.g. retrying after a conflict), use it
  // as-is. Otherwise auto-avoid any external key that's currently taken in the tenant.
  const requestedExternalKey = body.deExternalKey?.trim() || deriveDeExternalKey(body.contentTypeId);
  let externalKey = requestedExternalKey;
  if (!body.deExternalKey?.trim()) {
    let suffix = 2;
    let attempts = 0;
    while (await dataExtensionExists(creds, token.accessToken, externalKey)) {
      attempts += 1;
      if (attempts > MAX_NAME_ATTEMPTS) {
        return {
          ok: false,
          error: `Could not find an available Data Extension external key after ${MAX_NAME_ATTEMPTS} attempts starting from "${requestedExternalKey}".`,
        };
      }
      externalKey = `${requestedExternalKey}${suffix}`;
      suffix += 1;
    }
  }

  const result = await soapCreateDataExtension(creds, token.accessToken, {
    externalKey,
    name: externalKey,
    description: `Synced from Contentful content type "${body.contentTypeId}".`,
    pkField: PK_FIELD,
    fields: allFields,
  });

  if (!result.ok) {
    return { ok: false, error: `Data Extension creation failed: ${result.statusMessage}` };
  }

  return {
    ok: true,
    deExternalKey: externalKey,
    deLabel,
    pkFieldApiName: PK_FIELD.apiName,
    fields: allFields,
    excludedFieldIds,
  };
};
