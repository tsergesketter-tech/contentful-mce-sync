# AGENTS.md — Marketing Cloud Engagement Data Extension Sync

A Contentful App that syncs content types into Salesforce Marketing Cloud Engagement (MCE) Data
Extensions. For a linked content type it:
- derives and creates the DE's schema (optionally as a Shared Data Extension in the parent BU),
- backfills already-published entries,
- upserts on every publish and deactivates on every unpublish,
- adds DE columns when more fields are selected later.

Routing comes entirely from two content types the app manages in the installer's space
(`dataExtensionRegistry`, `deSyncLinkage`). No content-type or DE names are hardcoded.

User-facing install and usage docs are in `../README.md`.

## Locations

| Location | File | Purpose |
|---|---|---|
| App Configuration | `src/locations/ConfigScreen.tsx` | MCE credentials and parent BU MID. On save, creates the registry content types (`ensureRegistryContentTypes`), then runs `checkMceConnection` |
| Page | `src/locations/Page.tsx` | Create net-new DEs, link/unlink content types, edit synced fields, run backfills |

## Functions

| Function | Type | Purpose |
|---|---|---|
| `createDataExtension` | App Action | Derive a DE schema from a content type; SOAP `CreateRequest`. With `MCE_PARENT_MID`, in the parent BU's Shared Data Extensions › Contentful folder |
| `backfillDeRows` | App Action | Every published entry → rowset upsert, in 500-row batches, in the BU `deMid` |
| `addDeFields` | App Action | Add columns the DE doesn't have yet (SOAP `UpdateRequest`). Never removes or retypes |
| `checkMceConnection` | App Action | Read-only: default-BU token, parent-BU token, `member_id == enterprise_id`, Shared folder root |
| `entryPublishSync` | App Event Handler | `Entry.publish` → upsert rows; `Entry.unpublish` → `IsActive=false` rows |

Shared code lives in `functions/lib/`:
- `mceAuth.ts`: installation params, client-credentials token per BU (`account_id`), `userinfo`
- `mceSoap.ts`: hand-rolled SOAP envelopes for DE create/update, DE field and DataFolder retrieve
- `deFieldMapping.ts`: schema derivation and entry→row mapping

esbuild inlines `lib/` into each Function bundle separately. In the browser, every App Action goes
through `src/lib/appActions.ts` (`callAppAction`).

## Sharp Edges & Invariants

- **Installation parameter ids** are read by `lib/mceAuth.ts` (`readMceCreds`) and written by
  `ConfigScreen.tsx` (`AppInstallationParameters`), and declared by
  `scripts/setup-app-definition.mjs`. No shared type enforces this; change all three together.
- **`MCE_CLIENT_ID`/`MCE_CLIENT_SECRET` are `Secret` installation parameters.** The browser gets
  only redacted placeholders, so `ConfigScreen` never pre-fills them and omits blank values on
  save. `MCE_PARENT_MID` is the exception: it's always submitted, so clearing it works.
- **The event subscription is not created by `upload`.** `npm run setup-app-definition` PUTs
  `/event_subscription` (`Entry.publish`, `Entry.unpublish` → `entryPublishSync`). Without it,
  only backfills write rows.
- **The real `Entry.unpublish` body has only `sys`.** `entryPublishSync` fetches the entry via
  `context.cma` for the business key. It deactivates only the locales that entry's publish
  wrote, never every space locale: the rowset API upserts, so an unknown key becomes a new row.
- **Every MCE call runs in one BU, chosen by the token.** `getMceToken(creds, mid)` sends
  `account_id`. Rows for a DE must be written with a token for the BU that owns it — the
  registry's `businessUnitMid`, passed to App Actions as `deMid`. A blank MID means the
  Installed Package's default BU.
- **A Shared Data Extension is just a DE in a `shared_dataextension` folder of the parent BU.**
  If that folder can't be resolved, `createDataExtension` fails rather than falling back: a
  plain parent-BU DE would silently be invisible to child BUs. The shared root's parent is a
  folder of another type, so `findRootFolder` looks for a parent outside the same tree, not `0`.
- **Sharing to child BUs is configured in the MCE UI.** No API for it was found; don't claim the
  app does it.
- **The token cache is keyed by credentials + BU, never a single slot.** One Function runtime
  serves many installations, and a token must never cross installations or BUs.
- **Registry fields added after v1 (`businessUnitMid`, `isShared`) may not exist yet** in a space
  whose ConfigScreen hasn't been re-saved. `Page.tsx` writes them only if the content type has
  them. `ensureRegistryContentTypes` only ever adds `ADDITIVE_FIELDS` to an existing type.
- **Registry/linkage fields are non-localized.** Read with the locale-agnostic `field()`; write
  under `sdk.locales.default`, never a hardcoded `en-US`.
- **New linkages key rows by entry id (`__entryId`).** Skip any locale with no business key
  rather than writing `null__<locale>`.
- **App Action responses:** `callAppAction` waits ~60s (contentful-management's default is ~20s).
  Pass `{ idempotent: true }` only for read-only actions (`checkMceConnection`); a retried
  `createDataExtension` would create a second DE.
- **`allowNetworks` is `*.marketingcloudapis.com`**, so the manifest works for any tenant. A
  wildcard must be a single leading `*.` label.

## Testing

```bash
npm run lint && npm run typecheck && npm run test:ci && npm run build
```

Specs sit next to the code (`functions/**/*.spec.ts`, `src/**/*.spec.tsx`). Don't write tests or
scripts that create DEs in a shared parent BU without the owner's say-so: a Shared DE is visible
across the whole enterprise.
