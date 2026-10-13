# Contentful → Marketing Cloud Engagement Data Extension Sync

A Contentful App that syncs **any** content type in your space into a Salesforce Marketing Cloud
Engagement (MCE) **Data Extension**. It can:

- create the DE's schema in MCE, including as a **Shared Data Extension in the parent BU**, so the
  content can be shared to child BUs
- backfill every already-published entry
- upsert rows on every publish and deactivate them on every unpublish
- let you choose which fields sync, and add columns to the DE when you add fields later

Routing comes entirely from two content types the app manages in your space
(`dataExtensionRegistry` and `deSyncLinkage`). No content-type or Data Extension names are
hardcoded. Link as many content types to as many Data Extensions as you want.

This app is a sibling to `contentful-mo-sync`, which targets Salesforce Marketing Objects. It has
the same UI and the same registry-driven routing, but talks to MCE over SOAP (schema) and REST
(rows) instead of Metadata REST and Bulk API 2.0.

## Architecture

```
Contentful Apps UI ("Data Extension Sync" page)
   │  create / link / unlink / backfill / edit fields, via the contentful-management SDK
   ▼
dataExtensionRegistry / deSyncLinkage   (content types in your space — the routing table)
   │
   ├─ App Action  createDataExtension  derive a schema from a content type, create the DE
   │                                   (SOAP CreateRequest, synchronous)
   ├─ App Action  backfillDeRows       copy every published entry into the DE
   │                                   (Data Extension Rows (Synchronous) REST rowset)
   ├─ App Action  addDeFields          add columns for newly selected fields (SOAP UpdateRequest)
   ├─ App Action  checkMceConnection   read-only: credentials, parent BU, Shared folder
   │
   └─ App Event   entryPublishSync     Entry.publish → upsert rows; Entry.unpublish → IsActive=false
```

Every Function authenticates to MCE on its own via OAuth 2.0 client credentials against an
Installed Package, using this app's installation parameters.

**Why no polling:** both MCE operations the app needs are synchronous. SOAP `CreateRequest`
returns `OverallStatus` in the same response, and the Data Extension Rows (Synchronous) REST API
returns its result in one round trip. Very large content types (many thousands of entries) can
still hit the Function execution time limit during a backfill.

**No row delete:** the rowset API has no delete, only upsert. Unpublish sets `IsActive` to `false`
on the entry's rows instead of removing them. `Entry.delete`/`Entry.archive` aren't subscribed:
Contentful requires an unpublish first, and that already deactivated the rows.

## Business units and Shared Data Extensions

MCE tokens act in one business unit at a time. This app supports two placements for the Data
Extensions it creates:

| Parent BU MID (`MCE_PARENT_MID`) | Where new DEs go | Who can use them |
|---|---|---|
| **Set** (recommended for multi-BU accounts) | Parent BU › Shared Data Extensions › Contentful | The parent, and every child BU you share them with |
| Blank | Installed Package's default BU › Data Extensions › Contentful | That BU only |

With a parent MID set:

- The DE is created with a parent-BU token (`account_id` = the MID) inside a
  `shared_dataextension` folder. That is what makes it a Shared Data Extension; there is no
  separate flag.
- Every row (backfill, publish, unpublish) is written in the parent BU. Child BUs it's shared with
  see the same rows.
