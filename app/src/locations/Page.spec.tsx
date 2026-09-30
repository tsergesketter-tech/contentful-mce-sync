import Page from './Page';
import { render, waitFor } from '@testing-library/react';
import { mockCma, mockSdk } from '../../test/mocks';
import { vi } from 'vitest';

vi.mock('@contentful/react-apps-toolkit', () => ({
  useSDK: () => mockSdk,
  useCMA: () => mockCma,
}));

describe('Page component', () => {
  it('loads and shows the sync admin heading', async () => {
    const { getByText } = render(<Page />);

    await waitFor(() => {
      expect(getByText('Data Extension Sync')).toBeInTheDocument();
    });
  });
});
