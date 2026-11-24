// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { control } from './helpers/control-markup.js';
import * as view from '../src/core/dashboard-view.js';
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

/** The missing-folder message of a workspace's line: its opening tag, its inner markup, and its text as a person reads it. */
function messageOf(html: string, id: string): { open: string; inner: string; text: string } | null {
    const at = html.indexOf(`data-workspace-missing="${id}"`);
    if (at < 0) return null;
    const start = html.lastIndexOf('<', at);
    const openEnd = html.indexOf('>', at) + 1;
    // Its two parts are spans too: it ends at the close that follows theirs.
    let depth = 1; let i = openEnd;
    while (depth > 0) {
        const next = html.indexOf('<', i);
        if (next < 0) return null;
        if (html.startsWith('</span>', next)) depth -= 1; else if (html.startsWith('<span', next)) depth += 1;
        i = next + 1;
    }
    const inner = html.slice(openEnd, i - 1);
    const decode = (t: string): string => t.replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    return { open: html.slice(start, openEnd), inner, text: decode(inner.replace(/<[^>]+>/g, '')) };
}

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
        // It still says exactly that, as text; how it is laid out is held below (the row's layout).
        expect(messageOf(html, 'moic')?.text).toBe('folder not found: /w/moic');
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

/**
 * THE ROW'S LAYOUT (the owner's review of the first screenshot, 2026-11-24: "Add an agent" wrapped onto three lines and
 * the path into a narrow column). What can be held without a browser is held here; two screenshots show the rest.
 *  - a button never wraps its label and never shrinks;
 *  - the message takes the width that is left and cuts the PATH in the middle: its beginning truncates, its last folder
 *    always shows, and the whole text is the element's title;
 *  - in a narrow Dashboard the message drops to its own line under the name (a container query on the row, since the
 *    Dashboard's width is the chat's to take, not the window's), with the buttons at the right.
 */
describe('the row\'s layout', () => {
    const LONG = { kind: 'folder', text: 'folder not found: /mnt/projects/clients/field-notes.agi', repo: '' } as WorkspaceFault;
    const render = (faults: Record<string, WorkspaceFault | null>) =>
        renderToStaticMarkup(<Dashboard rows={[row({ workspaceId: 'tynn' })]} workspaces={[{ id: 'tynn', name: 'tynn', path: '/w/tynn' }, ...WORKSPACES]} onOpenAgent={noop} onAddAgent={noop} faults={faults} onLocateRepo={noop} onLocateFolder={noop} />);
    const classesOf = (open: string): string[] => (/class="([^"]*)"/.exec(open)?.[1] ?? '').split(/\s+/);
    const rowOf = (html: string, id: string): string => { const at = html.indexOf(`data-empty-workspace="${id}"`); return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1); };

    it('the path is cut in the middle: everything before its last folder, and the last folder', () => {
        const split = (view as unknown as { faultTextParts(text: string): { head: string; tail: string } }).faultTextParts;
        expect(split('folder not found: /mnt/projects/clients/field-notes.agi')).toEqual({ head: 'folder not found: /mnt/projects/clients', tail: '/field-notes.agi' });
        expect(split('folder not found: D:\\work\\field-notes.agi')).toEqual({ head: 'folder not found: D:\\work', tail: '\\field-notes.agi' });
        // A trailing separator is not a last folder; a text with no path is all head.
        expect(split('folder not found: /mnt/field-notes.agi/')).toEqual({ head: 'folder not found: /mnt', tail: '/field-notes.agi/' });
        expect(split('repo site not found in moic.agi')).toEqual({ head: 'repo site not found in moic.agi', tail: '' });
        // Nothing is lost: the two parts are the text.
        for (const text of ['folder not found: /w/moic', 'folder not found: C:\\a\\b\\c', 'x']) { const p = split(text); expect(p.head + p.tail).toBe(text); }
    });

    it('the message: the whole text as its title, the remaining width, its beginning truncating and its last folder always shown', () => {
        const html = render({ moic: LONG });
        const message = messageOf(html, 'moic')!;
        expect(message.open).toContain('title="folder not found: /mnt/projects/clients/field-notes.agi"');
        expect(message.text).toBe('folder not found: /mnt/projects/clients/field-notes.agi');
        expect(classesOf(message.open)).toEqual(expect.arrayContaining(['flex', 'min-w-0', 'flex-1', 'text-[var(--warning)]']));
        expect(message.inner).toMatch(/^<span class="truncate">folder not found: \/mnt\/projects\/clients<\/span><span class="shrink-0 whitespace-nowrap">\/field-notes\.agi<\/span>$/);
    });

    it('narrow: the message is on its own line, last; wide (the row\'s own width, a container query): in line, between the name and the buttons', () => {
        const html = render({ moic: LONG });
        expect(classesOf(rowOf(html, 'moic'))).toEqual(expect.arrayContaining(['@container', 'flex', 'flex-wrap', 'items-center']));
        expect(classesOf(messageOf(html, 'moic')!.open)).toEqual(expect.arrayContaining(['order-last', 'basis-full', '@2xl:order-none', '@2xl:basis-0']));
        // In the markup it sits between the name and the buttons, which is where it is drawn when there is room.
        const at = (needle: string): number => html.indexOf(needle, html.indexOf('data-empty-workspace="moic"'));
        expect(at('has no agents yet')).toBeLessThan(at('data-workspace-missing="moic"'));
        expect(at('data-workspace-missing="moic"')).toBeLessThan(at('data-workspace-actions="moic"'));
    });

    it('the buttons: together at the right, never shrinking, never wrapping their label', () => {
        const html = render({ moic: LONG });
        const at = html.indexOf('data-workspace-actions="moic"');
        const actions = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
        expect(classesOf(actions)).toEqual(expect.arrayContaining(['ml-auto', 'flex', 'shrink-0', 'items-center']));
        const inside = html.slice(at, html.indexOf('data-empty-workspace', at) < 0 ? undefined : html.indexOf('data-empty-workspace', at));
        for (const attr of ['data-add-agent="moic"', 'data-action="locate-folder"']) {
            const button = control(inside, attr)!;
            expect(button, attr).toMatchObject({ tag: 'button', fancy: true });
            expect(classesOf(button.open), attr).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
        }
        expect(control(inside, 'data-add-agent="moic"')!.text).toBe('Add an agent');
        expect(control(inside, 'data-action="locate-folder"')!.text).toBe('Locate folder');
    });

    it('CONTROL: a workspace with no fault keeps its line as it was: Add an agent beside the words, not pushed to the right, never wrapping', () => {
        const html = render({ moic: null });
        const at = html.indexOf('data-workspace-actions="moic"');
        const actions = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
        expect(at).toBeGreaterThan(0);
        expect(classesOf(actions)).not.toContain('ml-auto');
        expect(classesOf(control(html, 'data-add-agent="moic"')!.open)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
        expect(html).not.toContain('data-workspace-missing');
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
