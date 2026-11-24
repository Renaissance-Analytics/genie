// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { control } from './helpers/control-markup.js';
import { groupByWorkspace, workspaceFault, type AgentRow, type WorkspaceFault } from '../src/core/dashboard-view.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';

/**
 * "LOCATE FOLDER" ON THE DASHBOARD (host split P7, build spec item 3; ruling R1, 2026-11-23). A workspace whose own
 * folder is not there keeps its row; the row says `folder not found: <path>` and offers one action, "Locate folder",
 * in both places the Dashboard shows a workspace-level fault: an agent row's Workspace cell, and the line of a
 * workspace with no agents. The folder fault wins over a missing repo: a folder that is gone has no repos to read.
 *
 * Fixtures name no person.
 */

type Fault = (repos: readonly { slug: string; missing?: boolean }[] | null, name: string, folder?: { path: string; missing?: boolean }) => WorkspaceFault | null;
const fault = workspaceFault as Fault;
const FOLDER = { kind: 'folder', text: 'folder not found: /w/moic', repo: '' } as WorkspaceFault;
const REPO = { text: 'repo site not found in moic.agi', repo: 'site' } as WorkspaceFault;

describe('workspaceFault: the folder kind', () => {
    it('a workspace whose folder is not there: `folder not found: <path>`, of the folder kind', () => {
        expect(fault(null, 'moic', { path: '/w/moic', missing: true })).toEqual({ kind: 'folder', text: 'folder not found: /w/moic', repo: '' });
    });

    it('wins over a missing repo; without the flag the repo fault is the one, exactly as before (the control)', () => {
        const repos = [{ slug: 'moic' }, { slug: 'site', missing: true }];
        expect(fault(repos, 'moic', { path: '/w/moic', missing: true })).toMatchObject({ kind: 'folder', text: 'folder not found: /w/moic' });
        expect(fault(repos, 'moic', { path: '/w/moic' })).toEqual({ text: 'repo site not found in moic.agi', repo: 'site' });
        expect(fault(repos, 'moic')).toEqual({ text: 'repo site not found in moic.agi', repo: 'site' });
    });

    it('a folder that is there, with every repo there or the repos not read, is no fault', () => {
        expect(fault([{ slug: 'moic' }], 'moic', { path: '/w/moic' })).toBeNull();
        expect(fault(null, 'moic', { path: '/w/moic' })).toBeNull();
        expect(fault(null, 'moic', { path: '/w/moic', missing: false })).toBeNull();
    });

    it('rides the group, which is still listed with its agents', () => {
        const [group] = groupByWorkspace([row()], ['moic'], {}, { moic: FOLDER });
        expect(group?.workspaceId).toBe('moic');
        expect(group?.rows.map((r) => r.id)).toEqual(['a1']);
        expect(group?.fault).toEqual(FOLDER);
    });
});

const row = (over: Partial<AgentRow> = {}): AgentRow =>
    ({ id: 'a1', name: 'atlas', provider: 'claude', workspaceId: 'moic', fidelity: 'declared', state: 'working', duration: null, ask: null, reason: null, fixes: [], target: null, delivery: null, collaborators: null, commsLevel: null, context: null, ...over }) as AgentRow;
const WORKSPACES = [{ id: 'moic', name: 'moic', path: '/w/moic' }];
const noop = () => {};

describe('the Workspace cell of an agent row', () => {
    const render = (faults: Record<string, WorkspaceFault | null>) =>
        renderToStaticMarkup(<Dashboard rows={[row()]} workspaces={WORKSPACES} onOpenAgent={noop} onAddAgent={noop} faults={faults} onLocateRepo={noop} onLocateFolder={noop} />);

    it('offers a real Locate folder button, named, with the fault in its tooltip; the row is still drawn', () => {
        const html = render({ moic: FOLDER });
        const button = control(html, 'data-action="locate-folder"');
        expect(button).toMatchObject({ tag: 'button', fancy: true });
        expect(button!.open).toContain('aria-label="Locate folder"');
        expect(button!.open).toContain('data-workspace-missing="moic"');
        expect(button!.open).toMatch(/title="Locate folder[^"]*folder not found: \/w\/moic[^"]*"/);
        // Never hidden: the agent's row and its Workspace cell are in the board.
        expect(html).toContain('data-column="workspace"');
        expect(html).toContain('data-workspace="moic"');
        expect(html).toContain('atlas');
        // One action: the repo door is not offered beside it.
        expect(html).not.toContain('data-action="locate-repo"');
    });

    it('no such button without the folder fault: none at all, and a repo fault keeps its own door (the controls)', () => {
        const none = render({ moic: null });
        expect(none).not.toContain('data-action="locate-folder"');
        expect(none).not.toContain('data-workspace-missing');
        expect(none).toContain('data-workspace="moic"');
        const repo = render({ moic: REPO });
        expect(repo).not.toContain('data-action="locate-folder"');
        expect(control(repo, 'data-action="locate-repo"')).toMatchObject({ tag: 'button', fancy: true });
    });
});

