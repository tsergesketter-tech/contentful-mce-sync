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

const REGISTRY_CONTENT_TYPE = 'dataExtensionRegistry';
const LINKAGE_CONTENT_TYPE = 'deSyncLinkage';
// The two content types that back this app itself are never sync targets.
const ADMIN_CONTENT_TYPES = new Set([REGISTRY_CONTENT_TYPE, LINKAGE_CONTENT_TYPE]);
// Sentinel for deSyncLinkage.pkContentfulFieldId meaning "use entry.sys.id as the business key" —
// for content types with no natural business-key field of their own.
const ENTRY_ID_SENTINEL = '__entryId';

function field<T = string>(entry: EntryProps, id: string): T | undefined {
  return entry.fields?.[id]?.['en-US'];
}

type AppActionIds = { spaceId: string; environmentId: string; appDefinitionId: string };

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollCallDetails(
  cma: CMAClient,
  params: AppActionIds & { appActionId: string; callId: string },
  { retries = 20, intervalMs = 1500 }: { retries?: number; intervalMs?: number } = {}
) {
  for (let i = 0; i < retries; i++) {
    try {
      const details: any = await cma.appActionCall.getCallDetails(params as any);
      if (details?.response) return details;
    } catch {
      // Call log isn't ready yet — keep retrying.
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for the app action to respond.');
}

// Both App Actions this app calls (createDataExtension, backfillDeRows) are synchronous — SFMC's
// SOAP CreateRequest and Data Extension Rows (Synchronous) REST API both return a final result in
// one round trip, unlike the Marketing-Object-sync app's async Salesforce deploy/Bulk-API jobs. No
// poll counterpart is needed; this still polls appActionCall.getCallDetails itself, since that's
// how the Contentful CMA surfaces any App Action's response regardless of how the Function inside
// it behaves.
async function callAppAction(
  cma: CMAClient,
  ids: AppActionIds,
  appActionId: string,
  parameters: Record<string, unknown>
): Promise<any> {
  const call = await cma.appActionCall.create({ ...ids, appActionId } as any, { parameters });
  const details = await pollCallDetails(cma, { ...ids, appActionId, callId: call.sys.id });
  const statusCode = details.response?.statusCode;
  const rawBody = details.response?.body;
  let body: any = rawBody;
  if (typeof rawBody === 'string') {
    try {
      body = JSON.parse(rawBody);
    } catch {
      // leave as raw string
    }
  }
  if (statusCode && statusCode >= 400) {
    throw new Error(`${appActionId} failed (${statusCode}): ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

// Copies every already-published entry of a content type into its just-linked Data Extension, so
// linking isn't limited to entries published from that point forward.
async function runBackfill(
  cma: CMAClient,
  ids: AppActionIds,
  params: { contentTypeId: string; deExternalKey: string; pkContentfulFieldId: string; deFields: unknown[] },
  onProgress?: (message: string) => void
): Promise<{ totalEntries: number; totalRows: number; processed: number }> {
  onProgress?.(`Copying existing ${params.contentTypeId} records into ${params.deExternalKey}...`);
  const result = await callAppAction(cma, ids, 'backfillDeRows', {
    contentTypeId: params.contentTypeId,
    deExternalKey: params.deExternalKey,
    pkContentfulFieldId: params.pkContentfulFieldId,
    deFieldsJson: JSON.stringify(params.deFields ?? []),
  });
  if (!result?.ok) throw new Error(result?.error || 'Backfill failed.');
  return {
    totalEntries: result.totalEntries ?? 0,
    totalRows: result.totalRows ?? 0,
    processed: result.processed ?? 0,
  };
}

function deFieldsOf(entry: EntryProps): unknown[] {
  return field<{ fields: unknown[] }>(entry, 'fieldMap')?.fields ?? [];
}

const Page = () => {
  const sdk = useSDK<PageAppSDK>();
  const cma = useCMA();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backfillMessage, setBackfillMessage] = useState<string | null>(null);
  const [contentTypes, setContentTypes] = useState<ContentTypeProps[]>([]);
  const [registryEntries, setRegistryEntries] = useState<EntryProps[]>([]);
  const [linkageEntries, setLinkageEntries] = useState<EntryProps[]>([]);

  const [selectedContentTypeId, setSelectedContentTypeId] = useState<string | null>(null);
  const [selectedRegistryEntryId, setSelectedRegistryEntryId] = useState<string | null>(null);

  const [contentTypeSearch, setContentTypeSearch] = useState('');
  const [contentTypeLinkFilter, setContentTypeLinkFilter] = useState<'all' | 'linked' | 'unlinked'>('all');
  const [registrySearch, setRegistrySearch] = useState('');
  const [registryStatusFilter, setRegistryStatusFilter] = useState<'all' | 'deployed' | 'not_deployed' | 'failed'>('all');

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createContentTypeId, setCreateContentTypeId] = useState<string>('');
  const [extraFieldLabels, setExtraFieldLabels] = useState('');
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployStatusMessage, setDeployStatusMessage] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ctRes, registryRes, linkageRes] = await Promise.all([
        cma.contentType.getMany({}),
        cma.entry.getMany({
          query: { content_type: REGISTRY_CONTENT_TYPE, limit: 1000, 'sys.archivedAt[exists]': false },
        }),
        cma.entry.getMany({
          query: { content_type: LINKAGE_CONTENT_TYPE, limit: 1000, 'sys.archivedAt[exists]': false },
        }),
      ]);
      setContentTypes(ctRes.items.filter((ct) => !ADMIN_CONTENT_TYPES.has(ct.sys.id)));
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

  const handleLink = async () => {
    if (!selectedContentTypeId || !selectedRegistryEntryId || !selectedContentType || !sdk.ids.app) return;
    setBusy(true);
    setError(null);
    setBackfillMessage(null);
    try {
      const linkField = {
        'en-US': { sys: { type: 'Link', linkType: 'Entry', id: selectedRegistryEntryId } },
      };
      let pkContentfulFieldId: string;
      if (existingLinkage) {
        pkContentfulFieldId = field<string>(existingLinkage, 'pkContentfulFieldId') ?? ENTRY_ID_SENTINEL;
        const updated: EntryProps = {
          ...existingLinkage,
          fields: {
            ...existingLinkage.fields,
            dataExtension: linkField,
            isActive: { 'en-US': true },
          },
        };
        const saved = await cma.entry.update({ entryId: existingLinkage.sys.id }, updated);
        await cma.entry.publish({ entryId: saved.sys.id }, saved);
      } else {
        pkContentfulFieldId = selectedContentType.displayField ?? 'internalName';
        const created = await cma.entry.create(
          { contentTypeId: LINKAGE_CONTENT_TYPE },
          {
            fields: {
              contentTypeId: { 'en-US': selectedContentTypeId },
              pkContentfulFieldId: { 'en-US': pkContentfulFieldId },
              dataExtension: linkField,
              isActive: { 'en-US': true },
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
            { contentTypeId: selectedContentTypeId, deExternalKey, pkContentfulFieldId, deFields: deFieldsOf(registryEntry) },
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
        { contentTypeId: selectedContentTypeId, deExternalKey, pkContentfulFieldId, deFields: deFieldsOf(registryEntry) },
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
        fields: { ...existingLinkage.fields, isActive: { 'en-US': false } },
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

  const openCreateModal = () => {
    setCreateContentTypeId(selectedContentTypeId ?? contentTypes[0]?.sys.id ?? '');
    setExtraFieldLabels('');
    setDeployError(null);
    setDeployStatusMessage(null);
    setIsCreateModalOpen(true);
  };

  const handleCreateNetNewDe = async () => {
    if (!createContentTypeId || !sdk.ids.app) return;
    const ids: AppActionIds = {
      spaceId: sdk.ids.space,
      environmentId: sdk.ids.environment,
      appDefinitionId: sdk.ids.app,
    };
    setDeployBusy(true);
    setDeployError(null);
    try {
      setDeployStatusMessage('Deriving schema and creating the Data Extension...');
      const createResult = await callAppAction(cma, ids, 'createDataExtension', {
        contentTypeId: createContentTypeId,
        extraFieldLabels: extraFieldLabels.trim() || undefined,
      });
      if (!createResult?.ok) throw new Error(createResult?.error || 'Failed to create the Data Extension.');

      setDeployStatusMessage(`Created ${createResult.deExternalKey}. Registering in Contentful...`);

      const registryEntry = await cma.entry.create(
        { contentTypeId: REGISTRY_CONTENT_TYPE },
        {
          fields: {
            deLabel: { 'en-US': createResult.deLabel },
            deExternalKey: { 'en-US': createResult.deExternalKey },
            pkFieldApiName: { 'en-US': createResult.pkFieldApiName },
            fieldMap: { 'en-US': { fields: createResult.fields } },
            excludedFieldIds: { 'en-US': createResult.excludedFieldIds ?? [] },
            deployStatus: { 'en-US': 'deployed' },
          },
        }
      );
      const publishedRegistry = await cma.entry.publish({ entryId: registryEntry.sys.id }, registryEntry);

      const linkField = {
        'en-US': { sys: { type: 'Link', linkType: 'Entry', id: publishedRegistry.sys.id } },
      };
      const existing = linkageByContentType.get(createContentTypeId);
      if (existing) {
        const updated: EntryProps = {
          ...existing,
          fields: {
            ...existing.fields,
            pkContentfulFieldId: { 'en-US': ENTRY_ID_SENTINEL },
            dataExtension: linkField,
            isActive: { 'en-US': true },
          },
        };
        const saved = await cma.entry.update({ entryId: existing.sys.id }, updated);
        await cma.entry.publish({ entryId: saved.sys.id }, saved);
      } else {
        const linkageEntry = await cma.entry.create(
          { contentTypeId: LINKAGE_CONTENT_TYPE },
          {
            fields: {
              contentTypeId: { 'en-US': createContentTypeId },
              pkContentfulFieldId: { 'en-US': ENTRY_ID_SENTINEL },
              dataExtension: linkField,
              isActive: { 'en-US': true },
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
    </Box>
  );
};

export default Page;
