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

  it('says new Data Extensions are shared from the parent BU when a parent MID is configured', async () => {
    const { getByText } = render(<Page />);

    await waitFor(() => {
      expect(getByText(/created as Shared Data Extensions in parent BU 523012158/)).toBeInTheDocument();
    });
  });
});
