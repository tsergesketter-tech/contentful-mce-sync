# Contentful → Marketing Cloud Engagement Data Extension Sync

A Contentful App that lets you take **any** content type in your space and sync it into a
Salesforce Marketing Cloud Engagement (SFMC) **Data Extension** — create the DE's schema in MCE
(if it doesn't exist yet), backfill every already-published entry, and keep it in sync on every
future publish/unpublish/delete. No pre-existing Data Extension is required to get started; the
app can create one for you.

Routing is entirely driven by two content types the app manages in your own space
(`dataExtensionRegistry` and `deSyncLinkage`) — there are no hardcoded content-type or Data
Extension names anywhere in the code. Link as many content types to as many Data Extensions as
you want.

This app is a sibling to `contentful-mo-sync` (which targets classic Salesforce core-org
Marketing Objects) — same UI/UX pattern, same registry-driven routing, but targeting SFMC Data
Extensions instead, over SOAP (schema) + REST (rows) rather than Metadata REST + Bulk API 2.0.

## What this actually is

- A Contentful **App** (Page + Configure screen, built with React/Forma 36) that runs inside
  Contentful's Apps UI.
- Two **App Action** Functions it calls to talk to Marketing Cloud Engagement: derive-and-create
  a new DE schema (`createDataExtension`, synchronous — see below) and backfill existing entries
  (`backfillDeRows`, also synchronous).
- One **App Event Handler** Function (`paloniaEngagementSync`) that fires on every
  `Entry.publish`/`unpublish`/`delete` in the space, checks whether the entry's content type has
  an active `deSyncLinkage`, and if so upserts/deactivates the corresponding DE rows.
- Two Contentful content types (`dataExtensionRegistry`, `deSyncLinkage`) that make the whole
  thing config-driven instead of hardcoded — see `migrations/02-de-sync-registry.js`.

## Architecture

```
Contentful Apps UI ("Data Extension Sync" page)
   │  create/link/unlink/backfill, backed by the contentful-management SDK
   ▼
dataExtensionRegistry / deSyncLinkage  (content types in your own space — the routing table)
   │
   ├─ App Action: createDataExtension → derives a schema from a content type's fields, creates
   │                                      the DE via SOAP Partner API CreateRequest — synchronous,
   │                                      no polling needed (unlike MO-sync's Metadata REST deploy)
   │
   ├─ App Action: backfillDeRows → CMA-reads every published entry of a content type, maps to DE
   │                                 rows, upserts via the Data Extension Rows (Synchronous) REST
   │                                 rowset endpoint — synchronous, no polling needed (unlike
   │                                 MO-sync's Bulk API 2.0 job)
   │
   └─ App Event Handler: paloniaEngagementSync → fires on every Entry.publish/unpublish/delete,
                          looks up the active deSyncLinkage for that content type, and (if found)
                          upserts/deactivates that entry's DE rows via the same rowset endpoint
```

Every Function authenticates to Marketing Cloud Engagement independently via OAuth 2.0 Client
Credentials against an Installed Package (`MCE_AUTH_BASE_URL`/`MCE_CLIENT_ID`/`MCE_CLIENT_SECRET`,
read from this app's installation parameters) — there's no session shared with MCE beyond that
token exchange.

**Why no polling:** unlike Salesforce core-org's async Metadata deploy and Bulk API 2.0 jobs, both
SFMC operations this app needs are genuinely synchronous — SOAP `CreateRequest` for a DE returns
`OverallStatus` in the same response, and the Data Extension Rows (Synchronous) REST API is, as
its name says, synchronous. This was confirmed against a live tenant before building the app
around it, not assumed.

**No delete:** the SFMC REST API for DE rows has no delete operation, only upsert (`PUT`/`POST`
under `/hub/v1/dataevents/`). Unpublish/delete events are handled the same way `contentful-mo-sync`
handles them — a soft-deactivate upsert that sets `IsActive` to `false` rather than removing the row.

## Prerequisites

- A Contentful space on a plan with App Framework access (Functions + custom Apps).
- The Contentful CLI (`npm i -g contentful-cli` or use `npx`) authenticated
  (`contentful login`), for running the registry migration.
- A Marketing Cloud Engagement **Installed Package** (Setup → Platform Tools → Apps →
  Installed Packages) with a **Server-to-Server** (or API Integration) component configured for
  OAuth 2.0 Client Credentials, granted:
  - `Data Extensions` — Read and Write (needed for both DE schema creation via SOAP and row
    upserts via REST).
- Your tenant's three MCE base URLs (Installed Package's API Integration component shows these):
  Auth (`https://<subdomain>.auth.marketingcloudapis.com/`), REST
  (`https://<subdomain>.rest.marketingcloudapis.com/`), and SOAP
  (`https://<subdomain>.soap.marketingcloudapis.com/`).

## Install

1. **Point the manifest at your tenant.** Edit `app/contentful-app-manifest.json` and replace
   every `YOUR_SUBDOMAIN.{auth,rest,soap}.marketingcloudapis.com` placeholder in the
   `allowNetworks` arrays with your real MCE subdomain — Contentful Functions can only call hosts
   explicitly allowed here.

2. **Scaffold and upload the app**, from `app/`:
   ```bash
   npm install
   npx contentful-app-scripts create-app-definition   # first time only — creates the App Definition
   npm run build
   npm run upload
   ```
   (Standard `create-contentful-app` flow — see `app/README.md` for what each script does.)

3. **Run the registry migration** against your space, so `dataExtensionRegistry` and
   `deSyncLinkage` exist:
   ```bash
   npx contentful space migration --space-id $CF_SPACE_ID --environment-id master \
       migrations/02-de-sync-registry.js
   ```

4. **Install the app** on your space (Contentful web app → Apps → your app → Install), then open
   its **Configure** screen and fill in:
   - Contentful Space Id / Environment Id — this app's own space, read back via the CDA.
   - Contentful CDA Token (Settings → API keys → Content Delivery API access token).
   - MCE Auth/REST/SOAP Base URLs, Installed Package Client ID, Installed Package Client Secret.

5. **Link a content type to a Data Extension**, from the app's Page tab:
   - **Brand-new DE:** click **Create Net-New Data Extension**, pick a content type, optionally
     add extra field labels, click **Create & Link**. This derives a schema from the content
     type's fields, creates the DE in Marketing Cloud Engagement via SOAP, registers it in
     `dataExtensionRegistry`, creates the `deSyncLinkage`, and backfills every already-published
     entry — all in one step.
   - **Existing DE:** create and publish a `dataExtensionRegistry` entry by hand in the
     Contentful web app (see field reference below — at minimum `deLabel`, `deExternalKey`,
     `pkFieldApiName`), then on the Page tab select the content type and that registry row and
     click **Link Selected**. This also runs an initial backfill automatically.
   - **Backfill Now** / **Unlink Selected** are available any time for a linked content type.

From this point on, publishing, unpublishing, or deleting any entry of a linked content type
syncs automatically — no further action needed.

## Configuration reference

### App installation parameters (Configure screen)

| Parameter | Required | Description |
|---|---|---|
| `CF_SPACE_ID` | Yes | This app's own Contentful space id. |
| `CF_ENVIRONMENT_ID` | No (default `master`) | This app's own environment id. |
| `CF_CDA_TOKEN` | Yes | Content Delivery API token for the same space. Secret — write-only once saved. |
| `MCE_AUTH_BASE_URL` | Yes | Tenant's auth base URL, e.g. `https://<subdomain>.auth.marketingcloudapis.com/`. |
| `MCE_REST_BASE_URL` | Yes | Tenant's REST base URL, e.g. `https://<subdomain>.rest.marketingcloudapis.com/`. |
| `MCE_SOAP_BASE_URL` | Yes | Tenant's SOAP base URL, e.g. `https://<subdomain>.soap.marketingcloudapis.com/`. |
| `MCE_CLIENT_ID` | Yes | Installed Package Client ID. Secret. |
| `MCE_CLIENT_SECRET` | Yes | Installed Package Client Secret. Secret. |

### `dataExtensionRegistry` fields

| Field | Description |
|---|---|
| `deLabel` | Display label. |
| `deExternalKey` | Data Extension `CustomerKey`/external key in Marketing Cloud Engagement. Unique. Unlike Salesforce Marketing Objects, DE external keys/field names have no required suffix (plain PascalCase, e.g. `TravelOffer_DE`, not `__mo`/`__c`). |
| `pkFieldApiName` | The DE field used as the rowset upsert key. Defaults to `ExternalKey`. |
| `fieldMap` | JSON object `{ fields: [{ apiName, label, fieldType, length?, contentfulFieldId? }] }` — the derived or hand-authored field mapping. |
| `excludedFieldIds` | Contentful field ids to skip. |
| `deployStatus` | `not_deployed` / `deployed` / `failed` — set automatically by the net-new-DE flow. |
| `lastDeployError` | Set automatically by the net-new-DE flow. |

### `deSyncLinkage` fields

| Field | Description |
|---|---|
| `contentTypeId` | The Contentful content type id this row routes. Unique. |
| `pkContentfulFieldId` | Which Contentful field supplies the business-key half of the DE row's `ExternalKey` (or the sentinel `__entryId` to use the entry id itself). |
| `dataExtension` | Link to the `dataExtensionRegistry` entry this content type syncs into. |
| `isActive` | Soft on/off switch — **Unlink Selected** sets this `false` rather than deleting the row. |

## What this deliberately leaves out

- **Row delete.** The Data Extension Rows (Synchronous) REST API has no delete operation for DE
  rows — confirmed by reading the full API reference and by a live 404 test against a real
  tenant, not assumed. Unpublish/delete are handled as a soft-deactivate upsert instead (see
  Architecture above).
- **A Flow-CRUD alternative pathway.** `contentful-mo-sync` ships one (`flow-crud/`, two
  Salesforce Flows for on-demand upsert/deactivate of one hardcoded MO shape); there's no SFMC
  equivalent here. If you want synchronous, on-demand single-record sync initiated from outside
  Contentful, you'd build that directly against the REST rowset endpoint documented above.
- **A legacy Platform Event pathway.** `contentful-mo-sync`'s `paloniaPublishSync.ts` carries a
  secondary Salesforce Platform Event sink from an earlier iteration of that integration. It
  wasn't ported here — this app has exactly one sync pathway, the registry-driven one described
  above.
