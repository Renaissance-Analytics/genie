import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { followWorkspaceColors, readOnlyColorFs, WorkspaceColors, type WorkspaceColorFs } from '../src/main/workspace-color-host.js';

/**
 * THE DASHBOARD'S WORKSPACE COLOURS, SERVED BY GENIE-HOST (Tynn #956). Since Tynn #898 step 2d-4b (beta.65) this machine's
 * Dashboard is genie-host's registry's, and genie-host built a WorkspaceColors it never ran a pass on: `colorOf` answered
 * `null` for every workspace, so every Workspace swatch was blank and every comms arc took the violet fallback (the
 * Electron proof, scripts/comms-arcs-proof.mjs, measured `color: null` on all six arcs at the comms fix's head).
 *
 * The cure: both processes follow their registry with the SAME pass (`followWorkspaceColors`, rail order, so they assign
 * the same palette colours), and genie-host's reads only (`readOnlyColorFs`): main stays project.json's one writer of
 * colours, ordered before its agent-config move so the two never write one file at once.
 */
type Snap = { workspaces?: readonly { id: string; path: string; color?: string | null; governedBy?: string | null }[] | null };

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

describe('readOnlyColorFs (genie-host)', () => {
    it('shows the assigned colours and writes nothing: main is project.json’s one writer of colours', async () => {
        const reg = fakeRegistry([{ id: 'a', path: '/w/a' }, { id: 'b', path: '/w/b' }]);
        const { fs, writes } = files({ '/w/a/project.json': '{"name":"a"}', '/w/b/project.json': '{"name":"b"}' });
        const host = new WorkspaceColors({ fs: readOnlyColorFs(fs), onChanged: () => {} });
        followWorkspaceColors(reg, host);
        reg.emit();
        await settle();
        expect(writes).toEqual([]);
        expect(host.colorOf('/w/a')).toMatch(/^#[0-9a-f]{6}$/i);
        // The SAME colours main assigns (and writes) for the same workspaces in the same order.
        const { fs: mainFs } = files({ '/w/a/project.json': '{"name":"a"}', '/w/b/project.json': '{"name":"b"}' });
        const main = new WorkspaceColors({ fs: mainFs, onChanged: () => {} });
        followWorkspaceColors(reg, main);
        reg.emit();
        await settle();
        expect([host.colorOf('/w/a'), host.colorOf('/w/b')]).toEqual([main.colorOf('/w/a'), main.colorOf('/w/b')]);
    });
});

describe('the wiring', () => {
    const code = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    it('genie-host follows its registry with a read-only colour pass', () => {
        const src = code('src/main/genie-host.ts');
        expect(src).toMatch(/new WorkspaceColors\(\{ fs: readOnlyColorFs\(nodeEnvelopeFs\(\)\)/);
        expect(src).toMatch(/followWorkspaceColors\(phoneRegistry, workspaceColors\)/);
    });
    it('main follows its registry with the same pass, writing, then moves agent config', () => {
        const src = code('src/main/main.ts');
        expect(src).toMatch(/followWorkspaceColors\(theRegistry, colors, \{/);
        expect(src).toMatch(/after: \(current\) => moveAgentConfigs\(/);
    });
});
