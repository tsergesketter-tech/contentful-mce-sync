import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageAppSDK, CMAClient } from '@contentful/app-sdk';
import { useCMA, useSDK } from '@contentful/react-apps-toolkit';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  Heading,
  Modal,
  Note,
  Paragraph,
  Select,
  Spinner,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@contentful/f36-components';
import type { ContentTypeProps, EntryProps } from 'contentful-management';
import {
  deriveDeFieldsFromContentType,
  ENTRY_ID_SENTINEL,
  isSyncableField,
  type ContentTypeField,
  type ContentTypeLike,
  type DeField,
} from '../../functions/lib/deFieldMapping';
import { callAppAction, type AppActionIds, type BackfillResult, type CreateDataExtensionResult } from '../lib/appActions';
import { LINKAGE_CONTENT_TYPE, REGISTRY_CONTENT_TYPE } from '../lib/registryContentTypes';

// The two content types that back this app itself are never sync targets.
const ADMIN_CONTENT_TYPES = new Set([REGISTRY_CONTENT_TYPE, LINKAGE_CONTENT_TYPE]);

// Registry/linkage fields are all non-localized, so their single value lives under whichever
// locale was the space default when the entry was written.
function field<T = string>(entry: EntryProps, id: string): T | undefined {
  const byLocale = entry.fields?.[id];
  return byLocale ? (Object.values(byLocale).find((v) => v != null) as T | undefined) : undefined;
}

// Copies every already-published entry of a content type into its just-linked Data Extension, so
// linking isn't limited to entries published from that point forward. The Data Extension Rows
// (Synchronous) API returns a final result in one round trip, so there's no poll counterpart.
async function runBackfill(
  cma: CMAClient,
  ids: AppActionIds,
  params: { contentTypeId: string; deExternalKey: string; deMid: string; pkContentfulFieldId: string; deFields: unknown[] },
  onProgress?: (message: string) => void
): Promise<BackfillResult> {
  onProgress?.(`Copying existing ${params.contentTypeId} records into ${params.deExternalKey}...`);
  const result = await callAppAction<BackfillResult>(cma, ids, 'backfillDeRows', {
    contentTypeId: params.contentTypeId,
    deExternalKey: params.deExternalKey,
    pkContentfulFieldId: params.pkContentfulFieldId,
    deFieldsJson: JSON.stringify(params.deFields ?? []),
    ...(params.deMid ? { deMid: params.deMid } : {}),
  });
  if (!result.ok) throw new Error(result.error || 'Backfill failed.');
  return result;
}

function deFieldsOf(entry: EntryProps): DeField[] {
  return field<{ fields: DeField[] }>(entry, 'fieldMap')?.fields ?? [];
}

/** MID of the BU that owns a registry entry's DE; blank = the Installed Package's default BU. */
function deMidOf(entry: EntryProps): string {
  return field<string>(entry, 'businessUnitMid') ?? '';
}

function locationLabel(entry: EntryProps): string {
  const mid = deMidOf(entry);
  if (field<boolean>(entry, 'isShared')) return `Shared · parent BU${mid ? ` ${mid}` : ''}`;
  return mid ? `BU ${mid}` : 'Default BU';
}

// Same eligibility rule as deriveDeFieldsFromContentType's filter, so the UI checklist only ever
// offers fields the backend would actually derive.
function isEligibleField(f: ContentTypeField): boolean {
  return !f.disabled && !f.omitted && isSyncableField(f);
}

