import { vi } from 'vitest';

const mockCma = {
  contentType: { getMany: vi.fn().mockResolvedValue({ items: [] }) },
  entry: { getMany: vi.fn().mockResolvedValue({ items: [] }) },
};

export { mockCma };
