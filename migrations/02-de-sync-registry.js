/**
 * Sync registry model: which Data Extensions Contentful knows about, and which content types are
 * linked to which DE. Backs the `app/src/locations/Page.tsx` admin page and is read at runtime by
 * `app/functions/paloniaEngagementSync.ts` to route publishes — no hardcoded constants.
 *
 * Run with the Contentful CLI:
 *   npx contentful space migration --space-id $CF_SPACE_ID --environment-id master \
 *       migrations/02-de-sync-registry.js
 */
module.exports = function (migration) {
  const registry = migration
    .createContentType('dataExtensionRegistry')
    .name('Data Extension Registry')
    .description('One entry per known Marketing Cloud Engagement Data Extension, existing or net-new.')
    .displayField('deLabel');

  registry
    .createField('deLabel')
    .name('Label')
    .type('Symbol')
    .required(true)
    .localized(false);

  registry
    .createField('deExternalKey')
    .name('DE external key (CustomerKey)')
    .type('Symbol')
    .required(true)
    .localized(false)
    .validations([{ unique: true }]);

  registry
    .createField('pkFieldApiName')
    .name('Row PK field API name')
    .type('Symbol')
    .required(true)
    .localized(false)
    .defaultValue({ 'en-US': 'ExternalKey' });

  registry
    .createField('fieldMap')
    .name('Field map')
    .type('Object')
    .localized(false);

  registry
    .createField('excludedFieldIds')
    .name('Excluded Contentful field ids')
    .type('Array')
    .items({ type: 'Symbol' })
    .localized(false);

  registry
    .createField('deployStatus')
    .name('Deploy status')
    .type('Symbol')
    .required(true)
    .localized(false)
    .validations([{ in: ['not_deployed', 'deployed', 'failed'] }])
    .defaultValue({ 'en-US': 'not_deployed' });

  registry.createField('lastDeployError').name('Last deploy error').type('Text').localized(false);

  registry.changeFieldControl('deExternalKey', 'builtin', 'singleLine', {
    helpText: 'Exact Data Extension CustomerKey/external key in Marketing Cloud Engagement.',
  });
  registry.changeFieldControl('fieldMap', 'builtin', 'objectEditor');
  registry.changeFieldControl('lastDeployError', 'builtin', 'multipleLine');

  const linkage = migration
    .createContentType('deSyncLinkage')
    .name('DE Sync Linkage')
    .description('Routes one Contentful content type to one Data Extension registry entry.')
    .displayField('contentTypeId');

  linkage
    .createField('contentTypeId')
    .name('Content type id')
    .type('Symbol')
    .required(true)
    .localized(false)
    .validations([{ unique: true }]);

  linkage
    .createField('pkContentfulFieldId')
    .name('PK Contentful field id')
    .type('Symbol')
    .required(true)
    .localized(false);

  linkage
    .createField('dataExtension')
    .name('Data extension')
    .type('Link')
    .linkType('Entry')
    .required(true)
    .localized(false)
    .validations([{ linkContentType: ['dataExtensionRegistry'] }]);

  linkage
    .createField('isActive')
    .name('Active')
    .type('Boolean')
    .required(true)
    .localized(false)
    .defaultValue({ 'en-US': true });

  linkage.changeFieldControl('contentTypeId', 'builtin', 'singleLine', {
    helpText: 'Exact content type API id, e.g. travelOffer.',
  });
  linkage.changeFieldControl('pkContentfulFieldId', 'builtin', 'singleLine', {
    helpText: 'Which field supplies the business key half of the DE row external key, e.g. offerKey.',
  });
};
