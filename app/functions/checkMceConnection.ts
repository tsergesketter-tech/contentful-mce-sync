/**
 * App Action (Custom), read-only: verifies the installation's Marketing Cloud Engagement setup and
 * reports where new Data Extensions will be created. Called by the ConfigScreen after save.
 *
 * - Always: a token for the Installed Package's default BU, and which BU/enterprise that is.
 * - With MCE_PARENT_MID: a token for that BU, that it really is the parent (Enterprise) BU, and
 *   that its Shared Data Extensions folder tree is reachable. Nothing is created.
 */
import type { AppActionRequest, FunctionEventContext, FunctionEventHandler, FunctionTypeEnum } from '@contentful/node-apps-toolkit';
import { getMceToken, getTokenBusinessUnit, missingCredsError, readMceCreds } from './lib/mceAuth';
import { CONTENTFUL_FOLDER_NAME, findRootFolder, listDataExtensionFolders } from './lib/mceSoap';

export const handler: FunctionEventHandler<FunctionTypeEnum.AppActionCall> = async (_event: AppActionRequest, context: FunctionEventContext) => {
  const creds = readMceCreds(context);
  const credsError = missingCredsError(creds, ['rest', 'soap']);
  if (credsError) return { ok: false, error: credsError };

  let defaultBu;
  try {
    defaultBu = await getTokenBusinessUnit(creds, await getMceToken(creds));
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  if (!creds.parentMid) {
    return {
      ok: true,
      defaultMid: String(defaultBu.memberId),
      enterpriseId: String(defaultBu.enterpriseId),
      target: 'default',
      message: `Connected. New Data Extensions will be created in BU ${defaultBu.memberId} (not shared). Set the Parent BU MID to create Shared Data Extensions instead.`,
    };
  }

  let parentToken;
  try {
    parentToken = await getMceToken(creds, creds.parentMid);
  } catch (err) {
    return {
      ok: false,
      error: `${(err as Error).message} — check that the Installed Package has access to the parent BU (${creds.parentMid}).`,
    };
  }
  const parentBu = await getTokenBusinessUnit(creds, parentToken);
  if (parentBu.memberId !== parentBu.enterpriseId) {
    return {
      ok: false,
      error: `BU ${creds.parentMid} is not the parent (Enterprise) BU of this account — that's ${parentBu.enterpriseId}. Shared Data Extensions can only be created in the parent BU.`,
    };
  }

  try {
    const folders = await listDataExtensionFolders(creds, parentToken.accessToken, 'shared_dataextension');
    const root = findRootFolder(folders);
    if (!root) return { ok: false, error: `No Shared Data Extensions folder was found in parent BU ${creds.parentMid}.` };
    const contentfulFolder = folders.find((f) => f.name === CONTENTFUL_FOLDER_NAME && f.parentId === root.id);
    return {
      ok: true,
      defaultMid: String(defaultBu.memberId),
      enterpriseId: String(parentBu.enterpriseId),
      target: 'shared',
      sharedFolderExists: Boolean(contentfulFolder),
      message:
        `Connected. New Data Extensions will be created as Shared Data Extensions in parent BU ${creds.parentMid}, ` +
        `under ${root.name} › ${CONTENTFUL_FOLDER_NAME}${contentfulFolder ? '' : ' (created on first use)'}.`,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};
