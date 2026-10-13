import { vi } from 'vitest';

const mockSdk = {
  app: {
    onConfigure: vi.fn(),
    getParameters: vi.fn().mockReturnValueOnce({}),
    setReady: vi.fn(),
    getCurrentState: vi.fn(),
  },
  ids: {
    app: 'test-app',
    space: 'test-space',
    environment: 'master',
  },
  locales: {
    default: 'en-US',
  },
  parameters: {
    installation: { MCE_PARENT_MID: '523012158' },
  },
};

export { mockSdk };
