import { useCallback, useEffect, useState } from 'react';
import { ConfigAppSDK } from '@contentful/app-sdk';
import { useSDK } from '@contentful/react-apps-toolkit';
import { Box, Flex, Form, FormControl, Heading, Note, Paragraph, TextInput } from '@contentful/f36-components';

// Read by ../../functions/paloniaEngagementSync.ts (readCfParams) at publish-event time — keep
// field ids in lockstep with that file's appInstallationParameters reads.
export interface AppInstallationParameters {
  CF_SPACE_ID?: string;
  CF_ENVIRONMENT_ID?: string;
  CF_CDA_TOKEN?: string;
  MCE_AUTH_BASE_URL?: string;
  MCE_REST_BASE_URL?: string;
  MCE_SOAP_BASE_URL?: string;
  MCE_CLIENT_ID?: string;
  MCE_CLIENT_SECRET?: string;
}

const DEFAULTS: AppInstallationParameters = {
  CF_ENVIRONMENT_ID: 'master',
};

const ConfigScreen = () => {
  const [parameters, setParameters] = useState<AppInstallationParameters>(DEFAULTS);
  const sdk = useSDK<ConfigAppSDK>();

  const onConfigure = useCallback(async () => {
    const currentState = await sdk.app.getCurrentState();
    // Secret-type params (CF_CDA_TOKEN, MCE_CLIENT_ID, MCE_CLIENT_SECRET) are write-only —
    // getParameters() can never return their real value, so the form renders them blank even
    // when already saved. Omit any blank field on submit so an untouched Secret keeps its
    // previously stored value instead of being overwritten with an empty string.
    const toSubmit = Object.fromEntries(
      Object.entries(parameters).filter(([, value]) => value !== '' && value !== undefined)
    );
    return {
      parameters: toSubmit,
      targetState: currentState,
    };
  }, [parameters, sdk]);

  useEffect(() => {
    sdk.app.onConfigure(() => onConfigure());
  }, [sdk, onConfigure]);

  useEffect(() => {
    (async () => {
      const currentParameters = await sdk.app.getParameters<AppInstallationParameters>();
      if (currentParameters) {
        setParameters({ ...DEFAULTS, ...currentParameters });
      }
      sdk.app.setReady();
    })();
  }, [sdk]);

  const set =
    (id: keyof AppInstallationParameters) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setParameters((p) => ({ ...p, [id]: e.target.value }));

  return (
    <Box padding="spacingXl" style={{ maxWidth: 640, margin: '0 auto' }}>
      <Heading>Data Extension Sync — Configuration</Heading>
      <Paragraph>
        Credentials this app's Data Extension sync Function uses when a linked content type is
        published/unpublished/deleted, and when creating a brand-new Data Extension from this
        app's page. Values here are private to this app installation.
      </Paragraph>

      <Form>
        <FormControl isRequired>
          <FormControl.Label>Contentful Space Id</FormControl.Label>
          <TextInput value={parameters.CF_SPACE_ID ?? ''} onChange={set('CF_SPACE_ID')} />
          <FormControl.HelpText>
            This app's own space — the Function reads it back via the CDA to resolve deSyncLinkage/
            dataExtensionRegistry entries.
          </FormControl.HelpText>
        </FormControl>

        <FormControl>
          <FormControl.Label>Contentful Environment Id</FormControl.Label>
          <TextInput value={parameters.CF_ENVIRONMENT_ID ?? ''} onChange={set('CF_ENVIRONMENT_ID')} />
        </FormControl>

        <FormControl isRequired>
          <FormControl.Label>Contentful CDA Token</FormControl.Label>
          <TextInput type="password" value={parameters.CF_CDA_TOKEN ?? ''} onChange={set('CF_CDA_TOKEN')} />
          <FormControl.HelpText>
            Secret — can't be displayed once saved. Leave blank to keep the currently saved value.
          </FormControl.HelpText>
        </FormControl>

        <FormControl isRequired>
          <FormControl.Label>MCE Auth Base URL</FormControl.Label>
          <TextInput
            value={parameters.MCE_AUTH_BASE_URL ?? ''}
            onChange={set('MCE_AUTH_BASE_URL')}
            placeholder="https://YOUR_SUBDOMAIN.auth.marketingcloudapis.com/"
          />
        </FormControl>

        <FormControl isRequired>
          <FormControl.Label>MCE REST Base URL</FormControl.Label>
          <TextInput
            value={parameters.MCE_REST_BASE_URL ?? ''}
            onChange={set('MCE_REST_BASE_URL')}
            placeholder="https://YOUR_SUBDOMAIN.rest.marketingcloudapis.com/"
          />
        </FormControl>

        <FormControl isRequired>
          <FormControl.Label>MCE SOAP Base URL</FormControl.Label>
          <TextInput
            value={parameters.MCE_SOAP_BASE_URL ?? ''}
            onChange={set('MCE_SOAP_BASE_URL')}
            placeholder="https://YOUR_SUBDOMAIN.soap.marketingcloudapis.com/"
          />
        </FormControl>

        <FormControl isRequired>
          <FormControl.Label>Installed Package Client ID</FormControl.Label>
          <TextInput type="password" value={parameters.MCE_CLIENT_ID ?? ''} onChange={set('MCE_CLIENT_ID')} />
          <FormControl.HelpText>
            Secret — can't be displayed once saved. Leave blank to keep the currently saved value.
          </FormControl.HelpText>
        </FormControl>

        <FormControl isRequired>
          <FormControl.Label>Installed Package Client Secret</FormControl.Label>
          <TextInput type="password" value={parameters.MCE_CLIENT_SECRET ?? ''} onChange={set('MCE_CLIENT_SECRET')} />
          <FormControl.HelpText>
            Secret — can't be displayed once saved. Leave blank to keep the currently saved value.
          </FormControl.HelpText>
        </FormControl>
      </Form>

      <Flex marginTop="spacingM">
        <Note variant="primary">
          Save with the button in the top bar. Contentful calls back into this screen to persist
          these values on the app installation.
        </Note>
      </Flex>
    </Box>
  );
};

export default ConfigScreen;
