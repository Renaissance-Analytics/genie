import { describe, expect, it } from 'vitest';
import { registerExisting } from '../src/main/envelope-wizard-host.js';
import { addWorkspace, previewAddWorkspace, type WorkspaceOpsPorts } from '../src/main/workspace-ops-host.js';

/**
 * ONE FOLDER IS ONE WORKSPACE (genie#485). Genie 1: a folder added unlinked (a ULID row), then the same project imported
 * from Tynn (a project-id row), made two rows for one folder and left the first row's agents behind it.
 *
 * Genie 2's Tynn import never adds an existing folder — it refuses one (workspace-ops-tynn.test.ts) — but its other doors
 * name the SAME folder by two different ids: "Add a folder" uses the folder's name (`tynn.agi`), while Tynn's import, New
 * and the envelope wizard use it without `.agi` (`tynn`). Each door checked only its own id, so a folder already a
 * workspace under the other one was added again: a second row beside the first, with none of its agents. Here every
 * door refuses a folder Genie already has, whatever id it is under — saying which workspace to open — and writes nothing.
 */

const SCHEMA = 'https://raw.githubusercontent.com/Civicognita/shared-schemas/v0.3.0/schemas/workspace/project.schema.json';

function fakes(registered: Array<{ id: string; path: string }>, folders: Record<string, string[]>) {
    const rows = [...registered];
    const writes: string[] = [];
    const ports = {
        fs: {
            exists: async (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '') in folders,
            entries: async (p: string) => folders[p.replace(/\\/g, '/').replace(/\/+$/, '')] ?? [],
            readJson: async () => ({ $schema: SCHEMA, name: 'tynn', repos: [] }),
            writeJson: async (p: string) => { writes.push(`writeJson:${p}`); },
            mkdir: async (p: string) => { writes.push(`mkdir:${p}`); },
            writeText: async (p: string) => { writes.push(`writeText:${p}`); },
            gitInit: async (p: string) => { writes.push(`gitInit:${p}`); },
        },
        registry: {
            workspace: (id: string) => { const w = rows.find((r) => r.id === id); return w ? { ...w, asleep: false } : null; },
            list: () => rows,
            addWorkspace: async (r: { id: string; path: string }) => { writes.push(`register:${r.id}`); rows.push({ id: r.id, path: r.path }); },
            agentsOf: () => [],
            setAsleep: async () => true,
            forgetWorkspace: async () => null,
        },
    } as unknown as WorkspaceOpsPorts;
    return { ports, rows, writes };
}

const ENVELOPE = ['project.json', 'repos', '.ai'];

describe('a folder Genie already has, under the OTHER id', () => {
    it('Add a folder: `tynn.agi` is already the workspace `tynn` (from Tynn) — refused, naming it; nothing written', async () => {
        const f = fakes([{ id: 'tynn', path: '/w/tynn.agi' }], { '/w/tynn.agi': ENVELOPE });
        const preview = await previewAddWorkspace(f.ports, '/w/tynn.agi');
        expect(preview).toMatchObject({ ok: false, reason: expect.stringContaining('already the workspace tynn') });
        expect(await addWorkspace(f.ports, '/w/tynn.agi')).toMatchObject({ ok: false });
        expect(f.rows).toHaveLength(1);
        expect(f.writes).toEqual([]);
    });

    it('the envelope wizard’s existing envelope: the folder is already the workspace `tynn.agi` (added as a folder) — refused', async () => {
        const f = fakes([{ id: 'tynn.agi', path: '/w/tynn.agi' }], { '/w/tynn.agi': ENVELOPE });
        expect(await registerExisting(f.ports, '/w/tynn.agi')).toMatchObject({ ok: false, reason: expect.stringContaining('already the workspace tynn.agi') });
        expect(f.rows).toHaveLength(1);
        expect(f.writes).toEqual([]);
    });

    it('the same folder written differently — a trailing slash, backslashes, a Windows drive letter in another case', async () => {
        const f = fakes([{ id: 'shop', path: 'C:\\Work\\shop.agi' }], { 'c:/work/shop.agi': ENVELOPE, 'C:/Work/shop.agi': ENVELOPE });
        expect(await previewAddWorkspace(f.ports, 'c:/work/shop.agi/')).toMatchObject({ ok: false, reason: expect.stringContaining('already the workspace shop') });
    });
});

describe('CONTROLS: a different folder is still added', () => {
    it('a sibling folder whose name only STARTS like a workspace’s is not the same folder', async () => {
        const f = fakes([{ id: 'tynn', path: '/w/tynn.agi' }], { '/w/tynn.agi2': ENVELOPE });
        expect(await previewAddWorkspace(f.ports, '/w/tynn.agi2')).toMatchObject({ ok: true });
    });

    it('on Linux, folders differing only in case are different folders', async () => {
        const f = fakes([{ id: 'shop', path: '/w/Shop.agi' }], { '/w/shop.agi': ENVELOPE });
        expect(await previewAddWorkspace(f.ports, '/w/shop.agi')).toMatchObject({ ok: true });
    });

    it('the same id is still refused as before, in its own words', async () => {
        const f = fakes([{ id: 'tynn.agi', path: '/elsewhere/tynn.agi' }], { '/w/tynn.agi': ENVELOPE });
        expect(await previewAddWorkspace(f.ports, '/w/tynn.agi')).toMatchObject({ ok: false, reason: expect.stringContaining('There is already a workspace named tynn.agi') });
    });
});
