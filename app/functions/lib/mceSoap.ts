// Minimal hand-rolled SOAP Partner API client for Data Extension schema CRUD. Functions run in a
// sandbox with no Node built-ins (no XML DOM parser), so envelopes are built with template strings
// and faults/results are read back with small regexes rather than a real XML parser — sufficient
// for the fixed, known-shape CreateRequest/RetrieveRequest/UpdateRequest envelopes below.
//
// Every call runs in the business unit its token was issued for (see mceAuth.ts getMceToken).
import { joinUrl, type MceCreds } from './mceAuth';
import type { DeField } from './deFieldMapping';

const PARTNER_NS = 'http://exacttarget.com/wsdl/partnerAPI';

/** DataFolder ContentType values: a BU's own Data Extensions tree, and the parent BU's Shared Data Extensions tree. */
export type DeFolderContentType = 'dataextension' | 'shared_dataextension';

export const CONTENTFUL_FOLDER_NAME = 'Contentful';

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function envelope(accessToken: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PARTNER_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>${body}
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function soapRequest(creds: MceCreds, accessToken: string, soapAction: string, body: string): Promise<string> {
  const res = await fetch(joinUrl(creds.soapBaseUrl, 'Service.asmx'), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: soapAction },
    body: envelope(accessToken, body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SFMC SOAP ${soapAction} failed (${res.status}): ${text}`);
  return text;
}

function overallStatus(responseText: string): string | undefined {
  return /<OverallStatus>([^<]*)<\/OverallStatus>/.exec(responseText)?.[1];
}

function statusMessage(responseText: string): string {
  return /<StatusMessage>([^<]*)<\/StatusMessage>/.exec(responseText)?.[1] ?? responseText;
}

function fieldXml(field: DeField, isPrimaryKey: boolean): string {
  const maxLength = field.length ? `<ns:MaxLength>${field.length}</ns:MaxLength>` : '';
  return `
    <ns:Field>
      <ns:Name>${xmlEscape(field.apiName)}</ns:Name>
      <ns:FieldType>${field.fieldType}</ns:FieldType>
      ${maxLength}
      <ns:IsPrimaryKey>${isPrimaryKey}</ns:IsPrimaryKey>
      <ns:IsRequired>${isPrimaryKey}</ns:IsRequired>
    </ns:Field>`;
}

export type CreateDataExtensionResult = { ok: true } | { ok: false; statusMessage: string };

/**
 * Synchronous DE schema creation — SOAP CreateRequest returns immediately, no polling needed. A
 * Data Extension becomes a Shared Data Extension purely by being created, in the parent BU, inside
 * a `shared_dataextension` folder (`categoryId`) — there is no separate "shared" flag.
 */
export async function createDataExtension(
  creds: MceCreds,
  accessToken: string,
  params: { externalKey: string; name: string; description?: string; pkField: DeField; fields: DeField[]; categoryId?: number },
): Promise<CreateDataExtensionResult> {
  const fieldsXml = [fieldXml(params.pkField, true), ...params.fields.map((f) => fieldXml(f, false))].join('');
  const responseText = await soapRequest(
    creds,
    accessToken,
    'Create',
    `
    <ns:CreateRequest>
      <ns:Objects xsi:type="ns:DataExtension">
        <ns:CustomerKey>${xmlEscape(params.externalKey)}</ns:CustomerKey>
        <ns:Name>${xmlEscape(params.name)}</ns:Name>
        ${params.description ? `<ns:Description>${xmlEscape(params.description)}</ns:Description>` : ''}
        ${params.categoryId ? `<ns:CategoryID>${params.categoryId}</ns:CategoryID>` : ''}
        <ns:IsSendable>false</ns:IsSendable>
        <ns:IsTestable>false</ns:IsTestable>
        <ns:Fields>${fieldsXml}
        </ns:Fields>
      </ns:Objects>
    </ns:CreateRequest>`,
  );
  if (overallStatus(responseText) === 'OK') return { ok: true };
  return { ok: false, statusMessage: statusMessage(responseText) };
}

export type DataFolder = { id: number; name: string; parentId: number | null };

/** Parses DataFolder results. A folder's own `<ID>` is the one outside its nested `<ParentFolder>`/`<Client>` blocks. */
export function parseDataFolders(responseText: string): DataFolder[] {
  const blocks = responseText.match(/<Results xsi:type="DataFolder">[\s\S]*?<\/Results>/g) ?? [];
  return blocks.flatMap((block) => {
    const parentBlock = /<ParentFolder>([\s\S]*?)<\/ParentFolder>/.exec(block)?.[1] ?? '';
    const own = block.replace(/<ParentFolder>[\s\S]*?<\/ParentFolder>/, '').replace(/<Client>[\s\S]*?<\/Client>/, '');
    const id = /<ID>([^<]*)<\/ID>/.exec(own)?.[1];
    if (!id) return [];
    const parentId = /<ID>([^<]*)<\/ID>/.exec(parentBlock)?.[1];
    return [{ id: Number(id), name: /<Name>([^<]*)<\/Name>/.exec(own)?.[1] ?? '', parentId: parentId == null ? null : Number(parentId) }];
  });
}

/** Every folder of one ContentType in the token's BU. */
export async function listDataExtensionFolders(creds: MceCreds, accessToken: string, contentType: DeFolderContentType): Promise<DataFolder[]> {
  const responseText = await soapRequest(
    creds,
    accessToken,
    'Retrieve',
    `
    <ns:RetrieveRequestMsg>
      <ns:RetrieveRequest>
        <ns:ObjectType>DataFolder</ns:ObjectType>
        <ns:Properties>ID</ns:Properties>
        <ns:Properties>Name</ns:Properties>
        <ns:Properties>ParentFolder.ID</ns:Properties>
        <ns:Filter xsi:type="ns:SimpleFilterPart">
          <ns:Property>ContentType</ns:Property>
          <ns:SimpleOperator>equals</ns:SimpleOperator>
          <ns:Value>${contentType}</ns:Value>
        </ns:Filter>
      </ns:RetrieveRequest>
    </ns:RetrieveRequestMsg>`,
  );
  const status = overallStatus(responseText);
  if (status !== 'OK' && status !== 'MoreDataAvailable') throw new Error(`Listing ${contentType} folders failed: ${statusMessage(responseText)}`);
  return parseDataFolders(responseText);
}

/**
 * The top of a folder tree: the folder whose parent isn't in the same tree. For `dataextension`
 * that's "Data Extensions" (parent 0); for `shared_dataextension` it's "Shared Data Extensions",
 * whose parent is a folder of a different type.
 */
export function findRootFolder(folders: DataFolder[]): DataFolder | undefined {
  const ids = new Set(folders.map((f) => f.id));
  return folders.find((f) => f.parentId == null || !ids.has(f.parentId));
}

async function createDataExtensionFolder(
  creds: MceCreds,
  accessToken: string,
  params: { name: string; parentId: number; contentType: DeFolderContentType },
): Promise<number> {
  const responseText = await soapRequest(
    creds,
    accessToken,
    'Create',
    `
    <ns:CreateRequest>
      <ns:Objects xsi:type="ns:DataFolder">
        <ns:CustomerKey>${xmlEscape(`${params.name}_${params.contentType}`)}</ns:CustomerKey>
        <ns:Name>${xmlEscape(params.name)}</ns:Name>
        <ns:Description>Data Extensions created by the Contentful sync app.</ns:Description>
        <ns:ContentType>${params.contentType}</ns:ContentType>
        <ns:IsActive>true</ns:IsActive>
        <ns:IsEditable>true</ns:IsEditable>
        <ns:AllowChildren>true</ns:AllowChildren>
        <ns:ParentFolder>
          <ns:ID>${params.parentId}</ns:ID>
        </ns:ParentFolder>
      </ns:Objects>
    </ns:CreateRequest>`,
  );
  if (overallStatus(responseText) !== 'OK') {
    throw new Error(`Failed to create Data Extension folder "${params.name}": ${statusMessage(responseText)}`);
  }
  const newId = /<NewID>([^<]*)<\/NewID>/.exec(responseText)?.[1];
  if (!newId) throw new Error(`Data Extension folder "${params.name}" created but no NewID was returned: ${responseText}`);
  return Number(newId);
}

/**
 * Idempotently ensures a folder named `name` exists directly under the root of the `contentType`
 * tree in the token's BU, returning its ID (creating it on first call).
 */
export async function ensureDataExtensionFolder(creds: MceCreds, accessToken: string, name: string, contentType: DeFolderContentType): Promise<number> {
  const folders = await listDataExtensionFolders(creds, accessToken, contentType);
  const root = findRootFolder(folders);
  if (!root) {
    const tree = contentType === 'shared_dataextension' ? 'Shared Data Extensions' : 'Data Extensions';
    throw new Error(`Could not locate the root "${tree}" folder in this business unit.`);
  }
  const existing = folders.find((f) => f.name === name && f.parentId === root.id);
  if (existing) return existing.id;
  return createDataExtensionFolder(creds, accessToken, { name, parentId: root.id, contentType });
}

/** True if a Data Extension with this external key already exists in the token's BU. */
export async function dataExtensionExists(creds: MceCreds, accessToken: string, externalKey: string): Promise<boolean> {
  const responseText = await soapRequest(
    creds,
    accessToken,
    'Retrieve',
    `
    <ns:RetrieveRequestMsg>
      <ns:RetrieveRequest>
        <ns:ObjectType>DataExtension</ns:ObjectType>
        <ns:Properties>CustomerKey</ns:Properties>
        <ns:Filter xsi:type="ns:SimpleFilterPart">
          <ns:Property>CustomerKey</ns:Property>
          <ns:SimpleOperator>equals</ns:SimpleOperator>
          <ns:Value>${xmlEscape(externalKey)}</ns:Value>
        </ns:Filter>
      </ns:RetrieveRequest>
    </ns:RetrieveRequestMsg>`,
  );
  return /<CustomerKey>([^<]*)<\/CustomerKey>/.test(responseText);
}

/** Column names of an existing Data Extension in the token's BU. */
export async function listDataExtensionFieldNames(creds: MceCreds, accessToken: string, externalKey: string): Promise<string[]> {
  const responseText = await soapRequest(
    creds,
    accessToken,
    'Retrieve',
    `
    <ns:RetrieveRequestMsg>
      <ns:RetrieveRequest>
        <ns:ObjectType>DataExtensionField</ns:ObjectType>
        <ns:Properties>Name</ns:Properties>
        <ns:Filter xsi:type="ns:SimpleFilterPart">
          <ns:Property>DataExtension.CustomerKey</ns:Property>
          <ns:SimpleOperator>equals</ns:SimpleOperator>
          <ns:Value>${xmlEscape(externalKey)}</ns:Value>
        </ns:Filter>
      </ns:RetrieveRequest>
    </ns:RetrieveRequestMsg>`,
  );
  const status = overallStatus(responseText);
  if (status !== 'OK' && status !== 'MoreDataAvailable') throw new Error(`Reading the fields of "${externalKey}" failed: ${statusMessage(responseText)}`);
  return [...responseText.matchAll(/<Name>([^<]*)<\/Name>/g)].map((m) => m[1]);
}

/** Adds nullable columns to an existing Data Extension (SOAP UpdateRequest). Existing columns and rows are untouched. */
export async function addDataExtensionFields(
  creds: MceCreds,
  accessToken: string,
  externalKey: string,
  fields: DeField[],
): Promise<CreateDataExtensionResult> {
  const responseText = await soapRequest(
    creds,
    accessToken,
    'Update',
    `
    <ns:UpdateRequest>
      <ns:Objects xsi:type="ns:DataExtension">
        <ns:CustomerKey>${xmlEscape(externalKey)}</ns:CustomerKey>
        <ns:Fields>${fields.map((f) => fieldXml(f, false)).join('')}
        </ns:Fields>
      </ns:Objects>
    </ns:UpdateRequest>`,
  );
  if (overallStatus(responseText) === 'OK') return { ok: true };
  return { ok: false, statusMessage: statusMessage(responseText) };
}
