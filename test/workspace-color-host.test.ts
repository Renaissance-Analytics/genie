import { describe, expect, it } from 'vitest';
import { WORKSPACE_PALETTE } from '../src/core/workspace-color.js';
import { WorkspaceColors } from '../src/main/workspace-color-host.js';

/**
 * WORKSPACE COLOURS IN MAIN (genie#1300): every workspace without a colour gets one, written into ITS project.json
 * (`appearance.color`) through Genie's writer — never a side file — so an agent reads the same colour a person sees,
 * and an agent's edit of it is what Genie shows next.
 */

const SCHEMA = (v: string) => `https://raw.githubusercontent.com/Civicognita/shared-schemas/v${v}/schemas/workspace/project.schema.json`;
const manifest = (name: string, extra: Record<string, unknown> = {}) => `${JSON.stringify({ $schema: SCHEMA('0.2.0'), name, repos: [], ...extra }, null, 2)}\n`;

function rig(files: Record<string, string>) {
    const writes: string[] = [];
    let changed = 0;
    const fs = {
        readText: async (path: string) => files[path] ?? null,
        writeTextAtomic: async (path: string, text: string) => { writes.push(path); files[path] = text; },
    };
    const colors = new WorkspaceColors({ fs, onChanged: () => { changed += 1; } });
    return { files, writes, colors, changed: () => changed };
}

const WS = [
    { id: 'a', path: '/w/a' },
    { id: 'b', path: '/w/b' },
    { id: 'c', path: '/w/c' },
];

describe('ensure — the automatic colour', () => {
    it('writes a palette colour into each project.json that has none, and touches NO other file', async () => {
        const r = rig({ '/w/a/project.json': manifest('A'), '/w/b/project.json': manifest('B', { appearance: { color: '#123456' } }), '/w/c/project.json': manifest('C') });
        await r.colors.ensure(WS);
        expect(r.writes.sort()).toEqual(['/w/a/project.json', '/w/c/project.json']);
        const a = JSON.parse(r.files['/w/a/project.json']!);
        expect(a).toMatchObject({ $schema: SCHEMA('0.3.0'), name: 'A', repos: [] });
        expect(WORKSPACE_PALETTE).toContain(a.appearance.color);
        expect(r.colors.colorOf('/w/a')).toBe(a.appearance.color);
        expect(r.colors.colorOf('/w/b')).toBe('#123456');
        expect(r.colors.colorOf('/w/c')).toBe(JSON.parse(r.files['/w/c/project.json']!).appearance.color);
        expect(r.changed()).toBeGreaterThan(0);
    });

    it('neighbours differ, and a second pass writes nothing', async () => {
        const r = rig({ '/w/a/project.json': manifest('A'), '/w/b/project.json': manifest('B'), '/w/c/project.json': manifest('C') });
        await r.colors.ensure(WS);
        expect(r.colors.colorOf('/w/a')).not.toBe(r.colors.colorOf('/w/b'));
        expect(r.colors.colorOf('/w/b')).not.toBe(r.colors.colorOf('/w/c'));
        const before = r.writes.length;
        const changed = r.changed();
        await r.colors.ensure(WS);
        expect(r.writes.length).toBe(before);
        expect(r.changed()).toBe(changed);
    });

    it('a workspace with no project.json still has a colour on screen — and nothing is written for it, anywhere', async () => {
        const r = rig({ '/w/a/project.json': manifest('A') });
        await r.colors.ensure(WS);
        expect(r.writes).toEqual(['/w/a/project.json']);
        expect(WORKSPACE_PALETTE).toContain(r.colors.colorOf('/w/b'));
        expect(r.colors.colorOf('/w/b')).not.toBe(r.colors.colorOf('/w/a'));
    });

    it('a manifest on a NEWER schema is never rewritten; its own colour is still read', async () => {
        const newer = `${JSON.stringify({ $schema: SCHEMA('9.0.0'), name: 'Future' }, null, 2)}\n`;
        const r = rig({ '/w/a/project.json': newer, '/w/b/project.json': `${JSON.stringify({ $schema: SCHEMA('9.0.0'), appearance: { color: '#0891b2' } })}\n` });
        await r.colors.ensure(WS.slice(0, 2));
        expect(r.writes).toEqual([]);
        expect(r.colors.colorOf('/w/b')).toBe('#0891b2');
        expect(WORKSPACE_PALETTE).toContain(r.colors.colorOf('/w/a'));
    });

    it('an agent that edits appearance.color is what Genie shows after the next pass', async () => {
        const r = rig({ '/w/a/project.json': manifest('A', { appearance: { color: '#123456' } }) });
        await r.colors.ensure(WS.slice(0, 1));
        r.files['/w/a/project.json'] = manifest('A', { appearance: { color: '#abcdef' } });
        const changed = r.changed();
        await r.colors.ensure(WS.slice(0, 1));
        expect(r.colors.colorOf('/w/a')).toBe('#abcdef');
        expect(r.changed()).toBe(changed + 1);
        expect(r.writes).toEqual([]);
    });
});

describe('set — the workspace\'s Settings', () => {
    it('round-trips: the chosen colour is written to project.json and is what colorOf answers', async () => {
        const r = rig({ '/w/a/project.json': manifest('A', { tynn: { projectId: 'p1' } }) });
        await r.colors.ensure(WS.slice(0, 1));
        expect(await r.colors.set('/w/a', '#7C3AED')).toEqual({ ok: true });
        const a = JSON.parse(r.files['/w/a/project.json']!);
        expect(a).toMatchObject({ name: 'A', tynn: { projectId: 'p1' }, appearance: { color: '#7c3aed' } });
        expect(r.colors.colorOf('/w/a')).toBe('#7c3aed');
    });

    it('refuses a colour that is not hex, and a workspace with no project.json — writing nothing', async () => {
        const r = rig({ '/w/a/project.json': manifest('A') });
        expect(await r.colors.set('/w/a', 'purple')).toMatchObject({ ok: false });
        expect(await r.colors.set('/w/b', '#7c3aed')).toMatchObject({ ok: false });
        expect(r.writes).toEqual([]);
    });
});
