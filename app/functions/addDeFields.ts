/**
 * App Action (Custom): brings an existing Data Extension's schema up to date with a field map —
 * adds a column for every field in `deFieldsJson` the DE doesn't have yet (e.g. a field that was
 * unchecked when the DE was created, or added to the content type since). Columns are only ever
 * added, never removed or retyped: unchecking a field just stops writing it.
 *
 * Runs in the BU that owns the DE (`deMid`; the parent BU for Shared Data Extensions).
 */
import type { AppActionRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import { getMceToken, missingCredsError, readMceCreds } from './lib/mceAuth';
import { addDataExtensionFields, listDataExtensionFieldNames } from './lib/mceSoap';
import type { DeField } from './lib/deFieldMapping';

type AddFieldsBody = { deExternalKey: string; deFieldsJson: string; deMid?: string };

export const handler: FunctionEventHandler<FunctionTypeEnum.AppActionCall> = async (event: AppActionRequest, context: FunctionEventContext) => {
  const body = event.body as AddFieldsBody;
  if (!body?.deExternalKey || !body?.deFieldsJson) return { ok: false, error: 'deExternalKey and deFieldsJson are required' };

  const creds = readMceCreds(context);
  const credsError = missingCredsError(creds, ['soap']);
  if (credsError) return { ok: false, error: credsError };

  let wanted: DeField[];
  try {
    wanted = JSON.parse(body.deFieldsJson);
  } catch {
    return { ok: false, error: 'deFieldsJson was not valid JSON.' };
  }

  try {
    const token = await getMceToken(creds, body.deMid);
    const existing = new Set((await listDataExtensionFieldNames(creds, token.accessToken, body.deExternalKey)).map((n) => n.toLowerCase()));
    if (existing.size === 0) return { ok: false, error: `Data Extension "${body.deExternalKey}" was not found in this business unit.` };

    const missing = wanted.filter((f) => !existing.has(f.apiName.toLowerCase()));
    if (missing.length === 0) return { ok: true, added: [] };

    const result = await addDataExtensionFields(creds, token.accessToken, body.deExternalKey, missing);
    if (!result.ok) return { ok: false, error: `Adding fields to "${body.deExternalKey}" failed: ${result.statusMessage}` };
    return { ok: true, added: missing.map((f) => f.apiName) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};