const Page = () => {
  const sdk = useSDK<PageAppSDK>();
  const cma = useCMA();
  const locale = sdk.locales.default;
  // Non-secret installation parameter, so the browser can read it.
  const parentMid = String((sdk.parameters.installation as { MCE_PARENT_MID?: string })?.MCE_PARENT_MID ?? '').trim();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);
  const [contentTypes, setContentTypes] = useState<ContentTypeProps[]>([]);
  const [registryEntries, setRegistryEntries] = useState<EntryProps[]>([]);
  const [linkageEntries, setLinkageEntries] = useState<EntryProps[]>([]);
  // Registry fields added after v1 exist only once the ConfigScreen has been saved on this version.
  const [registryFieldIds, setRegistryFieldIds] = useState<Set<string>>(new Set());

  const [selectedContentTypeId, setSelectedContentTypeId] = useState<string | null>(null);
  const [selectedRegistryEntryId, setSelectedRegistryEntryId] = useState<string | null>(null);

  const [contentTypeSearch, setContentTypeSearch] = useState('');
  const [contentTypeLinkFilter, setContentTypeLinkFilter] = useState<'all' | 'linked' | 'unlinked'>('all');
  const [registrySearch, setRegistrySearch] = useState('');
  const [registryStatusFilter, setRegistryStatusFilter] = useState<'all' | 'deployed' | 'not_deployed' | 'failed'>('all');

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createContentTypeId, setCreateContentTypeId] = useState<string>('');
  const [extraFieldLabels, setExtraFieldLabels] = useState('');
  const [fieldSelection, setFieldSelection] = useState<Record<string, boolean>>({});
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployStatusMessage, setDeployStatusMessage] = useState<string | null>(null);

  const [isEditFieldsModalOpen, setIsEditFieldsModalOpen] = useState(false);
  const [editFieldSelection, setEditFieldSelection] = useState<Record<string, boolean>>({});
  const [editFieldsBusy, setEditFieldsBusy] = useState(false);
  const [editFieldsError, setEditFieldsError] = useState<string | null>(null);
  const [editFieldsMessage, setEditFieldsMessage] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ctRes, registryRes, linkageRes] = await Promise.all([
        cma.contentType.getMany({ query: { limit: 1000 } }),
        cma.entry.getMany({
          query: { content_type: REGISTRY_CONTENT_TYPE, limit: 1000, 'sys.archivedAt[exists]': false },
        }),
        cma.entry.getMany({
          query: { content_type: LINKAGE_CONTENT_TYPE, limit: 1000, 'sys.archivedAt[exists]': false },
        }),
      ]);
      setContentTypes(ctRes.items.filter((ct) => !ADMIN_CONTENT_TYPES.has(ct.sys.id)));
      setRegistryFieldIds(new Set(ctRes.items.find((ct) => ct.sys.id === REGISTRY_CONTENT_TYPE)?.fields.map((f) => f.id) ?? []));
      setRegistryEntries(registryRes.items);
      setLinkageEntries(linkageRes.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load sync configuration.');
    } finally {
      setLoading(false);
    }
  }, [cma]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // contentTypeId -> its active linkage entry, if any. `contentTypeId` is unique per the content
  // type's own validation, but a row can still exist inactive (soft-unlinked) — active wins.
  const linkageByContentType = useMemo(() => {
    const map = new Map<string, EntryProps>();
    for (const entry of linkageEntries) {
      const ctId = field<string>(entry, 'contentTypeId');
      if (!ctId) continue;
      const isActive = field<boolean>(entry, 'isActive');
      if (isActive || !map.has(ctId)) map.set(ctId, entry);
    }
    return map;
  }, [linkageEntries]);

  const registryById = useMemo(() => {
    const map = new Map<string, EntryProps>();
    for (const entry of registryEntries) map.set(entry.sys.id, entry);
    return map;
  }, [registryEntries]);

  const filteredContentTypes = useMemo(() => {
    const q = contentTypeSearch.trim().toLowerCase();
    return contentTypes.filter((ct) => {
      if (q && !ct.name.toLowerCase().includes(q) && !ct.sys.id.toLowerCase().includes(q)) return false;
      if (contentTypeLinkFilter === 'all') return true;
      const isLinked = !!field<boolean>(linkageByContentType.get(ct.sys.id) as EntryProps, 'isActive');
      return contentTypeLinkFilter === 'linked' ? isLinked : !isLinked;
    });
  }, [contentTypes, contentTypeSearch, contentTypeLinkFilter, linkageByContentType]);

  const filteredRegistryEntries = useMemo(() => {
    const q = registrySearch.trim().toLowerCase();
    return registryEntries.filter((entry) => {
      const label = field<string>(entry, 'deLabel') ?? '';
      const externalKey = field<string>(entry, 'deExternalKey') ?? '';
      if (q && !label.toLowerCase().includes(q) && !externalKey.toLowerCase().includes(q)) return false;
      if (registryStatusFilter === 'all') return true;
      return field<string>(entry, 'deployStatus') === registryStatusFilter;
    });
  }, [registryEntries, registrySearch, registryStatusFilter]);

  const selectedContentType = contentTypes.find((ct) => ct.sys.id === selectedContentTypeId);
  const existingLinkage = selectedContentTypeId
    ? linkageByContentType.get(selectedContentTypeId)
    : undefined;
  const existingLinkageIsActive = existingLinkage ? field<boolean>(existingLinkage, 'isActive') : false;

  const canLink =
    !!selectedContentTypeId &&
    !!selectedRegistryEntryId &&
    !busy &&
    !(existingLinkageIsActive && field<{ sys: { id: string } }>(existingLinkage!, 'dataExtension')?.sys.id === selectedRegistryEntryId);

  const canUnlink = !!selectedContentTypeId && !!existingLinkage && existingLinkageIsActive && !busy;
  const canBackfill = !!selectedContentTypeId && !!existingLinkage && existingLinkageIsActive && !busy;

  const existingRegistryEntry = useMemo(() => {
    if (!existingLinkage || !existingLinkageIsActive) return undefined;
    const deId = field<{ sys: { id: string } }>(existingLinkage, 'dataExtension')?.sys.id;
    return deId ? registryById.get(deId) : undefined;
  }, [existingLinkage, existingLinkageIsActive, registryById]);

  const canEditFields = !!selectedContentTypeId && !!existingRegistryEntry && !busy;

  const handleLink = async () => {
    if (!selectedContentTypeId || !selectedRegistryEntryId || !selectedContentType || !sdk.ids.app) return;
    setBusy(true);
    setError(null);
    setBackfillMessage(null);
    try {
      const linkField = {
        [locale]: { sys: { type: 'Link', linkType: 'Entry', id: selectedRegistryEntryId } },
      };
      let pkContentfulFieldId: string;
      if (existingLinkage) {
        pkContentfulFieldId = field<string>(existingLinkage, 'pkContentfulFieldId') ?? ENTRY_ID_SENTINEL;
        const updated: EntryProps = {
          ...existingLinkage,
          fields: {
            ...existingLinkage.fields,
            dataExtension: linkField,
            isActive: { [locale]: true },
          },
        };
        const saved = await cma.entry.update({ entryId: existingLinkage.sys.id }, updated);
        await cma.entry.publish({ entryId: saved.sys.id }, saved);
      } else {
        // Rows are keyed by entry id: a display field can be blank, repeat across entries or change.
        pkContentfulFieldId = ENTRY_ID_SENTINEL;
        const created = await cma.entry.create(
          { contentTypeId: LINKAGE_CONTENT_TYPE },
          {
            fields: {
              contentTypeId: { [locale]: selectedContentTypeId },
              pkContentfulFieldId: { [locale]: pkContentfulFieldId },
              dataExtension: linkField,
              isActive: { [locale]: true },
            },
          }
        );
        await cma.entry.publish({ entryId: created.sys.id }, created);
      }

      const registryEntry = registryById.get(selectedRegistryEntryId);
      const deExternalKey = registryEntry ? field<string>(registryEntry, 'deExternalKey') : undefined;
      if (registryEntry && deExternalKey) {
        const ids: AppActionIds = { spaceId: sdk.ids.space, environmentId: sdk.ids.environment, appDefinitionId: sdk.ids.app };
        try {
          const result = await runBackfill(
            cma,
            ids,
            { contentTypeId: selectedContentTypeId, deExternalKey, deMid: deMidOf(registryEntry), pkContentfulFieldId, deFields: deFieldsOf(registryEntry) },
            setBackfillMessage
          );
          setBackfillMessage(`Linked. Copied ${result.processed} row(s) from ${result.totalEntries} entrie(s) into ${deExternalKey}.`);
        } catch (e) {
          setBackfillMessage(null);
          setError(`Linked, but the initial backfill failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      await loadAll();
      setSelectedContentTypeId(null);
      setSelectedRegistryEntryId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save linkage.');
    } finally {
      setBusy(false);
    }
  };

  const handleBackfillSelected = async () => {
    if (!selectedContentTypeId || !existingLinkage || !existingLinkageIsActive || !sdk.ids.app) return;
    const deId = field<{ sys: { id: string } }>(existingLinkage, 'dataExtension')?.sys.id;
    const registryEntry = deId ? registryById.get(deId) : undefined;
    const deExternalKey = registryEntry ? field<string>(registryEntry, 'deExternalKey') : undefined;
    if (!registryEntry || !deExternalKey) return;
    const pkContentfulFieldId = field<string>(existingLinkage, 'pkContentfulFieldId') ?? ENTRY_ID_SENTINEL;
    const ids: AppActionIds = { spaceId: sdk.ids.space, environmentId: sdk.ids.environment, appDefinitionId: sdk.ids.app };
    setBusy(true);
    setError(null);
    setBackfillMessage(null);
    try {
      const result = await runBackfill(
        cma,
        ids,
        { contentTypeId: selectedContentTypeId, deExternalKey, deMid: deMidOf(registryEntry), pkContentfulFieldId, deFields: deFieldsOf(registryEntry) },
        setBackfillMessage
      );
      setBackfillMessage(`Copied ${result.processed} row(s) from ${result.totalEntries} entrie(s) into ${deExternalKey}.`);
    } catch (e) {
      setBackfillMessage(null);
      setError(e instanceof Error ? e.message : 'Backfill failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async () => {
    if (!existingLinkage) return;
    setBusy(true);
    setError(null);
    try {
      const updated: EntryProps = {
        ...existingLinkage,
        fields: { ...existingLinkage.fields, isActive: { [locale]: false } },
      };
      const saved = await cma.entry.update({ entryId: existingLinkage.sys.id }, updated);
      await cma.entry.publish({ entryId: saved.sys.id }, saved);
      await loadAll();
      setSelectedContentTypeId(null);
      setSelectedRegistryEntryId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to unlink.');
    } finally {
      setBusy(false);
    }
  };

  const createContentType = contentTypes.find((ct) => ct.sys.id === createContentTypeId);
  const createEligibleFields = useMemo(
    () => ((createContentType?.fields ?? []) as ContentTypeField[]).filter(isEligibleField),
    [createContentType]
  );

  useEffect(() => {
    if (!isCreateModalOpen) return;
    const next: Record<string, boolean> = {};
    for (const f of createEligibleFields) next[f.id] = true;
    setFieldSelection(next);
  }, [isCreateModalOpen, createContentTypeId]);

  const openCreateModal = () => {
    setCreateContentTypeId(selectedContentTypeId ?? contentTypes[0]?.sys.id ?? '');
    setExtraFieldLabels('');
    setDeployError(null);
    setDeployStatusMessage(null);
    setIsCreateModalOpen(true);
  };

  const handleCreateNetNewDe = async () => {
    if (!createContentTypeId || !sdk.ids.app) return;
    const ids: AppActionIds = { spaceId: sdk.ids.space, environmentId: sdk.ids.environment, appDefinitionId: sdk.ids.app };
    setDeployBusy(true);
    setDeployError(null);
    try {
      const excludedFieldIds = createEligibleFields.filter((f) => !fieldSelection[f.id]).map((f) => f.id);
      setDeployStatusMessage(parentMid ? `Creating a Shared Data Extension in parent BU ${parentMid}...` : 'Deriving schema and creating the Data Extension...');
      const createResult = await callAppAction<CreateDataExtensionResult>(cma, ids, 'createDataExtension', {
        contentTypeId: createContentTypeId,
        extraFieldLabels: extraFieldLabels.trim() || undefined,
        excludedFieldIds: excludedFieldIds.length ? excludedFieldIds.join(',') : undefined,
      });
      if (!createResult.ok) throw new Error(createResult.error || 'Failed to create the Data Extension.');

      setDeployStatusMessage(`Created ${createResult.deExternalKey}. Registering in Contentful...`);

      const registryEntry = await cma.entry.create(
        { contentTypeId: REGISTRY_CONTENT_TYPE },
        {
          fields: {
            deLabel: { [locale]: createResult.deLabel },
            deExternalKey: { [locale]: createResult.deExternalKey },
            pkFieldApiName: { [locale]: createResult.pkFieldApiName },
            fieldMap: { [locale]: { fields: createResult.fields } },
            excludedFieldIds: { [locale]: createResult.excludedFieldIds ?? [] },
            deployStatus: { [locale]: 'deployed' },
            ...(registryFieldIds.has('businessUnitMid') ? { businessUnitMid: { [locale]: createResult.businessUnitMid } } : {}),
            ...(registryFieldIds.has('isShared') ? { isShared: { [locale]: createResult.isShared } } : {}),
          },
        }
      );
      const publishedRegistry = await cma.entry.publish({ entryId: registryEntry.sys.id }, registryEntry);

      const linkField = {
        [locale]: { sys: { type: 'Link', linkType: 'Entry', id: publishedRegistry.sys.id } },
      };
      const existing = linkageByContentType.get(createContentTypeId);
      if (existing) {
        const updated: EntryProps = {
          ...existing,
          fields: {
            ...existing.fields,
            pkContentfulFieldId: { [locale]: ENTRY_ID_SENTINEL },
            dataExtension: linkField,
            isActive: { [locale]: true },
          },
        };
        const saved = await cma.entry.update({ entryId: existing.sys.id }, updated);
        await cma.entry.publish({ entryId: saved.sys.id }, saved);
      } else {
        const linkageEntry = await cma.entry.create(
          { contentTypeId: LINKAGE_CONTENT_TYPE },
          {
            fields: {
              contentTypeId: { [locale]: createContentTypeId },
              pkContentfulFieldId: { [locale]: ENTRY_ID_SENTINEL },
              dataExtension: linkField,
              isActive: { [locale]: true },
            },
          }
        );
        await cma.entry.publish({ entryId: linkageEntry.sys.id }, linkageEntry);
      }

      // Linkage is already live at this point, so future publishes will sync regardless of what
      // happens next — a backfill failure here is surfaced but doesn't undo the creation, and the
      // modal is kept open (instead of auto-closing) so the error is actually seen.
      let backfillFailed = false;
      try {
        const result = await runBackfill(
          cma,
          ids,
          {
            contentTypeId: createContentTypeId,
            deExternalKey: createResult.deExternalKey,
            deMid: createResult.businessUnitMid,
            pkContentfulFieldId: ENTRY_ID_SENTINEL,
            deFields: createResult.fields,
          },
          setDeployStatusMessage
        );
        setDeployStatusMessage(`Done — copied ${result.processed} row(s) from ${result.totalEntries} entrie(s).`);
      } catch (e) {
        backfillFailed = true;
        setDeployError(`Created and linked, but the initial backfill failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      await loadAll();
      setSelectedContentTypeId(null);
      setSelectedRegistryEntryId(null);
      if (!backfillFailed) setIsCreateModalOpen(false);
    } catch (e) {
      setDeployError(e instanceof Error ? e.message : 'Failed to create the Data Extension.');
    } finally {
      setDeployBusy(false);
    }
  };

  const openEditFieldsModal = () => {
    if (!selectedContentType || !existingRegistryEntry) return;
    const excluded = new Set(field<string[]>(existingRegistryEntry, 'excludedFieldIds') ?? []);
    const next: Record<string, boolean> = {};
    for (const f of (selectedContentType.fields as ContentTypeField[]).filter(isEligibleField)) {
      next[f.id] = !excluded.has(f.id);
    }
    setEditFieldSelection(next);
    setEditFieldsError(null);
    setEditFieldsMessage(null);
    setIsEditFieldsModalOpen(true);
  };

  // Preserves FIXED_FIELDS and any manually-added extra fields (identified by having no
  // contentfulFieldId) — only the content-type-derived slice is recomputed from the checklist.
  // Newly checked fields get a column in the DE first (addDeFields), so the registry never maps a
  // field the DE can't store; unchecked fields keep their column and simply stop being written.
  const handleSaveFieldSelection = async () => {
    if (!selectedContentType || !selectedContentTypeId || !existingRegistryEntry || !existingLinkage || !sdk.ids.app) return;
    setEditFieldsBusy(true);
    setEditFieldsError(null);
    setEditFieldsMessage(null);
    try {
      const eligibleFields = (selectedContentType.fields as ContentTypeField[]).filter(isEligibleField);
      const excludedFieldIds = eligibleFields.filter((f) => !editFieldSelection[f.id]).map((f) => f.id);

      const derivedFields = deriveDeFieldsFromContentType(selectedContentType as unknown as ContentTypeLike, excludedFieldIds);
      const manualFields = deFieldsOf(existingRegistryEntry).filter((f) => !f.contentfulFieldId);
      const newFieldMap = [...manualFields, ...derivedFields];
      const deExternalKey = field<string>(existingRegistryEntry, 'deExternalKey');
      const deMid = deMidOf(existingRegistryEntry);
      const ids: AppActionIds = { spaceId: sdk.ids.space, environmentId: sdk.ids.environment, appDefinitionId: sdk.ids.app };

      if (deExternalKey) {
        setEditFieldsMessage(`Updating the ${deExternalKey} schema...`);
        const added = await callAppAction<{ added: string[] }>(cma, ids, 'addDeFields', {
          deExternalKey,
          deFieldsJson: JSON.stringify(newFieldMap),
          ...(deMid ? { deMid } : {}),
        });
        if (!added.ok) throw new Error(added.error || 'Failed to update the Data Extension schema.');
      }

      const updatedRegistry: EntryProps = {
        ...existingRegistryEntry,
        fields: {
          ...existingRegistryEntry.fields,
          fieldMap: { [locale]: { fields: newFieldMap } },
          excludedFieldIds: { [locale]: excludedFieldIds },
        },
      };
      const saved = await cma.entry.update({ entryId: existingRegistryEntry.sys.id }, updatedRegistry);
      await cma.entry.publish({ entryId: saved.sys.id }, saved);

      const pkContentfulFieldId = field<string>(existingLinkage, 'pkContentfulFieldId') ?? ENTRY_ID_SENTINEL;
      if (deExternalKey) {
        const result = await runBackfill(
          cma,
          ids,
          { contentTypeId: selectedContentTypeId, deExternalKey, deMid, pkContentfulFieldId, deFields: newFieldMap },
          setEditFieldsMessage
        );
        setEditFieldsMessage(`Saved. Re-synced ${result.processed} row(s) from ${result.totalEntries} entrie(s).`);
      }

      await loadAll();
      setIsEditFieldsModalOpen(false);
    } catch (e) {
      setEditFieldsError(e instanceof Error ? e.message : 'Failed to save field selection.');
    } finally {
      setEditFieldsBusy(false);
    }
  };

  if (loading) {
    return (
      <Box padding="spacingXl">
        <Spinner size="large" />
      </Box>
    );
  }

  return (
    <Box padding="spacingXl" style={{ paddingBottom: 88 }}>
      <Flex justifyContent="space-between" alignItems="center" marginBottom="spacingM">
        <Box>
          <Heading>Data Extension Sync</Heading>
          <Paragraph>
            Link Contentful content types to the Marketing Cloud Engagement Data Extensions they
            publish into. Select one content type and one registry entry, then Link.
          </Paragraph>
          <Paragraph fontColor="gray600">
            {parentMid
              ? `New Data Extensions are created as Shared Data Extensions in parent BU ${parentMid}, so they can be shared to child BUs.`
              : "New Data Extensions are created in the Installed Package's default BU. Set the Parent BU MID on the configuration screen to create Shared Data Extensions instead."}
          </Paragraph>
        </Box>
        <Tooltip content="Create a brand-new Data Extension in Marketing Cloud Engagement, derived from a content type's fields, and link it.">
          <Button variant="secondary" onClick={openCreateModal} isDisabled={contentTypes.length === 0}>
            Create Net-New Data Extension
          </Button>
        </Tooltip>
      </Flex>

      {error && (
        <Box marginBottom="spacingM">
          <Note variant="negative">{error}</Note>
        </Box>
      )}

      {backfillMessage && (
        <Box marginBottom="spacingM">
          <Note variant="primary">{backfillMessage}</Note>
        </Box>
      )}

      <Flex gap="spacingL" marginBottom="spacingM">
        <Box style={{ flexGrow: 1 }}>
          <Heading as="h3">Content Types</Heading>
          <Flex gap="spacingXs" marginBottom="spacingXs">
            <TextInput
              placeholder="Search by name or id..."
              value={contentTypeSearch}
              onChange={(e) => setContentTypeSearch(e.target.value)}
            />
            <Select
              value={contentTypeLinkFilter}
              onChange={(e) => setContentTypeLinkFilter(e.target.value as typeof contentTypeLinkFilter)}
            >
              <Select.Option value="all">All</Select.Option>
              <Select.Option value="linked">Linked</Select.Option>
              <Select.Option value="unlinked">Not linked</Select.Option>
            </Select>
          </Flex>
          <Table>
            <Table.Head>
              <Table.Row>
                <Table.Cell>{''}</Table.Cell>
                <Table.Cell>Name</Table.Cell>
                <Table.Cell>Linked Data Extension</Table.Cell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {filteredContentTypes.map((ct) => {
                const linkage = linkageByContentType.get(ct.sys.id);
                const isActive = linkage ? field<boolean>(linkage, 'isActive') : false;
                const linkedDeId = linkage
                  ? field<{ sys: { id: string } }>(linkage, 'dataExtension')?.sys.id
                  : undefined;
                const linkedDe = linkedDeId ? registryById.get(linkedDeId) : undefined;
                return (
                  <Table.Row key={ct.sys.id}>
                    <Table.Cell>
                      <Checkbox
                        id={`ct-${ct.sys.id}`}
                        isChecked={selectedContentTypeId === ct.sys.id}
                        onChange={() =>
                          setSelectedContentTypeId((prev) => (prev === ct.sys.id ? null : ct.sys.id))
                        }
                      />
                    </Table.Cell>
                    <Table.Cell>
                      {ct.name} <Paragraph fontColor="gray600">{ct.sys.id}</Paragraph>
                    </Table.Cell>
                    <Table.Cell>
                      {isActive && linkedDe ? (
                        <Badge variant="positive">{field<string>(linkedDe, 'deLabel')}</Badge>
                      ) : (
                        <Badge variant="secondary">Not linked</Badge>
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </Box>

        <Box style={{ flexGrow: 1 }}>
          <Heading as="h3">Data Extension Registry</Heading>
          <Flex gap="spacingXs" marginBottom="spacingXs">
            <TextInput
              placeholder="Search by label or external key..."
              value={registrySearch}
              onChange={(e) => setRegistrySearch(e.target.value)}
            />
            <Select
              value={registryStatusFilter}
              onChange={(e) => setRegistryStatusFilter(e.target.value as typeof registryStatusFilter)}
            >
              <Select.Option value="all">All</Select.Option>
              <Select.Option value="deployed">Deployed</Select.Option>
              <Select.Option value="not_deployed">Not deployed</Select.Option>
              <Select.Option value="failed">Failed</Select.Option>
            </Select>
          </Flex>
          <Table>
            <Table.Head>
              <Table.Row>
                <Table.Cell>{''}</Table.Cell>
                <Table.Cell>Label</Table.Cell>
                <Table.Cell>External Key</Table.Cell>
                <Table.Cell>Location</Table.Cell>
                <Table.Cell>Deploy Status</Table.Cell>
              </Table.Row>
            </Table.Head>
            <Table.Body>
              {filteredRegistryEntries.map((entry) => (
                <Table.Row key={entry.sys.id}>
                  <Table.Cell>
                    <Checkbox
                      id={`de-${entry.sys.id}`}
                      isChecked={selectedRegistryEntryId === entry.sys.id}
                      onChange={() =>
                        setSelectedRegistryEntryId((prev) => (prev === entry.sys.id ? null : entry.sys.id))
                      }
                    />
                  </Table.Cell>
                  <Table.Cell>{field<string>(entry, 'deLabel')}</Table.Cell>
                  <Table.Cell>{field<string>(entry, 'deExternalKey')}</Table.Cell>
                  <Table.Cell>
                    <Text fontColor="gray600">{locationLabel(entry)}</Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge variant={field<string>(entry, 'deployStatus') === 'deployed' ? 'positive' : 'warning'}>
                      {field<string>(entry, 'deployStatus')}
                    </Badge>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </Box>
      </Flex>

      <Flex
        gap="spacingS"
        style={{
          position: 'fixed',
          bottom: 0,
          left: 0,
          right: 0,
          background: '#fff',
          borderTop: '1px solid #e5ebed',
          padding: '16px 32px',
          zIndex: 10,
        }}
      >
        <Button variant="primary" isDisabled={!canLink} isLoading={busy} onClick={handleLink}>
          Link Selected
        </Button>
        <Button variant="negative" isDisabled={!canUnlink} isLoading={busy} onClick={handleUnlink}>
          Unlink Selected
        </Button>
        <Tooltip content="Re-copy every already-published entry of the selected content type into its linked Data Extension.">
          <Button variant="secondary" isDisabled={!canBackfill} isLoading={busy} onClick={handleBackfillSelected}>
            Backfill Now
          </Button>
        </Tooltip>
        <Tooltip content="Choose which fields sync into the linked Data Extension, then re-backfill.">
          <Button variant="secondary" isDisabled={!canEditFields} onClick={openEditFieldsModal}>
            Edit Fields
          </Button>
        </Tooltip>
      </Flex>

      <Modal
        isShown={isCreateModalOpen}
        onClose={() => !deployBusy && setIsCreateModalOpen(false)}
        size="medium"
      >
        {() => (
          <>
            <Modal.Header
              title="Create Net-New Data Extension"
              onClose={() => !deployBusy && setIsCreateModalOpen(false)}
            />
            <Modal.Content>
              <Paragraph>
                Creates a brand-new Data Extension in Marketing Cloud Engagement, with fields
                derived from the selected content type, and links it here. Only newly-created Data
                Extensions can be linked this way — existing DEs must be linked via the tables above.
              </Paragraph>
              {parentMid ? (
                <Note variant="neutral" style={{ marginBottom: 16 }}>
                  Created as a Shared Data Extension in parent BU {parentMid}, under Shared Data Extensions › Contentful. Child BUs reference
                  it as <code>ENT.&lt;name&gt;</code>. Choose which child BUs can see it in Marketing Cloud (Shared Data Extensions folder ›
                  sharing settings); this app doesn&apos;t change sharing.
                </Note>
              ) : (
                <Note variant="neutral" style={{ marginBottom: 16 }}>
                  Created in the Installed Package&apos;s default BU, under Data Extensions › Contentful. It won&apos;t be visible to other BUs.
                </Note>
              )}
              <FormControl>
                <FormControl.Label>Content Type</FormControl.Label>
                <Select
                  value={createContentTypeId}
                  onChange={(e) => setCreateContentTypeId(e.target.value)}
                  isDisabled={deployBusy}
                >
                  {contentTypes.map((ct) => (
                    <Select.Option key={ct.sys.id} value={ct.sys.id}>
                      {ct.name} ({ct.sys.id})
                    </Select.Option>
                  ))}
                </Select>
              </FormControl>
              <FormControl>
                <FormControl.Label>Extra field labels (optional)</FormControl.Label>
                <TextInput
                  value={extraFieldLabels}
                  onChange={(e) => setExtraFieldLabels(e.target.value)}
                  placeholder="e.g. Internal Notes, Campaign Code"
                  isDisabled={deployBusy}
                />
                <FormControl.HelpText>
                  Comma-separated labels for extra text fields beyond what's derived from the
                  content type's own fields. Link-type fields are not auto-derived and can be added
                  here as plain text if needed.
                </FormControl.HelpText>
              </FormControl>
              {createEligibleFields.length > 0 && (
                <FormControl>
                  <FormControl.Label>Fields to sync</FormControl.Label>
                  <Box style={{ maxHeight: 220, overflowY: 'auto' }}>
                    {createEligibleFields.map((f) => (
                      <Checkbox
                        key={f.id}
                        id={`create-field-${f.id}`}
                        isChecked={fieldSelection[f.id] ?? true}
                        isDisabled={deployBusy}
                        onChange={() =>
                          setFieldSelection((prev) => ({ ...prev, [f.id]: !(prev[f.id] ?? true) }))
                        }
                      >
                        {f.name} <Text fontColor="gray600">({f.id})</Text>
                      </Checkbox>
                    ))}
                  </Box>
                  <FormControl.HelpText>
                    Unchecked fields are left out of the Data Extension's schema (Link, Rich Text,
                    JSON and Location fields aren't eligible and aren't listed here).
                  </FormControl.HelpText>
                </FormControl>
              )}
              {deployStatusMessage && (
                <Flex alignItems="center" gap="spacingXs" marginTop="spacingS">
                  {deployBusy && <Spinner size="small" />}
                  <Text>{deployStatusMessage}</Text>
                </Flex>
              )}
              {deployError && (
                <Box marginTop="spacingS">
                  <Note variant="negative">{deployError}</Note>
                </Box>
              )}
            </Modal.Content>
            <Modal.Controls>
              <Button
                variant="secondary"
                onClick={() => setIsCreateModalOpen(false)}
                isDisabled={deployBusy}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleCreateNetNewDe}
                isDisabled={!createContentTypeId || deployBusy}
                isLoading={deployBusy}
              >
                Create &amp; Link
              </Button>
            </Modal.Controls>
          </>
        )}
      </Modal>

      <Modal
        isShown={isEditFieldsModalOpen}
        onClose={() => !editFieldsBusy && setIsEditFieldsModalOpen(false)}
        size="medium"
      >
        {() => (
          <>
            <Modal.Header
              title="Edit Synced Fields"
              onClose={() => !editFieldsBusy && setIsEditFieldsModalOpen(false)}
            />
            <Modal.Content>
              <Paragraph>
                Choose which fields of this content type sync into the linked Data Extension.
                Saving recomputes the field map and re-copies every already-published entry.
                Newly checked fields are added to the Data Extension as columns; unchecked fields keep their column but stop being written.
                Bookkeeping columns and any manually-added extra fields are kept as-is.
              </Paragraph>
              {selectedContentType && (
                <FormControl>
                  <FormControl.Label>Fields to sync</FormControl.Label>
                  <Box style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {(selectedContentType.fields as ContentTypeField[]).filter(isEligibleField).map((f) => (
                      <Checkbox
                        key={f.id}
                        id={`edit-field-${f.id}`}
                        isChecked={editFieldSelection[f.id] ?? true}
                        isDisabled={editFieldsBusy}
                        onChange={() =>
                          setEditFieldSelection((prev) => ({ ...prev, [f.id]: !(prev[f.id] ?? true) }))
                        }
                      >
                        {f.name} <Text fontColor="gray600">({f.id})</Text>
                      </Checkbox>
                    ))}
                  </Box>
                </FormControl>
              )}
              {editFieldsMessage && (
                <Flex alignItems="center" gap="spacingXs" marginTop="spacingS">
                  {editFieldsBusy && <Spinner size="small" />}
                  <Text>{editFieldsMessage}</Text>
                </Flex>
              )}
              {editFieldsError && (
                <Box marginTop="spacingS">
                  <Note variant="negative">{editFieldsError}</Note>
                </Box>
              )}
            </Modal.Content>
            <Modal.Controls>
              <Button
                variant="secondary"
                onClick={() => setIsEditFieldsModalOpen(false)}
                isDisabled={editFieldsBusy}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSaveFieldSelection}
                isDisabled={editFieldsBusy}
                isLoading={editFieldsBusy}
              >
                Save &amp; Re-sync
              </Button>
            </Modal.Controls>
          </>
        )}
      </Modal>
    </Box>
  );
};

export default Page;
