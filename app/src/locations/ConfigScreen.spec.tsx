import { describe, expect, it } from 'vitest';
import { isValidMceUrl } from './ConfigScreen';

describe('isValidMceUrl', () => {
  it('accepts tenant base URLs of the matching kind only', () => {
    expect(isValidMceUrl('https://mc123.auth.marketingcloudapis.com/', 'auth')).toBe(true);
    expect(isValidMceUrl('https://mc123.rest.marketingcloudapis.com/', 'auth')).toBe(false);
    expect(isValidMceUrl('http://mc123.soap.marketingcloudapis.com/', 'soap')).toBe(false);
    expect(isValidMceUrl('https://evil.example.com/.soap.marketingcloudapis.com', 'soap')).toBe(false);
  });
});
