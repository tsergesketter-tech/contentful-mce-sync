import { describe, expect, it } from 'vitest';
import { deriveDeFieldsFromContentType, mapEntryToDeactivateRows, mapEntryToDeRows, type ContentTypeLike } from './deFieldMapping';

const contentType: ContentTypeLike = {
  sys: { id: 'offer' },
  displayField: 'title',
  fields: [
    { id: 'title', name: 'Title', type: 'Symbol', localized: true },
    { id: 'code', name: 'Code', type: 'Symbol' },
    { id: 'body', name: 'Body', type: 'RichText' },
    { id: 'hero', name: 'Hero', type: 'Link' },
    { id: 'tags', name: 'Tags', type: 'Array', items: { type: 'Symbol' } },
    { id: 'gallery', name: 'Gallery', type: 'Array', items: { type: 'Link' } },
    { id: 'price', name: 'Price', type: 'Integer' },
  ],
};

const entry = (fields: Record<string, Record<string, unknown>>) => ({
  sys: { id: 'e1', space: { sys: { id: 's1' } }, publishedVersion: 3, updatedAt: '2026-10-12T00:00:00Z' },
  fields,
});

describe('deriveDeFieldsFromContentType', () => {
  it('skips Link, RichText and link-list fields and honours exclusions', () => {
    expect(deriveDeFieldsFromContentType(contentType, ['price']).map((f) => f.apiName)).toEqual(['Title', 'Code', 'Tags']);
  });
});

describe('mapEntryToDeRows', () => {
  const deFields = deriveDeFieldsFromContentType(contentType);

  it('writes one row per locale keyed by entry id', () => {
    const rows = mapEntryToDeRows(entry({ title: { 'en-US': 'Hi', 'de-DE': 'Hallo' }, code: { 'en-US': 'X1' } }), contentType, deFields, '__entryId');
    expect(rows.map((r) => r.keys.ExternalKey)).toEqual(['e1__en-US', 'e1__de-DE']);
    expect(rows[1].values).toMatchObject({ Title: 'Hallo', Code: 'X1', Locale: 'de-DE', IsActive: true, ContentVersion: '3' });
  });

  it('skips a locale with no business key instead of writing null__locale', () => {
    const rows = mapEntryToDeRows(entry({ title: { 'en-US': 'Hi', 'de-DE': 'Hallo' } }), contentType, deFields, 'code');
    expect(rows).toEqual([]);
  });

  it('writes a list of Symbols comma-joined', () => {
    const rows = mapEntryToDeRows(entry({ title: { 'en-US': 'Hi' }, tags: { 'en-US': ['a', 'b'] } }), contentType, deFields, '__entryId');
    expect(rows[0].values.Tags).toBe('a,b');
  });

  it('never stringifies an object value into a column', () => {
    const legacyFields = [{ apiName: 'Body', label: 'Body', fieldType: 'Text' as const, contentfulFieldId: 'body' }];
    const rows = mapEntryToDeRows(entry({ title: { 'en-US': 'Hi' }, body: { 'en-US': { nodeType: 'document' } } }), contentType, legacyFields, '__entryId');
    expect(rows[0].values.Body).toBeNull();
  });
});

describe('mapEntryToDeactivateRows', () => {
  it('deactivates only the locales a publish writes rows for', () => {
    const cma = { sys: { id: 'e1' }, fields: { title: { 'en-US': 'Hi', 'de-DE': 'Hallo' }, code: { 'en-US': 'X1' } } };
    expect(mapEntryToDeactivateRows(cma, contentType, 'code')).toEqual([
      { keys: { ExternalKey: 'X1__en-US' }, values: { IsActive: false } },
      { keys: { ExternalKey: 'X1__de-DE' }, values: { IsActive: false } },
    ]);
  });

  it('uses the entry id for __entryId without inventing rows for other space locales', () => {
    expect(mapEntryToDeactivateRows({ sys: { id: 'e1' }, fields: { title: { 'en-US': 'Hi' } } }, contentType, '__entryId')).toEqual([
      { keys: { ExternalKey: 'e1__en-US' }, values: { IsActive: false } },
    ]);
  });

  it('returns nothing for an entry with no field values', () => {
    expect(mapEntryToDeactivateRows({ sys: { id: 'e1' }, fields: {} }, contentType, '__entryId')).toEqual([]);
  });
});
