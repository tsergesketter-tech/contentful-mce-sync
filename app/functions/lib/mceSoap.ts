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
  params: { externalKey: string; name: string; description?: string; pkField: DeField; fields: DeField[] }
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
