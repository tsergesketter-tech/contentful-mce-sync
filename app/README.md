# App scaffold reference

This app was originally bootstrapped with [Create Contentful App](https://github.com/contentful/create-contentful-app).
For what this app actually does and how to install it, see the [package README](../README.md) —
this file only documents the generic scaffold's npm scripts.

## Available Scripts

#### `npm start`

Creates or updates your app definition in Contentful and runs the app in development mode.

#### `npm run build`

Builds the React UI (`vite build`) and the Functions (`contentful-app-scripts build-functions`)
into the `build` folder.

#### `npm run upload`

Uploads the `build` folder to Contentful and activates it as a bundle. Interactive — prompts for
the org/app-definition/token it needs. See
[Deploy with Contentful](https://www.contentful.com/developers/docs/extensibility/app-framework/create-contentful-app/#deploy-with-contentful).

#### `npm run upload-ci`

Same as `upload`, non-interactive — reads `CONTENTFUL_ORG_ID`, `CONTENTFUL_APP_DEF_ID`, and
`CONTENTFUL_ACCESS_TOKEN` from the environment.

## Libraries used

- [Forma 36](https://f36.contentful.com/) — Contentful's design system, used throughout `src/locations/`.
- [`contentful-management`](https://www.contentful.com/developers/docs/extensibility/app-framework/sdk/#using-the-contentful-management-library) — the CMA client passed into each location, used by `Page.tsx` to read/write the registry content types.
