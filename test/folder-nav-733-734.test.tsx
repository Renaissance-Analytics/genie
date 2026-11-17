// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { TreeNode } from '../src/core/files-panel.js';
import type { HostListing } from '../src/main/host-fs.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';
import { HostPathPickerForm } from '../src/renderer/components/HostPathPicker.js';

/**
 * FOLDERS OPEN THE WAY A PERSON EXPECTS (client onboarding call, 2026-11-16; Tynn #733, #734).
 *
 * #733, the folder picker: Choose was disabled until a CHILD was clicked, so the folder being shown (the user folder the
 * picker opened in) could not be chosen; and New folder left the person in the parent, where they had to scroll to the
 * new folder and double-click into it. Now Choose with nothing selected picks the folder shown (never the Windows drive
 * list, which is not a folder), and New folder goes into the folder it made, so Choose picks it at once.
 *
 * #734, the Files panel: a click on a folder toggles it, so a double-click toggled it open and shut again and looked
 * like nothing. And a tree without the lazy host's expansion props was handed `expandedIds=[]` with no way to change
 * it, so no folder opened at all. Now a double-click leaves the folder open, and the panel keeps its own expansion when
 * nobody controls it. Interaction is a claim about a live DOM, so this renders in happy-dom.
 */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.innerHTML = ''; });
const mount = () => { const node = document.createElement('div'); document.body.append(node); root = createRoot(node); return node; };
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

// ── #733 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const windowsDisk = (made: string[] = []) => async (path: string): Promise<HostListing> => {
    if (path === '/') return { ok: true, path: '/', entries: [{ path: 'C:/', name: 'C:', kind: 'dir' }] };
    const kids = [...['Documents', 'site'].map((n) => `${path}/${n}`), ...made.filter((m) => m.slice(0, m.lastIndexOf('/')) === path)];
    return { ok: true, path, entries: kids.map((p) => ({ path: p, name: p.split('/').pop()!, kind: 'dir' as const })) };
};
const posixDisk = async (path: string): Promise<HostListing> => (path === '/'
    ? { ok: true, path: '/', entries: [{ path: '/home', name: 'home', kind: 'dir' }, { path: '/srv', name: 'srv', kind: 'dir' }] }
    : { ok: true, path, entries: [] });
const choose = (node: HTMLElement) => node.querySelector<HTMLButtonElement>('[data-action="pick-path"]')!;

async function picker(props: Partial<Parameters<typeof HostPathPickerForm>[0]>) {
    const picks: (string | string[])[] = [];
    const node = mount();
    act(() => root!.render(<HostPathPickerForm mode="directory" listDir={windowsDisk()} onPick={(p) => picks.push(p)} onCancel={() => {}} {...props} />));
    await settle();
    return { node, picks };
}

describe('#733 the folder picker chooses the folder you are in', () => {
    it('with nothing selected, Choose picks the folder being shown, and says which', async () => {
        const { node, picks } = await picker({ initialPath: 'C:/Users/me' });
        expect(choose(node).disabled).toBe(false);
        expect(node.querySelector('[data-picked]')!.textContent).toBe('C:/Users/me');
        act(() => choose(node).click());
        expect(picks).toEqual(['C:/Users/me']);
    });

    it('CONTROL: a selected folder is still what Choose picks', async () => {
        const { node, picks } = await picker({ initialPath: 'C:/Users/me', initialSelection: 'C:/Users/me/site' });
        act(() => choose(node).click());
        expect(picks).toEqual(['C:/Users/me/site']);
    });

    it('CONTROL: the Windows drive list is not a folder, so at `/` there Choose stays off', async () => {
        const { node, picks } = await picker({ initialPath: '/' });
        expect(choose(node).disabled).toBe(true);
        act(() => choose(node).click());
        expect(picks).toEqual([]);
    });

    it('a POSIX `/` is a folder, and can be chosen', async () => {
        const { node, picks } = await picker({ initialPath: '/', listDir: posixDisk });
        expect(choose(node).disabled).toBe(false);
        act(() => choose(node).click());
        expect(picks).toEqual(['/']);
    });

    it('CONTROL: picking a file with nothing selected, Choose stays off (the folder shown is not a file)', async () => {
        const { node } = await picker({ mode: 'file', initialPath: 'C:/Users/me' });
        expect(choose(node).disabled).toBe(true);
    });

    it('New folder goes into the folder it made: the picker shows it, and Choose picks it', async () => {
        const made: string[] = [];
        const listDir = windowsDisk(made);
        const mkdir = async (parent: string, name: string) => { made.push(`${parent}/${name}`); return { ok: true as const, path: `${parent}/${name}` }; };
        const { node, picks } = await picker({ initialPath: 'C:/Users/me', listDir, mkdir });
        act(() => node.querySelector<HTMLButtonElement>('[data-react-fancy-file-browser-new-folder]')!.click());
        const input = node.querySelector<HTMLInputElement>('[data-react-fancy-file-browser-new-folder-input]')!;
        act(() => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'client-app');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { node.querySelector<HTMLButtonElement>('[data-react-fancy-file-browser-new-folder-submit]')!.click(); });
        await settle();
        expect(made).toEqual(['C:/Users/me/client-app']);
        expect(node.querySelector('[data-picker-path]')!.getAttribute('data-picker-path')).toBe('C:/Users/me/client-app');
        act(() => choose(node).click());
        expect(picks).toEqual(['C:/Users/me/client-app']);
    });
});

