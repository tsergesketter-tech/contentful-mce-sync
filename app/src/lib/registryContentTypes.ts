// The two content types this app keeps its routing table in. Created on install by
// ConfigScreen (ensureRegistryContentTypes), read by Page.tsx and functions/entryPublishSync.ts.
// Field ids here are a contract with both of those (and migrations/02-de-sync-registry.js) —
// rename on every side or none.
import type { CMAClient } from '@contentful/app-sdk';
import type { ContentTypeProps, CreateContentTypeProps } from 'contentful-management';

export const REGISTRY_CONTENT_TYPE = 'dataExtensionRegistry';
export const LINKAGE_CONTENT_TYPE = 'deSyncLinkage';

type FieldDef = CreateContentTypeProps['fields'][number];

/** Which BU owns the DE, and whether it's a Shared Data Extension in the parent BU. Blank MID = the package's default BU. */
const BUSINESS_UNIT_FIELDS: FieldDef[] = [
  { id: 'businessUnitMid', name: 'Business unit MID', type: 'Symbol', required: false, localized: false },
  { id: 'isShared', name: 'Shared Data Extension', type: 'Boolean', required: false, localized: false },
];

/** Optional fields added after v1. Added to an existing content type if missing — never anything else. */
const ADDITIVE_FIELDS: Record<string, FieldDef[]> = { [REGISTRY_CONTENT_TYPE]: BUSINESS_UNIT_FIELDS };

function registryDefinition(defaultLocale: string): CreateContentTypeProps {
  const fields: FieldDef[] = [
    { id: 'deLabel', name: 'Label', type: 'Symbol', required: true, localized: false },
    {
      id: 'deExternalKey',
      name: 'DE external key (CustomerKey)',
      type: 'Symbol',
      required: true,
      localized: false,
      validations: [{ unique: true }],
    },
    {
      id: 'pkFieldApiName',
      name: 'Row PK field API name',
      type: 'Symbol',
      required: true,
      localized: false,
      defaultValue: { [defaultLocale]: 'ExternalKey' },
    },
    { id: 'fieldMap', name: 'Field map', type: 'Object', required: false, localized: false },
    {
      id: 'excludedFieldIds',
      name: 'Excluded Contentful field ids',
      type: 'Array',
      items: { type: 'Symbol' },
      required: false,
      localized: false,
    },
    {
      id: 'deployStatus',
      name: 'Deploy status',
      type: 'Symbol',
      required: true,
      localized: false,
      validations: [{ in: ['not_deployed', 'deployed', 'failed'] }],
      defaultValue: { [defaultLocale]: 'not_deployed' },
    },
    { id: 'lastDeployError', name: 'Last deploy error', type: 'Text', required: false, localized: false },
    ...BUSINESS_UNIT_FIELDS,
  ];
  return {
    name: 'Data Extension Registry',
    description: 'Managed by the Marketing Cloud Engagement Sync app. One entry per known Data Extension.',
    displayField: 'deLabel',
    fields,
  };
}

function linkageDefinition(defaultLocale: string): CreateContentTypeProps {
  const fields: FieldDef[] = [
    {
      id: 'contentTypeId',
      name: 'Content type id',
      type: 'Symbol',
      required: true,
      localized: false,
      validations: [{ unique: true }],
    },
    { id: 'pkContentfulFieldId', name: 'PK Contentful field id', type: 'Symbol', required: true, localized: false },
    {
      id: 'dataExtension',
      name: 'Data extension',
      type: 'Link',
      linkType: 'Entry',
      required: true,
      localized: false,
      validations: [{ linkContentType: [REGISTRY_CONTENT_TYPE] }],
    },
    {
      id: 'isActive',
      name: 'Active',
      type: 'Boolean',
      required: true,
      localized: false,
      defaultValue: { [defaultLocale]: true },
    },
  ];
  return {
    name: 'DE Sync Linkage',
    description: 'Managed by the Marketing Cloud Engagement Sync app. Routes one content type to one Data Extension.',
    displayField: 'contentTypeId',
    fields,
  };
}

/**
 * Creates and publishes whichever of the two registry content types don't exist yet. Idempotent.
 * An existing content type (including one created by the migration, or by an earlier install)
 * only ever gains the optional ADDITIVE_FIELDS it's missing — existing fields, validations and
 * entries are never touched.
 */
export async function ensureRegistryContentTypes(cma: CMAClient, defaultLocale: string): Promise<string[]> {
  const existing = await cma.contentType.getMany({ query: { 'sys.id[in]': `${REGISTRY_CONTENT_TYPE},${LINKAGE_CONTENT_TYPE}` } });

  const created: string[] = [];
  // Registry first — the linkage type's link validation references it.
  for (const [id, definition] of [
    [REGISTRY_CONTENT_TYPE, registryDefinition(defaultLocale)],
    [LINKAGE_CONTENT_TYPE, linkageDefinition(defaultLocale)],
  ] as const) {
    const current = existing.items.find((ct: ContentTypeProps) => ct.sys.id === id);
    if (current) {
      const missing = (ADDITIVE_FIELDS[id] ?? []).filter((f) => !current.fields.some((cf) => cf.id === f.id));
      if (missing.length > 0) {
        const updated = await cma.contentType.update({ contentTypeId: id }, { ...current, fields: [...current.fields, ...missing] });
        await cma.contentType.publish({ contentTypeId: id }, updated);
        created.push(`${id}.${missing.map((f) => f.id).join(',')}`);
      }
      continue;
    }
    const ct = await cma.contentType.createWithId({ contentTypeId: id }, definition);
    await cma.contentType.publish({ contentTypeId: id }, ct);
    created.push(id);
  }
  return created;
}
