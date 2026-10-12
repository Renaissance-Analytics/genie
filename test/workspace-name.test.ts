import { describe, expect, it } from 'vitest';
import { folderName, workspaceDisplayName } from '../src/core/workspace-name.js';

/**
 * THE RAIL SHOWS NAMES, NOT IDS. 2.0.0-beta.7 listed the owner's 26 workspaces as ULIDs: a record has an id
 * and a path, and nothing resolved a name. The envelope's `project.json` `name` is the name; a folder with
 * no readable manifest or no name is called by its folder.
 */
describe('workspaceDisplayName', () => {
    it("takes the envelope's name", () => {
        expect(workspaceDisplayName('{ "name": "Tynn.ai", "repos": [] }', 'C:\\_Projects\\tynn.ai')).toBe('Tynn.ai');
        expect(workspaceDisplayName('{"name":"  Fancy  "}', 'C:\\_Projects\\_packages\\fancy.agi')).toBe('Fancy');
    });

    it('falls back to the folder when there is no manifest, no name, an empty name, or broken JSON', () => {
        expect(workspaceDisplayName(null, 'C:\\_Projects\\_packages\\fancy.agi')).toBe('fancy.agi');
        expect(workspaceDisplayName('{"repos":[]}', '/home/u/work/weaver.agi/')).toBe('weaver.agi');
        expect(workspaceDisplayName('{"name":"   "}', 'C:\\w\\guardcard')).toBe('guardcard');
        expect(workspaceDisplayName('{not json', 'C:\\w\\broken')).toBe('broken');
        expect(workspaceDisplayName('"a string"', 'C:\\w\\string')).toBe('string');
    });

    it('CONTROL: never the id — nothing here returns anything that was not a name or a folder', () => {
        expect(workspaceDisplayName(null, 'C:\\w\\01k95ewyzkvkbxtpdt8b3qvyqk')).toBe('01k95ewyzkvkbxtpdt8b3qvyqk'); // the FOLDER happens to be named so; that is the folder
        expect(workspaceDisplayName('{"name":"Tynn.ai"}', 'C:\\w\\01k95ewyzkvkbxtpdt8b3qvyqk')).toBe('Tynn.ai');
    });

    it('folderName handles both separators and a trailing one', () => {
        expect(folderName('C:\\_Projects\\tynn.ai')).toBe('tynn.ai');
        expect(folderName('C:\\_Projects\\tynn.ai\\')).toBe('tynn.ai');
        expect(folderName('/srv/x/y/')).toBe('y');
        expect(folderName('solo')).toBe('solo');
    });
});