describe('the line of a workspace with no agents', () => {
    const render = (faults: Record<string, WorkspaceFault | null>) =>
        renderToStaticMarkup(<Dashboard rows={[row({ workspaceId: 'tynn' })]} workspaces={[{ id: 'tynn', name: 'tynn', path: '/w/tynn' }, ...WORKSPACES]} onOpenAgent={noop} onAddAgent={noop} faults={faults} onLocateRepo={noop} onLocateFolder={noop} />);

    it('says the folder is not found and offers Locate folder; the workspace is still listed', () => {
        const html = render({ moic: FOLDER });
        expect(html).toContain('data-empty-workspace="moic"');
        expect(html).toMatch(/<span[^>]*data-workspace-missing="moic"[^>]*>folder not found: \/w\/moic<\/span>/);
        const button = control(html, 'data-action="locate-folder"');
        expect(button).toMatchObject({ tag: 'button', fancy: true, text: 'Locate folder' });
        expect(html).not.toContain('data-action="locate-repo"');
    });

    it('no such button without the folder fault (the controls)', () => {
        const none = render({ moic: null });
        expect(none).toContain('data-empty-workspace="moic"');
        expect(none).not.toContain('data-action="locate-folder"');
        const repo = render({ moic: REPO });
        expect(repo).not.toContain('data-action="locate-folder"');
        expect(control(repo, 'data-action="locate-repo"')).toMatchObject({ tag: 'button', text: 'Locate repo' });
    });
});

describe('clicking Locate folder', () => {
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

    function mount(node: ReactNode) {
        g.IS_REACT_ACT_ENVIRONMENT = true;
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        act(() => { root.render(node); });
        return { host, done: () => { act(() => root.unmount()); host.remove(); } };
    }

    it('on an agent row: the handler gets the workspace id, once, and the row is not opened by the same click', () => {
        const onLocateFolder = vi.fn();
        const onLocateRepo = vi.fn();
        const onOpenAgent = vi.fn();
        const m = mount(<Dashboard rows={[row()]} workspaces={WORKSPACES} onOpenAgent={onOpenAgent} onAddAgent={noop} faults={{ moic: FOLDER }} onLocateRepo={onLocateRepo} onLocateFolder={onLocateFolder} />);
        try {
            const button = m.host.querySelector<HTMLButtonElement>('[data-action="locate-folder"]');
            expect(button).not.toBeNull();
            act(() => { button!.click(); });
            expect(onLocateFolder).toHaveBeenCalledExactlyOnceWith('moic');
            expect(onLocateRepo).not.toHaveBeenCalled();
            expect(onOpenAgent).not.toHaveBeenCalled();
        } finally { m.done(); }
    });

    it('on a workspace with no agents: the handler gets the workspace id, once', () => {
        const onLocateFolder = vi.fn();
        const onLocateRepo = vi.fn();
        const m = mount(<Dashboard rows={[]} workspaces={WORKSPACES} onOpenAgent={noop} onAddAgent={noop} faults={{ moic: FOLDER }} onLocateRepo={onLocateRepo} onLocateFolder={onLocateFolder} />);
        try {
            const line = m.host.querySelector('[data-empty-workspace="moic"]');
            expect(line).not.toBeNull();
            const button = line!.querySelector<HTMLButtonElement>('[data-action="locate-folder"]');
            expect(button).not.toBeNull();
            act(() => { button!.click(); });
            expect(onLocateFolder).toHaveBeenCalledExactlyOnceWith('moic');
            expect(onLocateRepo).not.toHaveBeenCalled();
        } finally { m.done(); }
    });

    it('a repo fault\'s button still calls the repo handler, never the folder one (the control)', () => {
        const onLocateFolder = vi.fn();
        const onLocateRepo = vi.fn();
        const m = mount(<Dashboard rows={[row()]} workspaces={WORKSPACES} onOpenAgent={noop} onAddAgent={noop} faults={{ moic: REPO }} onLocateRepo={onLocateRepo} onLocateFolder={onLocateFolder} />);
        try {
            expect(m.host.querySelector('[data-action="locate-folder"]')).toBeNull();
            act(() => { m.host.querySelector<HTMLButtonElement>('[data-action="locate-repo"]')!.click(); });
            expect(onLocateRepo).toHaveBeenCalledExactlyOnceWith('moic', 'site');
            expect(onLocateFolder).not.toHaveBeenCalled();
        } finally { m.done(); }
    });
});

describe('the window wires it (read from the source: App is not mounted in a unit test)', () => {
    const source = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8').replace(/\r\n/g, '\n');

    it('App builds the folder fault from the snapshot row\'s flag, without reading the repos of a folder that is gone', () => {
        const app = source('src/renderer/App.tsx');
        expect(app).toMatch(/if \(w\.missing === true\) return \[w\.id, workspaceFault\(null, name, w\)\] as const;\n\s+const r = await resolvedBridge\.workspaces\.listRepos\(w\.id\);/);
        // The faults are read again when a folder goes, comes back or is located elsewhere.
        expect(app).toMatch(/const faultKey = [^\n]*w\.path[^\n]*w\.missing === true/);
    });

    it('App\'s handler opens the window\'s folder picker, calls the bridge, and shows a refusal\'s reason', () => {
        const app = source('src/renderer/App.tsx');
        const handler = app.slice(app.indexOf('const locateFolder = '), app.indexOf('const [wsSettings, setWsSettings]'));
        expect(handler).toContain('const locateFolder = (workspaceId: string) =>');
        expect(handler).toMatch(/pickFolder\(/);
        expect(handler).toMatch(/workspaces\.relocate\?\.\(workspaceId, path\)/);
        expect(handler).toMatch(/showAlert\(\{ title: 'Could not locate folder', body: reason \}\)/);
        expect(handler).toMatch(/else failed\(r\.reason\)/);
        expect(app).toContain('onLocateFolder={locateFolder}');
    });

    it('the Shell passes it to the Dashboard', () => {
        expect(source('src/renderer/Shell.tsx')).toContain('onLocateFolder={onLocateFolder}');
    });
});