- **Sharing to child BUs is configured in Marketing Cloud, not by this app.** In the parent BU,
  open Shared Data Extensions, find the **Contentful** folder, and set its sharing (or the DE's)
  to the child BUs that should see it. MCE has no API for per-BU sharing.
- In a child BU, refer to a shared DE with the `ENT.` prefix, e.g. `ENT.TravelOffer_DE` in
  AMPscript or SQL Query Activities.
- Each registry entry records the BU it lives in (`businessUnitMid`, `isShared`), so changing the
  parent MID later only affects DEs created afterwards. Existing DEs keep syncing to the BU they're in.

## Prerequisites

- A Contentful space on a plan with App Framework access (Functions + custom Apps).
- Node.js 20 (`engines`: `>=20 <22`).
- An MCE **Installed Package** (Setup → Platform Tools → Apps → Installed Packages) with an
  **API Integration** component of type **Server-to-Server**, granted:
  - **Data Extensions**: Read and Write. Needed for schema creation and updates (SOAP) and row
    upserts (REST).
- For Shared Data Extensions, the package must have **access to the parent (Enterprise) BU**.
  Create the package in the parent BU, and under the API Integration's **Account access** include
  the parent BU (and any child BUs you want to test against).
- Your tenant's three base URLs, shown on the API Integration component:
  - `https://<subdomain>.auth.marketingcloudapis.com/`
  - `https://<subdomain>.rest.marketingcloudapis.com/`
  - `https://<subdomain>.soap.marketingcloudapis.com/`
- The parent BU's **MID**, if you want Shared Data Extensions. It's shown in Setup → Business Units
  (top of the hierarchy) or under your account name in the MCE header when you're in the parent BU.

## Install

From `app/`:

1. **Create, build and upload the app:**
   ```bash
   npm install
   npx contentful-app-scripts create-app-definition   # first time only — creates the App Definition
   npm run build
   npm run upload
   npm run upsert-actions
   ```
   `contentful-app-manifest.json` allows `*.marketingcloudapis.com`, so it works for any tenant
   without edits.

2. **Declare the installation parameters and subscribe to publish events.** This is required:
   without it, publishing never syncs, and the client ID and secret aren't stored as secrets.
   ```bash
   CONTENTFUL_ACCESS_TOKEN=... CONTENTFUL_ORG_ID=... CONTENTFUL_APP_DEF_ID=... npm run setup-app-definition
   ```
   The script is idempotent; re-run it after changing `INSTALLATION_PARAMETERS` or the subscribed topics.

3. **Install the app** on your space (Apps → your app → Install), then fill in the Configure screen:
   - the three base URLs, Installed Package client ID and client secret
   - **Parent BU MID**, to create Shared Data Extensions (see above)

   Saving creates the `dataExtensionRegistry` and `deSyncLinkage` content types if they don't
   exist yet, then runs **Check connection**. That check verifies the credentials, that the MID
   really is the parent BU, and that its Shared Data Extensions folder is reachable. It changes nothing.
   (`migrations/02-de-sync-registry.js` creates the same content types from the CLI, if you'd
   rather provision them that way.)

4. **Link a content type to a Data Extension** from the app's page:
   - **Brand-new DE:** **Create Net-New Data Extension**, pick a content type, choose the fields
     to sync, optionally add extra text columns, then **Create & Link**. This creates the DE, registers
     it, links the content type, and backfills every published entry in one step.
   - **Existing DE:** create and publish a `dataExtensionRegistry` entry by hand (at minimum
     `deLabel`, `deExternalKey`, `pkFieldApiName`, and `businessUnitMid` if the DE isn't in the
     package's default BU). Then select the content type and that entry and click **Link Selected**.
     This also backfills.
   - **Edit Fields** changes which fields sync. Newly checked fields get a column in the DE first;
     unchecked fields keep their column and stop being written. It then re-backfills.
   - **Backfill Now** and **Unlink Selected** are available any time for a linked content type.

From then on, publishing or unpublishing any entry of a linked content type syncs automatically.

## Row shape

Every DE the app creates has a primary key `ExternalKey` = `<business key>__<locale>`, one row per
locale. The business key is the entry id (`__entryId`) for every linkage the app creates. It also
writes these bookkeeping columns:

`ContentfulEntryId`, `ContentfulSpaceId`, `ContentTypeId`, `Locale`, `ContentVersion`,
`PublishedAt`, `IsActive`, `SourceSystem`.

Field types map as: Symbol → Text(255); Text, Number and a list of Symbols (comma-joined) →
Text(4000); Integer → Number; Date → Date; Boolean → Boolean. Link (single or list), Rich Text,
JSON Object and Location fields aren't synced yet: there's no generic mapping rule for them.

## Configuration reference

### App installation parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `MCE_AUTH_BASE_URL` | Symbol | Yes | `https://<subdomain>.auth.marketingcloudapis.com/` |
| `MCE_REST_BASE_URL` | Symbol | Yes | `https://<subdomain>.rest.marketingcloudapis.com/` |
| `MCE_SOAP_BASE_URL` | Symbol | Yes | `https://<subdomain>.soap.marketingcloudapis.com/` |
| `MCE_CLIENT_ID` | Secret | Yes | Installed Package client ID |
| `MCE_CLIENT_SECRET` | Secret | Yes | Installed Package client secret |
| `MCE_PARENT_MID` | Symbol | No | Parent (Enterprise) BU MID. Set = new DEs are Shared Data Extensions there |

### `dataExtensionRegistry` fields

| Field | Description |
|---|---|
| `deLabel` | Display label. |
| `deExternalKey` | The DE's `CustomerKey`. Unique. |
| `pkFieldApiName` | The DE column used as the rowset upsert key. Defaults to `ExternalKey`. |
| `fieldMap` | `{ fields: [{ apiName, label, fieldType, length?, contentfulFieldId? }] }` |
| `excludedFieldIds` | Contentful field ids that aren't synced. |
| `deployStatus` | `not_deployed` / `deployed` / `failed`. |
| `lastDeployError` | Last creation error, if any. |
| `businessUnitMid` | MID of the BU that owns the DE. Blank = the Installed Package's default BU. |
| `isShared` | `true` for a Shared Data Extension in the parent BU. |

### `deSyncLinkage` fields

| Field | Description |
|---|---|
| `contentTypeId` | The content type this row routes. Unique. |
| `pkContentfulFieldId` | Field that supplies the business-key half of `ExternalKey`, or `__entryId` for the entry id. |
| `dataExtension` | Link to the `dataExtensionRegistry` entry. |
| `isActive` | **Unlink Selected** sets this to `false` rather than deleting the entry. |

## Development

From `app/`:

```bash
npm run dev         # local UI at http://localhost:3000 (point the App Definition's URL here)
npm run typecheck
npm run lint
npm run test:ci
npm run build       # typecheck + UI bundle + Function bundles
```

For local scripts, copy `.env.example` to `.env` (gitignored) — never commit real credentials.

## License

MIT — see `app/LICENSE`.
