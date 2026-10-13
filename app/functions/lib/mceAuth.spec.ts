import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMceToken, joinUrl, missingCredsError, type MceCreds } from './mceAuth';

const creds: MceCreds = {
  authBaseUrl: 'https://x.auth.marketingcloudapis.com/',
  restBaseUrl: 'https://x.rest.marketingcloudapis.com/',
  soapBaseUrl: 'https://x.soap.marketingcloudapis.com/',
  clientId: 'id',
  clientSecret: 'secret',
  parentMid: '',
};

afterEach(() => vi.unstubAllGlobals());

describe('joinUrl', () => {
  it('joins regardless of slashes', () => {
    expect(joinUrl('https://a/', '/v2/token')).toBe('https://a/v2/token');
    expect(joinUrl('https://a', 'v2/token')).toBe('https://a/v2/token');
  });
});

describe('missingCredsError', () => {
  it('names only what the caller needs', () => {
    expect(missingCredsError({ ...creds, soapBaseUrl: '' }, ['rest'])).toBeNull();
    expect(missingCredsError({ ...creds, soapBaseUrl: '' }, ['soap'])).toContain('MCE_SOAP_BASE_URL');
  });
});

describe('getMceToken', () => {
  it('sends account_id for a BU and caches tokens per BU', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({ access_token: `tok-${body.account_id ?? 'default'}`, expires_in: 1080 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const c = { ...creds, clientId: 'cache-test' };

    expect((await getMceToken(c, '523012158')).accessToken).toBe('tok-523012158');
    expect((await getMceToken(c)).accessToken).toBe('tok-default');
    expect((await getMceToken(c, '523012158')).accessToken).toBe('tok-523012158');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ grant_type: 'client_credentials', account_id: 523012158 });
  });

  it('names the BU when auth fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no access', { status: 401 })));
    await expect(getMceToken({ ...creds, clientId: 'fail-test' }, '42')).rejects.toThrow('for business unit 42');
  });
});
