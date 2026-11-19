import { describe, expect, it } from 'vitest';
import { syncWorkspaceFiles, type WorkspaceFilesSyncPorts } from '../src/main/host-workspace-files.js';

/**
 * THE WORKSPACE AGENT FILES ARE GENIE-HOST'S TO KEEP (Tynn #898 step 2e-2, story #914). The window used to run this loop
 * and reach genie-host's writers through the engine server's engine.features route, so with no window open nothing was
 * written. genie-host runs it now, the same rules (main.ts until this step): every workspace once, each workspace added
 * after, the protocol of every workspace again on a Tynn sign-in or out, and the config of each Tynn-linked one on a
 * sign-in. Names are fixtures.
 */

function rig(start: { id: string; path: string; project?: string }[], signedIn = false) {
    let workspaces = [...start];
    let tynn = signedIn;
    const calls: string[] = [];
    const lines: string[] = [];
    const registryListeners = new Set<() => void>();
    const tynnListeners = new Set<() => void>();
    const fail = new Set<string>();
    const ports: WorkspaceFilesSyncPorts = {
        workspaces: () => workspaces,
        onWorkspacesChanged: (listener) => { registryListeners.add(listener); return () => { registryListeners.delete(listener); }; },
        tynnSignedIn: () => tynn,
        onTynnChanged: (listener) => { tynnListeners.add(listener); return () => { tynnListeners.delete(listener); }; },
        tynnProject: (id) => workspaces.find((w) => w.id === id)?.project ?? null,
        syncAgentDocs: async (path) => { calls.push(`docs ${path}`); if (fail.has(`docs ${path}`)) throw new Error('disk full'); },
        syncConfig: async (path) => {
            calls.push(`config ${path}`);
            if (fail.has(`config ${path}`)) throw new Error('no endpoint');
            return [{ ok: true, label: 'Claude' }, ...(path === '/w/flaky' ? [{ ok: false, label: 'Cursor', error: 'locked' }] : [])];
        },
        log: (line) => { lines.push(line); },
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return {
        ports, calls, lines, fail, settle,
        add: (w: { id: string; path: string; project?: string }) => { workspaces = [...workspaces, w]; for (const l of [...registryListeners]) l(); },
        touch: () => { for (const l of [...registryListeners]) l(); },
        tynn: (on: boolean) => { tynn = on; for (const l of [...tynnListeners]) l(); },
        listening: () => registryListeners.size + tynnListeners.size,
    };
}

describe('genie-host keeps every workspace\'s agent files (step 2e-2)', () => {
    it('every workspace is synced once at the start, and a registry change with nothing new syncs nothing', async () => {
        const r = rig([{ id: 'tynn', path: '/w/tynn' }, { id: 'genie', path: '/w/genie' }]);
        syncWorkspaceFiles(r.ports);
        await r.settle();
        expect(r.calls.sort()).toEqual(['config /w/genie', 'config /w/tynn', 'docs /w/genie', 'docs /w/tynn']);
        r.calls.length = 0;
        r.touch();
        await r.settle();
        expect(r.calls).toEqual([]);
    });

    it('a workspace added later is synced once, the moment the registry says so', async () => {
        const r = rig([{ id: 'tynn', path: '/w/tynn' }]);
        syncWorkspaceFiles(r.ports);
        await r.settle();
        r.calls.length = 0;
        r.add({ id: 'new', path: '/w/new' });
        r.touch();
        await r.settle();
        expect(r.calls.sort()).toEqual(['config /w/new', 'docs /w/new']);
    });

    it('a Tynn sign-out writes every workspace\'s protocol again and no config', async () => {
        const r = rig([{ id: 'tynn', path: '/w/tynn', project: 'p1' }, { id: 'genie', path: '/w/genie' }], true);
        syncWorkspaceFiles(r.ports);
        await r.settle();
        r.calls.length = 0;
        r.tynn(false);
        await r.settle();
        expect(r.calls.sort()).toEqual(['docs /w/genie', 'docs /w/tynn']);
    });

    it('a Tynn sign-in writes every protocol again, and the config of each Tynn-linked workspace only', async () => {
        const r = rig([{ id: 'tynn', path: '/w/tynn', project: 'p1' }, { id: 'genie', path: '/w/genie' }]);
        syncWorkspaceFiles(r.ports);
        await r.settle();
        r.calls.length = 0;
        r.tynn(true);
        await r.settle();
        expect(r.calls.sort()).toEqual(['config /w/tynn', 'docs /w/genie', 'docs /w/tynn']);
    });

    it('a failed write is said, by workspace, and the others are written; nothing is thrown', async () => {
        const r = rig([{ id: 'tynn', path: '/w/tynn' }, { id: 'flaky', path: '/w/flaky' }, { id: 'genie', path: '/w/genie' }]);
        r.fail.add('docs /w/tynn');
        r.fail.add('config /w/genie');
        syncWorkspaceFiles(r.ports);
        await r.settle();
        expect(r.calls.filter((c) => c.startsWith('docs')).length).toBe(3);
        expect(r.lines.sort()).toEqual([
            '[workspace-files] flaky Cursor: locked',
            '[workspace-files] genie: no endpoint',
            '[workspace-files] tynn protocol: disk full',
        ]);
    });

    it('stopped, it listens to nothing and writes nothing more', async () => {
        const r = rig([{ id: 'tynn', path: '/w/tynn', project: 'p1' }]);
        const stop = syncWorkspaceFiles(r.ports);
        await r.settle();
        expect(r.listening()).toBe(2);
        stop();
        expect(r.listening()).toBe(0);
        r.calls.length = 0;
        r.add({ id: 'new', path: '/w/new' });
        r.tynn(true);
        await r.settle();
        expect(r.calls).toEqual([]);
    });
});
