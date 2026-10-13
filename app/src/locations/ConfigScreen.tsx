import { useCallback, useEffect, useState } from 'react';
import { ConfigAppSDK } from '@contentful/app-sdk';
import { useSDK } from '@contentful/react-apps-toolkit';
import { Box, Button, Flex, Form, FormControl, Heading, Note, Paragraph, TextInput } from '@contentful/f36-components';
import { ensureRegistryContentTypes, LINKAGE_CONTENT_TYPE, REGISTRY_CONTENT_TYPE } from '../lib/registryContentTypes';
import { callAppAction, type CheckConnectionResult } from '../lib/appActions';

// Read by ../../functions/lib/mceAuth.ts (readMceCreds) — keep field ids in lockstep. One
// Marketing Cloud Engagement credential set for the whole app; every Function authenticates with
// it. MCE_CLIENT_ID/MCE_CLIENT_SECRET must be declared as `Secret` installation parameters on the
// App Definition (scripts/setup-app-definition.mjs), so the browser never sees their stored values.
export interface AppInstallationParameters {
  MCE_AUTH_BASE_URL?: string;
  MCE_REST_BASE_URL?: string;
  MCE_SOAP_BASE_URL?: string;
  MCE_CLIENT_ID?: string;
  MCE_CLIENT_SECRET?: string;
  /** Parent (Enterprise) BU MID. Set = new DEs are Shared Data Extensions in that BU. */
  MCE_PARENT_MID?: string;
}

const SECRET_KEYS: Array<keyof AppInstallationParameters> = ['MCE_CLIENT_ID', 'MCE_CLIENT_SECRET'];
const URL_KEYS = [
  ['MCE_AUTH_BASE_URL', 'auth'],
  ['MCE_REST_BASE_URL', 'rest'],
  ['MCE_SOAP_BASE_URL', 'soap'],
] as const;

export function isValidMceUrl(url: string, kind: 'auth' | 'rest' | 'soap'): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && new RegExp(`^[a-z0-9-]+\\.${kind}\\.marketingcloudapis\\.com$`, 'i').test(parsed.hostname);
  } catch {
    return false;
  }
}

type ConnectionState = { status: 'idle' | 'busy' | 'done' | 'error'; message?: string };

