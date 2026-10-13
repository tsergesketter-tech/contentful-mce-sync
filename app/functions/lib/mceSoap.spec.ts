import { describe, expect, it } from 'vitest';
import { findRootFolder, parseDataFolders } from './mceSoap';

// Shape of a real RetrieveResponseMsg for ContentType=shared_dataextension (ids changed; the
// Archive folder carries a <Client> block, which some tenants return, to cover that variant).
const sharedFoldersResponse = `
<RetrieveResponseMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><OverallStatus>OK</OverallStatus>
  <Results xsi:type="DataFolder"><PartnerKey xsi:nil="true" /><ID>1963407</ID><ObjectID xsi:nil="true" /><ParentFolder><PartnerKey xsi:nil="true" /><ID>1963399</ID><ObjectID xsi:nil="true" /></ParentFolder><Name>Shared Data Extensions</Name></Results>
  <Results xsi:type="DataFolder"><PartnerKey xsi:nil="true" /><ID>2000001</ID><ObjectID xsi:nil="true" /><ParentFolder><PartnerKey xsi:nil="true" /><ID>1963407</ID><ObjectID xsi:nil="true" /></ParentFolder><Name>Contentful</Name></Results>
  <Results xsi:type="DataFolder"><Client><ID>523012158</ID></Client><ParentFolder><ID>2000001</ID><ObjectID xsi:nil="true" /></ParentFolder><ID>2000002</ID><Name>Archive</Name></Results>
</RetrieveResponseMsg>`;

describe('parseDataFolders', () => {
  it("reads each folder's own id, not its parent's or client's", () => {
    expect(parseDataFolders(sharedFoldersResponse)).toEqual([
      { id: 1963407, name: 'Shared Data Extensions', parentId: 1963399 },
      { id: 2000001, name: 'Contentful', parentId: 1963407 },
      { id: 2000002, name: 'Archive', parentId: 2000001 },
    ]);
  });
});

describe('findRootFolder', () => {
  it('finds the shared root even though its parent is a folder of another type', () => {
    expect(findRootFolder(parseDataFolders(sharedFoldersResponse))?.id).toBe(1963407);
  });
  it('finds the Data Extensions root by its parent id 0', () => {
    expect(findRootFolder([{ id: 5, name: 'Child', parentId: 9 }, { id: 9, name: 'Data Extensions', parentId: 0 }])?.id).toBe(9);
  });
});
