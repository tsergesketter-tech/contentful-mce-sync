/**
 * App Action (Custom): given a Contentful content type, derives a brand-new Data Extension
 * schema from its fields and creates it synchronously in Marketing Cloud Engagement via SOAP
 * CreateRequest. Unlike the Marketing-Object-sync app's net-new deploy (an async Salesforce
 * Metadata REST deploy needing a start/poll split), SFMC's DE schema CreateRequest returns
 * success/failure in the same SOAP response — no polling counterpart is needed.
 *
 * Placement: when MCE_PARENT_MID is configured, the DE is created with a parent-BU token inside
 * Shared Data Extensions › Contentful, which makes it a Shared Data Extension that the parent can
 * share to child BUs (sharing itself is configured in the Marketing Cloud UI). Otherwise it's a
 * regular DE in the Installed Package's default BU, under Data Extensions › Contentful.
 */
import type { AppActionRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import { readMceCreds, getMceToken, missingCredsError } from './lib/mceAuth';
import {
  CONTENTFUL_FOLDER_NAME,
  createDataExtension as soapCreateDataExtension,
  dataExtensionExists,
  ensureDataExtensionFolder,
} from './lib/mceSoap';
import {
  PK_FIELD,
  FIXED_FIELDS,
  deriveDeFieldsFromContentType,
  deriveDeExternalKey,
  sanitizeApiNameBase,
  type ContentTypeLike,
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
  const credsError = missingCredsError(creds, ['soap']);
  if (credsError) return { ok: false, error: credsError };
  const isShared = Boolean(creds.parentMid);

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
  const derivedFields = deriveDeFieldsFromContentType(contentType as unknown as ContentTypeLike, excludedFieldIds).filter(
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
    token = await getMceToken(creds, creds.parentMid);
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

  let categoryId: number | undefined;
  if (isShared) {
    // Not cosmetic here: outside a shared_dataextension folder the DE would silently be a plain
    // parent-BU DE that child BUs can't see, so fail instead of falling back.
    try {
      categoryId = await ensureDataExtensionFolder(creds, token.accessToken, CONTENTFUL_FOLDER_NAME, 'shared_dataextension');
    } catch (err) {
      return { ok: false, error: `Could not prepare the Shared Data Extensions folder in parent BU ${creds.parentMid}: ${(err as Error).message}` };
    }
  } else {
    try {
      categoryId = await ensureDataExtensionFolder(creds, token.accessToken, CONTENTFUL_FOLDER_NAME, 'dataextension');
    } catch {
      // Folder placement is cosmetic — fall back to the account default rather than failing the sync.
    }
  }

  const result = await soapCreateDataExtension(creds, token.accessToken, {
    externalKey,
    name: externalKey,
    description: `Synced from Contentful content type "${body.contentTypeId}".`,
    pkField: PK_FIELD,
    fields: allFields,
    categoryId,
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
    businessUnitMid: creds.parentMid,
    isShared,
  };
};
