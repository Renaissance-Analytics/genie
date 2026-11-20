import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { followWorkspaceColors, WorkspaceColors, type WorkspaceColorFs } from '../src/main/workspace-color-host.js';

/**
 * THE DASHBOARD'S WORKSPACE COLOURS, SERVED BY GENIE-HOST (Tynn #956). Since Tynn #898 step 2d-4b (beta.65) this machine's
 * Dashboard is genie-host's registry's, and genie-host built a WorkspaceColors it never ran a pass on: `colorOf` answered
 * `null` for every workspace, so every Workspace swatch was blank and every comms arc took the violet fallback (the
 * Electron proof, scripts/comms-arcs-proof.mjs, measured `color: null` on all six arcs at the comms fix's head).
 *
 * The cure: both processes follow their registry with the SAME pass (`followWorkspaceColors`, rail order, so they assign
 * the same palette colours), and genie-host's pass does not write the colours it assigns (`writesAssigned: false`): main
 * writes those, before its agent-config move, so two processes never write one project.json at once. A person's choice
 * (`set`, workspaces.setColor, which genie-host answers with no window open) is still written by genie-host.
 */
type Snap = { workspaces?: readonly { id: string; path: string; color?: string | null; governedBy?: string | null }[] | null | undefined };

function fakeRegistry(workspaces: Snap['workspaces']) {
    const listeners = new Set<(s: Snap) => void>();
    return {
        snapshot: (): Snap => ({ workspaces }),
        subscribe: (l: (s: Snap) => void) => { listeners.add(l); return () => listeners.delete(l); },
        emit: () => { for (const l of listeners) l({ workspaces }); },
    };
}
const files = (texts: Record<string, string>) => {
    const writes: string[] = [];
    const fs: WorkspaceColorFs = {
        readText: async (path) => texts[path] ?? null,
        writeTextAtomic: async (path, text) => { writes.push(path); texts[path] = text; },
    };
    return { fs, writes };
};
const settle = () => new Promise((r) => setTimeout(r, 10));

describe('followWorkspaceColors', () => {
    it('gives every workspace a palette colour on the registry’s next snapshot, different neighbours, and re-emits', async () => {
        const reg = fakeRegistry([{ id: 'a', path: '/w/a' }, { id: 'b', path: '/w/b' }, { id: 'c', path: '/w/c' }]);
        const { fs } = files({ '/w/a/project.json': '{"name":"a"}', '/w/b/project.json': '{"name":"b"}', '/w/c/project.json': '{"name":"c"}' });
        const changed = vi.fn();
        const colors = new WorkspaceColors({ fs, onChanged: changed });
        followWorkspaceColors(reg, colors);
        expect(colors.colorOf('/w/a')).toBeNull();
        reg.emit();
        await settle();
        const shown = ['/w/a', '/w/b', '/w/c'].map((p) => colors.colorOf(p));
        for (const c of shown) expect(c).toMatch(/^#[0-9a-f]{6}$/i);
        expect(new Set(shown).size).toBe(3);
        expect(changed).toHaveBeenCalled();
    });

    it('keeps a colour project.json already has', async () => {
        const reg = fakeRegistry([{ id: 'a', path: '/w/a' }]);
        const { fs } = files({ '/w/a/project.json': JSON.stringify({ name: 'a', appearance: { color: '#123456' } }) });
        const colors = new WorkspaceColors({ fs, onChanged: () => {} });
        followWorkspaceColors(reg, colors);
        reg.emit();
        await settle();
        expect(colors.colorOf('/w/a')).toBe('#123456');
    });

    it('runs `after` once each pass is over (main moves agent config after its colour pass)', async () => {
        const reg = fakeRegistry([{ id: 'a', path: '/w/a' }]);
        const { fs } = files({ '/w/a/project.json': '{"name":"a"}' });
        const after = vi.fn();
        followWorkspaceColors(reg, new WorkspaceColors({ fs, onChanged: () => {} }), { after });
        reg.emit();
        await settle();
        expect(after).toHaveBeenCalledTimes(1);
        expect(after.mock.calls[0]![0]).toEqual([{ id: 'a', path: '/w/a' }]);
    });
});

describe('writesAssigned: false (genie-host)', () => {
    it('shows the assigned colours and writes none of them; main, with the same pass, writes the same colours (CONTROL)', async () => {
        const reg = fakeRegistry([{ id: 'a', path: '/w/a' }, { id: 'b', path: '/w/b' }]);
        const { fs, writes } = files({ '/w/a/project.json': '{"name":"a"}', '/w/b/project.json': '{"name":"b"}' });
        const host = new WorkspaceColors({ fs, writesAssigned: false, onChanged: () => {} });
        followWorkspaceColors(reg, host);
        reg.emit();
        await settle();
        expect(writes).toEqual([]);
        expect(host.colorOf('/w/a')).toMatch(/^#[0-9a-f]{6}$/i);
        const { fs: mainFs, writes: mainWrites } = files({ '/w/a/project.json': '{"name":"a"}', '/w/b/project.json': '{"name":"b"}' });
        const main = new WorkspaceColors({ fs: mainFs, onChanged: () => {} });
        followWorkspaceColors(reg, main);
        reg.emit();
        await settle();
        // Each project.json, and before it the backup MIGRATIONS.md asks for when an unstamped legacy file is first stamped.
        expect(mainWrites.filter((p) => p.endsWith('/project.json'))).toEqual(['/w/a/project.json', '/w/b/project.json']);
        expect(mainWrites).toHaveLength(4);
        expect([host.colorOf('/w/a'), host.colorOf('/w/b')]).toEqual([main.colorOf('/w/a'), main.colorOf('/w/b')]);
    });

    it('still writes a person’s choice (`set`: workspaces.setColor, answered by genie-host with no window open)', async () => {
        const { fs, writes } = files({ '/w/a/project.json': '{"name":"a"}' });
        const host = new WorkspaceColors({ fs, writesAssigned: false, onChanged: () => {} });
        expect(await host.set('/w/a', '#abcdef')).toEqual({ ok: true });
        expect(writes).toContain('/w/a/project.json');
        expect(host.colorOf('/w/a')).toBe('#abcdef');
    });
});

describe('the wiring', () => {
    const code = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    it('genie-host follows its registry with a colour pass that writes no assigned colour', () => {
        const src = code('src/main/genie-host.ts');
        expect(src).toMatch(/const workspaceColors = new WorkspaceColors\(\{ fs: nodeEnvelopeFs\(\), writesAssigned: false,/);
        expect(src).toMatch(/colors: workspaceColors,/);
        expect(src).toMatch(/followWorkspaceColors\(phoneRegistry, workspaceColors\)/);
    });
    it('main follows its registry with the same pass, writing, then moves agent config', () => {
        const src = code('src/main/main.ts');
        expect(src).toMatch(/followWorkspaceColors\(theRegistry, colors, \{/);
        expect(src).toMatch(/after: \(current\) => moveAgentConfigs\(/);
    });
});
