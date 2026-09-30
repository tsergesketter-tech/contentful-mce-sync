import { locations } from '@contentful/app-sdk';
import { useSDK } from '@contentful/react-apps-toolkit';
import ConfigScreen from './locations/ConfigScreen';
import Page from './locations/Page';

const LOCATION_TO_COMPONENT: Record<string, () => JSX.Element> = {
  [locations.LOCATION_APP_CONFIG]: ConfigScreen,
  [locations.LOCATION_PAGE]: Page,
};

const App = () => {
  const sdk = useSDK();
  const entry = Object.entries(LOCATION_TO_COMPONENT).find(([location]) => sdk.location.is(location));
  const Component = entry?.[1] ?? Page;
  return <Component />;
};

export default App;