const ConfigScreen = () => {
  const sdk = useSDK<ConfigAppSDK>();
  const [parameters, setParameters] = useState<AppInstallationParameters>({});
  const [isInstalled, setIsInstalled] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>({ status: 'idle' });

  const onConfigure = useCallback(async () => {
    const badUrl = URL_KEYS.find(([key, kind]) => !isValidMceUrl(parameters[key] ?? '', kind));
    if (badUrl) {
      sdk.notifier.error(`Enter the ${badUrl[1].toUpperCase()} base URL like https://YOUR_SUBDOMAIN.${badUrl[1]}.marketingcloudapis.com/.`);
      return false;
    }
    if (parameters.MCE_PARENT_MID && !/^\d+$/.test(parameters.MCE_PARENT_MID.trim())) {
      sdk.notifier.error('The parent BU MID is a number, e.g. 523012158.');
      return false;
    }
    // Secrets are redacted on every browser-side read, so they're rendered blank. A blank secret
    // means "keep what's stored" once installed; on first install it's simply missing.
    if (!isInstalled && SECRET_KEYS.some((k) => !parameters[k])) {
      sdk.notifier.error('Enter the Installed Package client ID and secret.');
      return false;
    }

    try {
      await ensureRegistryContentTypes(sdk.cma, sdk.locales.default);
    } catch (e) {
      sdk.notifier.error(`Could not create this app's content types: ${(e as Error).message}`);
      return false;
    }

    // Omit blank values so an untouched secret is never overwritten with an empty string. The
    // parent MID is the exception: clearing it is how you switch back to the default BU.
    const toSubmit = Object.fromEntries(
      Object.entries(parameters).filter(([key, value]) => key === 'MCE_PARENT_MID' || (value !== '' && value !== undefined)),
    );
    toSubmit.MCE_PARENT_MID = (parameters.MCE_PARENT_MID ?? '').trim();
    return { parameters: toSubmit, targetState: await sdk.app.getCurrentState() };
  }, [parameters, isInstalled, sdk]);

  useEffect(() => {
    sdk.app.onConfigure(() => onConfigure());
  }, [sdk, onConfigure]);

  useEffect(() => {
    (async () => {
      const [installed, current] = await Promise.all([sdk.app.isInstalled(), sdk.app.getParameters<AppInstallationParameters>()]);
      setIsInstalled(installed);
      // Never pre-fill secrets — the SDK only ever returns a redacted placeholder for them.
      setParameters({
        MCE_AUTH_BASE_URL: current?.MCE_AUTH_BASE_URL ?? '',
        MCE_REST_BASE_URL: current?.MCE_REST_BASE_URL ?? '',
        MCE_SOAP_BASE_URL: current?.MCE_SOAP_BASE_URL ?? '',
        MCE_PARENT_MID: current?.MCE_PARENT_MID ?? '',
      });
      sdk.app.setReady();
    })();
  }, [sdk]);

  const checkConnection = useCallback(async () => {
    if (!sdk.ids.app) return;
    setConnection({ status: 'busy', message: 'Checking the Marketing Cloud connection...' });
    try {
      const result = await callAppAction<CheckConnectionResult>(
        sdk.cma,
        { spaceId: sdk.ids.space, environmentId: sdk.ids.environment, appDefinitionId: sdk.ids.app },
        'checkMceConnection',
        {},
        { idempotent: true },
      );
      setConnection(result.ok ? { status: 'done', message: result.message } : { status: 'error', message: result.error });
    } catch (e) {
      setConnection({ status: 'error', message: (e as Error).message });
    }
  }, [sdk]);

  // Check after every successful save, so a wrong secret or MID shows up immediately. App Actions
  // only run on an installed app, so this is the earliest point it can.
  useEffect(() => {
    sdk.app.onConfigurationCompleted((err) => {
      if (err) return;
      setIsInstalled(true);
      void checkConnection();
    });
  }, [sdk, checkConnection]);

  const set = (id: keyof AppInstallationParameters) => (e: React.ChangeEvent<HTMLInputElement>) => setParameters((p) => ({ ...p, [id]: e.target.value }));

  const secretHelp = isInstalled
    ? 'Stored securely and never shown again. Leave blank to keep the saved value, or type a new one to replace it.'
    : 'Stored securely and never shown again after saving.';

  return (
    <Box padding="spacingXl" style={{ maxWidth: 720, margin: '0 auto' }}>
      <Heading>Set up Marketing Cloud Engagement Sync</Heading>
      <Paragraph>
        Connect this space to a Marketing Cloud Engagement account to sync content types into Data Extensions. You need a Server-to-Server
        Installed Package with Data Extensions read and write scope; see the README for the full setup.
      </Paragraph>

      <Form>
        <Heading as="h2" marginTop="spacingL">
          Marketing Cloud connection
        </Heading>
        <FormControl isRequired>
          <FormControl.Label>Auth base URL</FormControl.Label>
          <TextInput value={parameters.MCE_AUTH_BASE_URL ?? ''} onChange={set('MCE_AUTH_BASE_URL')} placeholder="https://YOUR_SUBDOMAIN.auth.marketingcloudapis.com/" />
        </FormControl>
        <FormControl isRequired>
          <FormControl.Label>REST base URL</FormControl.Label>
          <TextInput value={parameters.MCE_REST_BASE_URL ?? ''} onChange={set('MCE_REST_BASE_URL')} placeholder="https://YOUR_SUBDOMAIN.rest.marketingcloudapis.com/" />
        </FormControl>
        <FormControl isRequired>
          <FormControl.Label>SOAP base URL</FormControl.Label>
          <TextInput value={parameters.MCE_SOAP_BASE_URL ?? ''} onChange={set('MCE_SOAP_BASE_URL')} placeholder="https://YOUR_SUBDOMAIN.soap.marketingcloudapis.com/" />
          <FormControl.HelpText>All three are shown on the Installed Package&apos;s API Integration component.</FormControl.HelpText>
        </FormControl>
        <FormControl isRequired={!isInstalled}>
          <FormControl.Label>Installed Package client ID</FormControl.Label>
          <TextInput type="password" value={parameters.MCE_CLIENT_ID ?? ''} onChange={set('MCE_CLIENT_ID')} />
          <FormControl.HelpText>{secretHelp}</FormControl.HelpText>
        </FormControl>
        <FormControl isRequired={!isInstalled}>
          <FormControl.Label>Installed Package client secret</FormControl.Label>
          <TextInput type="password" value={parameters.MCE_CLIENT_SECRET ?? ''} onChange={set('MCE_CLIENT_SECRET')} />
          <FormControl.HelpText>{secretHelp}</FormControl.HelpText>
        </FormControl>

        <Heading as="h2" marginTop="spacingL">
          Business units
        </Heading>
        <Paragraph>
          To make Contentful content available to child business units, set the parent (Enterprise) BU&apos;s MID. New Data Extensions are then
          created as Shared Data Extensions in the parent BU, and every row is written there. Which child BUs can see each one is configured in
          Marketing Cloud. Leave it blank to create regular Data Extensions in the Installed Package&apos;s default BU.
        </Paragraph>
        <FormControl>
          <FormControl.Label>Parent BU MID</FormControl.Label>
          <TextInput value={parameters.MCE_PARENT_MID ?? ''} onChange={set('MCE_PARENT_MID')} placeholder="e.g. 523012158" />
          <FormControl.HelpText>
            The Installed Package must be created in, or granted access to, this BU. Changing it only affects Data Extensions created afterwards.
          </FormControl.HelpText>
        </FormControl>

        <Box marginTop="spacingM">
          {isInstalled ? (
            <Flex flexDirection="column" alignItems="flex-start" gap="spacingS">
              <Button variant="secondary" onClick={checkConnection} isLoading={connection.status === 'busy'} isDisabled={connection.status === 'busy'}>
                Check connection
              </Button>
              {connection.message && (
                <Note variant={connection.status === 'done' ? 'positive' : connection.status === 'busy' ? 'neutral' : 'negative'}>{connection.message}</Note>
              )}
            </Flex>
          ) : (
            <Note variant="neutral">The connection is checked automatically after the app is installed.</Note>
          )}
        </Box>

        <Heading as="h2" marginTop="spacingL">
          Content types created by this app
        </Heading>
        <Paragraph>
          Saving creates two content types if they don&apos;t exist yet — <code>{REGISTRY_CONTENT_TYPE}</code> and <code>{LINKAGE_CONTENT_TYPE}</code> —
          which hold which content types sync to which Data Extensions. Manage them from this app&apos;s page rather than editing entries directly.
        </Paragraph>
      </Form>
    </Box>
  );
};

export default ConfigScreen;
