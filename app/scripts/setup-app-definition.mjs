#!/usr/bin/env node
// One-time (idempotent) App Definition setup that `contentful-app-scripts upload` doesn't cover:
//   1. Declares the installation parameters, with the Installed Package client id/secret as
//      `Secret` so Contentful redacts them from every browser and CMA read.
//   2. Subscribes the `entryPublishSync` Function to Entry.publish/Entry.unpublish App Events.
//      Without this, publishing never syncs — only the Page's backfill writes rows.
// Run after the first `npm run upload` (the Function must exist before it can be subscribed):
//   CONTENTFUL_ACCESS_TOKEN=... CONTENTFUL_ORG_ID=... CONTENTFUL_APP_DEF_ID=... npm run setup-app-definition
const { CONTENTFUL_ACCESS_TOKEN: token, CONTENTFUL_ORG_ID: orgId, CONTENTFUL_APP_DEF_ID: appDefId } = process.env;
if (!token || !orgId || !appDefId) {
  console.error('Set CONTENTFUL_ACCESS_TOKEN, CONTENTFUL_ORG_ID and CONTENTFUL_APP_DEF_ID.');
  process.exit(1);
}

const base = `https://api.contentful.com/organizations/${orgId}/app_definitions/${appDefId}`;
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.contentful.management.v1+json' };

async function request(method, url, body) {
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${url} failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

// Contentful caps each parameter `name` at 64 characters.
const INSTALLATION_PARAMETERS = [
  { id: 'MCE_AUTH_BASE_URL', name: 'Marketing Cloud auth base URL', type: 'Symbol', required: true },
  { id: 'MCE_REST_BASE_URL', name: 'Marketing Cloud REST base URL', type: 'Symbol', required: true },
  { id: 'MCE_SOAP_BASE_URL', name: 'Marketing Cloud SOAP base URL', type: 'Symbol', required: true },
  { id: 'MCE_CLIENT_ID', name: 'Installed Package client ID', type: 'Secret', required: true },
  { id: 'MCE_CLIENT_SECRET', name: 'Installed Package client secret', type: 'Secret', required: true },
  { id: 'MCE_PARENT_MID', name: 'Parent (Enterprise) BU MID for Shared Data Extensions', type: 'Symbol', required: false },
];

const definition = await request('GET', base);
// App definitions aren't versioned (no sys.version), so a plain PUT of the full body is the update.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { sys, ...rest } = definition;
await request('PUT', base, {
  ...rest,
  parameters: { ...(definition.parameters ?? {}), installation: INSTALLATION_PARAMETERS },
});
console.log('Installation parameters declared (MCE_CLIENT_ID/MCE_CLIENT_SECRET as Secret).');

await request('PUT', `${base}/event_subscription`, {
  topics: ['Entry.publish', 'Entry.unpublish'],
  functions: { handler: { sys: { type: 'Link', linkType: 'Function', id: 'entryPublishSync' } } },
});
console.log('App Event subscription set: Entry.publish, Entry.unpublish → entryPublishSync.');
