import { describe, expect, it } from 'vitest';
import { extractEventType } from './entryPublishSync';

describe('extractEventType', () => {
  it('reads the topic header case-insensitively, including array values', () => {
    expect(extractEventType({ 'X-Contentful-Topic': 'ContentManagement.Entry.publish' })).toBe('publish');
    expect(extractEventType({ 'x-contentful-topic': ['ContentManagement.Entry.unpublish'] })).toBe('unpublish');
  });
  it('returns null when the header is missing or empty', () => {
    expect(extractEventType(undefined)).toBeNull();
    expect(extractEventType({ 'X-Contentful-Topic': '' })).toBeNull();
  });
});
