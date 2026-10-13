// Generic Contentful content-type <-> Data Extension field mapping, shared by createDataExtension
// (schema derivation), backfillDeRows and entryPublishSync (row mapping). esbuild inlines lib/ into
// each Function bundle, so importing it from every Function is fine.
//
// DE field rules (empirically confirmed against a live tenant, see repo history):
//   - the PK field must be IsPrimaryKey=true/IsRequired=true; every other field is optional
//   - row writes go through the Data Extension Rows (Synchronous) REST API
//     (POST {rest}/hub/v1/dataevents/key:{externalKey}/rowset), which upserts by matching the PK
//     field named in `keys` — not through Bulk API or SOAP row CRUD
//   - Link (Entry/Asset) and RichText fields are skipped by the generic mapper — no generic
//     resolution/plaintext rule exists for them yet (same limitation as the MO-sync app)
//   - unlike Salesforce Marketing Objects, DE field API names have no required suffix — plain
//     PascalCase names are used throughout (ExternalKey, not ExternalKey__c)

export type ContentTypeField = {
  id: string;
  name: string;
  type: string;
  localized?: boolean;
  items?: { type: string };
  disabled?: boolean;
  omitted?: boolean;
};

export type ContentTypeLike = {
  sys: { id: string };
  displayField: string;
  fields: ContentTypeField[];
};

export type DeField = { apiName: string; label: string; fieldType: DeFieldType; length?: number; contentfulFieldId?: string };
export type DeFieldType = 'Text' | 'Number' | 'Date' | 'Boolean';

/** pkContentfulFieldId sentinel: key rows by the entry's own sys.id rather than a content-type field. */
export const ENTRY_ID_SENTINEL = '__entryId';

export const PK_FIELD: DeField = { apiName: 'ExternalKey', label: 'External Key', fieldType: 'Text', length: 120 };

/** Sync bookkeeping columns present on every net-new DE, regardless of the source content type. */
export const FIXED_FIELDS: DeField[] = [
  { apiName: 'ContentfulEntryId', label: 'Contentful Entry Id', fieldType: 'Text', length: 64 },
  { apiName: 'ContentfulSpaceId', label: 'Contentful Space Id', fieldType: 'Text', length: 64 },
  { apiName: 'ContentTypeId', label: 'Content Type Id', fieldType: 'Text', length: 64 },
  { apiName: 'Locale', label: 'Locale', fieldType: 'Text', length: 16 },
  { apiName: 'ContentVersion', label: 'Content Version', fieldType: 'Text', length: 20 },
  { apiName: 'PublishedAt', label: 'Published At', fieldType: 'Text', length: 40 },
  { apiName: 'IsActive', label: 'Is Active', fieldType: 'Boolean' },
  { apiName: 'SourceSystem', label: 'Source System', fieldType: 'Text', length: 40 },
];

