// Minimal hand-rolled SOAP Partner API client for Data Extension schema CRUD. Functions run in a
// sandbox with no Node built-ins (no XML DOM parser), so envelopes are built with template strings
// and faults/results are read back with small regexes rather than a real XML parser — sufficient
// for the fixed, known-shape CreateRequest/RetrieveRequest/DeleteRequest envelopes below.
import { joinUrl, type MceCreds } from './mceAuth';
import type { DeField } from './deFieldMapping';

const PARTNER_NS = 'http://exacttarget.com/wsdl/partnerAPI';

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function soapRequest(creds: MceCreds, accessToken: string, soapAction: string, envelope: string): Promise<string> {
  const res = await fetch(joinUrl(creds.soapBaseUrl, 'Service.asmx'), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', SOAPAction: soapAction },
    body: envelope,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SFMC SOAP ${soapAction} failed (${res.status}): ${text}`);
  return text;
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

/** Synchronous DE schema creation — SOAP CreateRequest returns immediately, no polling needed. */
export async function createDataExtension(
  creds: MceCreds,
  accessToken: string,
  params: { externalKey: string; name: string; description?: string; pkField: DeField; fields: DeField[]; categoryId?: number }
): Promise<CreateDataExtensionResult> {
  const fieldsXml = [fieldXml(params.pkField, true), ...params.fields.map((f) => fieldXml(f, false))].join('');
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PARTNER_NS}">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    <ns:CreateRequest>
      <ns:Objects xsi:type="ns:DataExtension" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <ns:CustomerKey>${xmlEscape(params.externalKey)}</ns:CustomerKey>
        <ns:Name>${xmlEscape(params.name)}</ns:Name>
        ${params.description ? `<ns:Description>${xmlEscape(params.description)}</ns:Description>` : ''}
        ${params.categoryId ? `<ns:CategoryID>${params.categoryId}</ns:CategoryID>` : ''}
        <ns:IsSendable>false</ns:IsSendable>
        <ns:IsTestable>false</ns:IsTestable>
        <ns:Fields>${fieldsXml}
        </ns:Fields>
      </ns:Objects>
    </ns:CreateRequest>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await soapRequest(creds, accessToken, 'Create', envelope);
  const overallStatus = /<OverallStatus>([^<]*)<\/OverallStatus>/.exec(responseText)?.[1];
  const statusMessage = /<StatusMessage>([^<]*)<\/StatusMessage>/.exec(responseText)?.[1] ?? responseText;
  if (overallStatus === 'OK') return { ok: true };
  return { ok: false, statusMessage };
}

/** Finds a Data Extension folder by exact name; returns its numeric ID, or null if none exists. */
export async function findDataExtensionFolderId(creds: MceCreds, accessToken: string, name: string): Promise<number | null> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PARTNER_NS}">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    <ns:RetrieveRequestMsg>
      <ns:RetrieveRequest>
        <ns:ObjectType>DataFolder</ns:ObjectType>
        <ns:Properties>ID</ns:Properties>
        <ns:Properties>Name</ns:Properties>
        <ns:Properties>ContentType</ns:Properties>
        <ns:Filter xsi:type="ns:ComplexFilterPart" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <ns:LeftOperand xsi:type="ns:SimpleFilterPart">
            <ns:Property>Name</ns:Property>
            <ns:SimpleOperator>equals</ns:SimpleOperator>
            <ns:Value>${xmlEscape(name)}</ns:Value>
          </ns:LeftOperand>
          <ns:LogicalOperator>AND</ns:LogicalOperator>
          <ns:RightOperand xsi:type="ns:SimpleFilterPart">
            <ns:Property>ContentType</ns:Property>
            <ns:SimpleOperator>equals</ns:SimpleOperator>
            <ns:Value>dataextension</ns:Value>
          </ns:RightOperand>
        </ns:Filter>
      </ns:RetrieveRequest>
    </ns:RetrieveRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await soapRequest(creds, accessToken, 'Retrieve', envelope);
  const id = /<ID>([^<]*)<\/ID>/.exec(responseText)?.[1];
  return id ? Number(id) : null;
}

/** Creates a new Data Extension folder and returns its numeric ID. */
export async function createDataExtensionFolder(
  creds: MceCreds,
  accessToken: string,
  params: { name: string; parentId: number }
): Promise<number> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PARTNER_NS}">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    <ns:CreateRequest>
      <ns:Objects xsi:type="ns:DataFolder" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <ns:Name>${xmlEscape(params.name)}</ns:Name>
        <ns:Description>Data Extensions created by the Contentful sync apps.</ns:Description>
        <ns:ContentType>dataextension</ns:ContentType>
        <ns:IsActive>true</ns:IsActive>
        <ns:IsEditable>true</ns:IsEditable>
        <ns:AllowChildren>true</ns:AllowChildren>
        <ns:ParentFolder>
          <ns:ID>${params.parentId}</ns:ID>
        </ns:ParentFolder>
      </ns:Objects>
    </ns:CreateRequest>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await soapRequest(creds, accessToken, 'Create', envelope);
  const overallStatus = /<OverallStatus>([^<]*)<\/OverallStatus>/.exec(responseText)?.[1];
  if (overallStatus !== 'OK') {
    const statusMessage = /<StatusMessage>([^<]*)<\/StatusMessage>/.exec(responseText)?.[1] ?? responseText;
    throw new Error(`Failed to create Data Extension folder "${params.name}": ${statusMessage}`);
  }
  const newId = /<NewID>([^<]*)<\/NewID>/.exec(responseText)?.[1];
  if (!newId) throw new Error(`Data Extension folder "${params.name}" created but no NewID was returned: ${responseText}`);
  return Number(newId);
}

/** Finds the root ("ParentFolder.ID = 0") Data Extensions folder, i.e. the top-level tree node. */
export async function findRootDataExtensionFolderId(creds: MceCreds, accessToken: string): Promise<number | null> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PARTNER_NS}">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    <ns:RetrieveRequestMsg>
      <ns:RetrieveRequest>
        <ns:ObjectType>DataFolder</ns:ObjectType>
        <ns:Properties>ID</ns:Properties>
        <ns:Properties>Name</ns:Properties>
        <ns:Properties>ParentFolder.ID</ns:Properties>
        <ns:Filter xsi:type="ns:SimpleFilterPart" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <ns:Property>ContentType</ns:Property>
          <ns:SimpleOperator>equals</ns:SimpleOperator>
          <ns:Value>dataextension</ns:Value>
        </ns:Filter>
      </ns:RetrieveRequest>
    </ns:RetrieveRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await soapRequest(creds, accessToken, 'Retrieve', envelope);
  const resultBlocks = responseText.match(/<Results xsi:type="DataFolder">[\s\S]*?<\/Results>/g) ?? [];
  for (const block of resultBlocks) {
    const parentId = /<ParentFolder>[\s\S]*?<ID>([^<]*)<\/ID>/.exec(block)?.[1];
    if (parentId === '0') {
      const id = /<ID>([^<]*)<\/ID>/.exec(block)?.[1];
      if (id) return Number(id);
    }
  }
  return null;
}

/** Idempotently ensures a named Data Extension folder exists directly under the account's root
 * Data Extensions folder, returning its ID (creating it on first call). */
export async function ensureDataExtensionFolder(creds: MceCreds, accessToken: string, name: string): Promise<number> {
  const existing = await findDataExtensionFolderId(creds, accessToken, name);
  if (existing) return existing;
  const rootId = await findRootDataExtensionFolderId(creds, accessToken);
  if (!rootId) throw new Error('Could not locate the root Data Extensions folder to nest the new folder under.');
  return createDataExtensionFolder(creds, accessToken, { name, parentId: rootId });
}

/** Moves an existing Data Extension into a different folder via SOAP UpdateRequest. */
export async function moveDataExtensionToFolder(
  creds: MceCreds,
  accessToken: string,
  params: { externalKey: string; categoryId: number }
): Promise<void> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PARTNER_NS}">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    <ns:UpdateRequest>
      <ns:Objects xsi:type="ns:DataExtension" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <ns:CustomerKey>${xmlEscape(params.externalKey)}</ns:CustomerKey>
        <ns:CategoryID>${params.categoryId}</ns:CategoryID>
      </ns:Objects>
    </ns:UpdateRequest>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await soapRequest(creds, accessToken, 'Update', envelope);
  const overallStatus = /<OverallStatus>([^<]*)<\/OverallStatus>/.exec(responseText)?.[1];
  if (overallStatus !== 'OK') {
    const statusMessage = /<StatusMessage>([^<]*)<\/StatusMessage>/.exec(responseText)?.[1] ?? responseText;
    throw new Error(`Failed to move Data Extension "${params.externalKey}": ${statusMessage}`);
  }
}

/** True if a Data Extension with this external key already exists in the tenant. */
export async function dataExtensionExists(creds: MceCreds, accessToken: string, externalKey: string): Promise<boolean> {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PARTNER_NS}">
  <soapenv:Header>
    <fueloauth xmlns="http://exacttarget.com">${accessToken}</fueloauth>
  </soapenv:Header>
  <soapenv:Body>
    <ns:RetrieveRequestMsg>
      <ns:RetrieveRequest>
        <ns:ObjectType>DataExtension</ns:ObjectType>
        <ns:Properties>CustomerKey</ns:Properties>
        <ns:Filter xsi:type="ns:SimpleFilterPart" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
          <ns:Property>CustomerKey</ns:Property>
          <ns:SimpleOperator>equals</ns:SimpleOperator>
          <ns:Value>${xmlEscape(externalKey)}</ns:Value>
        </ns:Filter>
      </ns:RetrieveRequest>
    </ns:RetrieveRequestMsg>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await soapRequest(creds, accessToken, 'Retrieve', envelope);
  return /<CustomerKey>([^<]*)<\/CustomerKey>/.test(responseText);
}