// ── #734 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const tree = [{ id: 'repos', label: 'repos', type: 'folder', children: [{ id: 'repos/app', label: 'app', type: 'folder', children: [{ id: 'repos/app/a.ts', label: 'a.ts', type: 'file', ext: 'ts' }] }] }] as unknown as TreeNode[];
const base: FilesPanelProps = {
    workspace: { id: 'w', name: 'Project', path: '/w' }, tree, state: null, tabs: [], open: null, pinned: false,
    onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
};
/** The lazy host's container: it owns the expansion (FilesPanelContainer with `children`). */
function Controlled({ start }: { start: readonly string[] }) {
    const [expanded, setExpanded] = useState<readonly string[]>(start);
    return <FilesPanel {...base} expanded={expanded} onExpandedChange={setExpanded} />;
}
const row = (node: HTMLElement, label: string) => [...node.querySelectorAll<HTMLButtonElement>('[data-react-fancy-tree-node] > button')].find((b) => b.textContent?.trim() === label) ?? null;
const shown = (node: HTMLElement, label: string) => row(node, label) !== null;
/** What a mouse sends for a double-click: click (detail 1), click (detail 2), dblclick. */
function doubleClick(el: HTMLElement) {
    act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })); });
    act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 })); });
    act(() => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); });
}

describe('#734 the Files panel opens a double-clicked folder', () => {
    it('CONTROL: a single click on a closed folder opens it (lazy host)', () => {
        const node = mount();
        act(() => root!.render(<Controlled start={[]} />));
        expect(shown(node, 'repos')).toBe(true);
        expect(shown(node, 'app')).toBe(false);
        act(() => row(node, 'repos')!.click());
        expect(shown(node, 'app')).toBe(true);
    });

    it('CONTROL: a single click on an open folder still closes it (lazy host)', () => {
        const node = mount();
        act(() => root!.render(<Controlled start={['repos']} />));
        expect(shown(node, 'app')).toBe(true);
        act(() => row(node, 'repos')!.click());
        expect(shown(node, 'app')).toBe(false);
    });

    it('a double-click on a closed folder leaves it open (lazy host)', () => {
        const node = mount();
        act(() => root!.render(<Controlled start={[]} />));
        doubleClick(row(node, 'repos')!);
        expect(shown(node, 'app')).toBe(true);
    });

    it('CONTROL: a double-click on an open folder leaves it open (lazy host)', () => {
        const node = mount();
        act(() => root!.render(<Controlled start={['repos']} />));
        doubleClick(row(node, 'repos')!);
        expect(shown(node, 'app')).toBe(true);
    });

    it('a tree nobody controls (a host without lazy children): a click opens a folder', () => {
        const node = mount();
        act(() => root!.render(<FilesPanel {...base} />));
        act(() => row(node, 'repos')!.click());
        expect(shown(node, 'app')).toBe(true);
    });

    it('a tree nobody controls: a double-click opens a folder', () => {
        const node = mount();
        act(() => root!.render(<FilesPanel {...base} />));
        doubleClick(row(node, 'repos')!);
        expect(shown(node, 'app')).toBe(true);
    });
});