export function toApiName(contentfulFieldId: string): string {
  const base = contentfulFieldId.replace(/[^A-Za-z0-9_]/g, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function deFieldTypeFor(field: ContentTypeField): { fieldType: DeFieldType; length?: number } {
  switch (field.type) {
    case 'Integer':
      return { fieldType: 'Number' };
    case 'Date':
      return { fieldType: 'Date' };
    case 'Boolean':
      return { fieldType: 'Boolean' };
    case 'Symbol':
      return { fieldType: 'Text', length: 255 };
    case 'Text':
    case 'Number':
    default:
      return { fieldType: 'Text', length: 4000 };
  }
}

/** Contentful content type -> the list of DE field definitions it implies (PK/fixed excluded). */
export function deriveDeFieldsFromContentType(contentType: ContentTypeLike, excludedFieldIds: string[] = []): DeField[] {
  const excluded = new Set(excludedFieldIds);
  return contentType.fields
    .filter((f) => !excluded.has(f.id) && !f.disabled && !f.omitted && isSyncableField(f))
    .map((f) => ({
      apiName: toApiName(f.id),
      label: f.name,
      ...deFieldTypeFor(f),
      contentfulFieldId: f.id,
    }));
}

/** Fields the generic mapper can write to a DE column. A list of Symbols is written comma-joined; links, Rich Text, JSON and Location aren't. */
export function isSyncableField(field: Pick<ContentTypeField, 'type' | 'items'>): boolean {
  if (field.type === 'Array') return field.items?.type === 'Symbol';
  return field.type !== 'Link' && field.type !== 'RichText' && field.type !== 'Object' && field.type !== 'Location';
}

/** Sanitized PascalCase-ish base used for DE external keys/names derived from a content type id. */
export function sanitizeApiNameBase(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, ' ');
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function deriveDeExternalKey(contentTypeId: string): string {
  return `${sanitizeApiNameBase(contentTypeId)}_DE`;
}

// Objects (RichText documents, links) never reach a column: a stringified "[object Object]" is
// worse than blank. A list of strings is written comma-joined.
function scalar(val: unknown): string | null {
  if (Array.isArray(val)) return val.every((v) => typeof v === 'string') ? val.join(',') : null;
  if (val == null || typeof val === 'object') return null;
  return String(val);
}

function firstNonLocalizedValue(fields: Record<string, Record<string, unknown>> | undefined, fieldId: string): string | null {
  const byLocale = fields?.[fieldId];
  if (!byLocale) return null;
  return scalar(Object.values(byLocale).find((v) => v != null));
}

function localizedValue(fields: Record<string, Record<string, unknown>> | undefined, fieldId: string, locale: string): string | null {
  const byLocale = fields?.[fieldId];
  if (!byLocale) return null;
  return scalar(byLocale[locale]);
}

/**
 * Locale set for an entry: prefer the content type's own displayField (always populated on
 * publish for any content type), falling back to the union of every field's locale keys.
 */
export function deLocalesOf(entry: { sys: { id: string }; fields?: Record<string, Record<string, unknown>> }, contentType: ContentTypeLike): string[] {
  const byDisplayField = entry.fields?.[contentType.displayField];
  if (byDisplayField && Object.keys(byDisplayField).length > 0) return Object.keys(byDisplayField);

  const locales = new Set<string>();
  for (const value of Object.values(entry.fields || {})) {
    if (value && typeof value === 'object') Object.keys(value).forEach((l) => locales.add(l));
  }
  if (locales.size === 0) {
    throw new Error(`Entry ${entry.sys?.id} has no field values — cannot derive locale set.`);
  }
  return Array.from(locales);
}

/** One row upsert item, matching the Data Extension Rows (Synchronous) rowset body shape. */
export type DeRowItem = { keys: Record<string, unknown>; values: Record<string, unknown> };

/**
 * Maps one Contentful entry to one DE row-upsert item per locale. `pkContentfulFieldId` is either
 * a real content-type field id (used as the business key) or the sentinel `__entryId`, meaning
 * "use the entry's own sys.id" for content types with no natural business key.
 */
export function mapEntryToDeRows(
  entry: { sys: { id: string; space: { sys: { id: string } }; publishedVersion?: number; updatedAt?: string }; fields?: Record<string, Record<string, unknown>> },
  contentType: ContentTypeLike,
  deFields: DeField[],
  pkContentfulFieldId: string
): DeRowItem[] {
  const fields = entry.fields || {};
  const pkFieldDef = pkContentfulFieldId === ENTRY_ID_SENTINEL ? null : contentType.fields.find((f) => f.id === pkContentfulFieldId);

  const items: DeRowItem[] = [];
  for (const locale of deLocalesOf(entry, contentType)) {
    const businessKey =
      pkContentfulFieldId === ENTRY_ID_SENTINEL
        ? entry.sys.id
        : pkFieldDef?.localized
        ? localizedValue(fields, pkContentfulFieldId, locale)
        : firstNonLocalizedValue(fields, pkContentfulFieldId);
    // No business key for this locale: skip it rather than write a "null__en-US" row.
    if (!businessKey) continue;

    const values: Record<string, unknown> = {
      ContentfulEntryId: entry.sys.id,
      ContentfulSpaceId: entry.sys.space.sys.id,
      ContentTypeId: contentType.sys.id,
      Locale: locale,
      ContentVersion: String(entry.sys.publishedVersion ?? ''),
      PublishedAt: entry.sys.updatedAt ?? '',
      IsActive: true,
      SourceSystem: 'Contentful',
    };
    for (const f of deFields) {
      if (!f.contentfulFieldId) continue;
      const fieldDef = contentType.fields.find((cf) => cf.id === f.contentfulFieldId);
      values[f.apiName] = fieldDef?.localized
        ? localizedValue(fields, f.contentfulFieldId, locale)
        : firstNonLocalizedValue(fields, f.contentfulFieldId);
    }
    items.push({ keys: { [PK_FIELD.apiName]: `${businessKey}__${locale}` }, values });
  }
  return items;
}

/**
 * Deactivation rows for unpublish: IsActive=false for exactly the keys mapEntryToDeRows writes
 * for this entry. The unpublish event body carries only `sys`, so `entry` must be the CMA copy;
 * unpublishing doesn't touch its fields, so its locale set is the one the last publish used.
 * Only existing keys may be sent: the rowset API upserts, so any other key becomes a new stub row.
 */
export function mapEntryToDeactivateRows(
  entry: { sys: { id: string }; fields?: Record<string, Record<string, unknown>> },
  contentType: ContentTypeLike,
  pkContentfulFieldId: string
): DeRowItem[] {
  // No field values means mapEntryToDeRows could never have written a row for it.
  if (!Object.keys(entry.fields || {}).length) return [];
  const pkFieldDef = pkContentfulFieldId === ENTRY_ID_SENTINEL ? null : contentType.fields.find((f) => f.id === pkContentfulFieldId);
  return deLocalesOf(entry, contentType).flatMap((locale) => {
    const businessKey =
      pkContentfulFieldId === ENTRY_ID_SENTINEL
        ? entry.sys.id
        : pkFieldDef?.localized
        ? localizedValue(entry.fields, pkContentfulFieldId, locale)
        : firstNonLocalizedValue(entry.fields, pkContentfulFieldId);
    if (!businessKey) return [];
    return [{ keys: { [PK_FIELD.apiName]: `${businessKey}__${locale}` }, values: { IsActive: false } }];
  });
}
