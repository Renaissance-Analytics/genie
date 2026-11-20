// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { itemKind, type StorageItem, type StorageReport, type StorageView } from '../src/core/workspace-storage.js';
import { StoragePanel } from '../src/renderer/components/StoragePanel.js';
import { registerAppIcons } from '../src/renderer/icons.js';

/**
 * THE CLEAN UP LIST SAYS WHAT EACH THING IS (Tynn #946). The owner: "I am afraid to try and empty the trash … why would
 * repos be in this list?" A row read `repos/genie2-vm · 11.5 MB`, twice, and nothing said it was a worktree. Pinned: each
 * row names its kind (a worktree of which repository, on which branch or commit, clean or not; coverage; test results; CI
 * output; a test queue result); the confirmation groups what it will move by kind, with each group's size; each category
 * says its size; and an item is drawn once however often it is sent.
 */
registerAppIcons();
const OLD = 1_700_000_000_000;
const NOW = Date.now();

const wt = (over: Partial<StorageItem>): StorageItem => ({ id: 'worktrees:repos/app-vm', category: 'worktrees', label: 'repos/app-vm', rel: 'repos/app-vm', bytes: 12_000_000, files: 3, truncated: false, reclaimable: true, refusal: null, state: 'merged', newest: OLD, repo: 'repos/app', branch: null, head: 'abcdef1234567890abcdef1234567890abcdef12', ...over });
const art = (rel: string, bytes: number): StorageItem => ({ id: `ci-artifacts:${rel}`, category: 'ci-artifacts', label: rel, rel, bytes, files: 1, truncated: false, reclaimable: true, refusal: null, newest: OLD });

const items: StorageItem[] = [
    { id: 'repos:repos/app', category: 'repos', label: 'repos/app', rel: 'repos/app', bytes: 5_000_000, files: 10, truncated: false, reclaimable: false, refusal: null },
    wt({}),
    // The same worktree sent twice (as beta.65 did): drawn once.
    wt({}),
    wt({ id: 'worktrees:wt/term', label: 'wt/term', rel: 'wt/term', branch: 'wt-term', reclaimable: false, refusal: 'In use: a terminal (pwsh) is working in it.' }),
    art('repos/app/coverage', 1000),
    art('repos/app/test-results', 2000),
    art('repos/app/ci-out', 3000),
    art('.ai/sandbox/azure/queue/1114-130339-aaaaaa', 4000),
];
const report: StorageReport = { measuredAt: NOW, truncated: false, totals: { repos: 5_000_000, worktrees: 12_000_000, 'ci-artifacts': 10_000, 'chat-files': 0, dirty: 0, trash: 0 }, reclaimableBytes: 12_010_000, items, trash: [] };
const view: StorageView = { measuring: false, report, error: null, outcome: null };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root.render(<StoragePanel workspaceId="ws1" view={view} onAction={() => {}} />); });
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const all = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;

describe('what each item is', () => {
    it('kinds in words', () => {
        expect(itemKind(wt({}))).toBe('Worktree of repos/app, detached at abcdef1');
        expect(itemKind(wt({ branch: 'wt-term' }))).toBe('Worktree of repos/app, on wt-term');
        expect(itemKind(art('repos/app/coverage', 1))).toBe('Coverage');
        expect(itemKind(art('repos/app/test-results', 1))).toBe('Test results');
        expect(itemKind(art('repos/app/playwright-report', 1))).toBe('Test results');
        expect(itemKind(art('repos/app/ci-out', 1))).toBe('CI output');
        expect(itemKind(art('.ai/sandbox/azure/queue/1114-130339-aaaaaa', 1))).toBe('Test queue result');
        expect(itemKind(items[0]!)).toBe('Repository');
    });

    it('each row shows its kind; a worktree row its repository, branch or commit, and state', () => {
        const vm = q('[data-storage-item="worktrees:repos/app-vm"]')!;
        expect(vm.querySelector('[data-storage-kind]')!.textContent).toBe('Worktree of repos/app, detached at abcdef1');
        expect(vm.textContent).toMatch(/Clean, merged/);
        expect(q('[data-storage-item="ci-artifacts:repos/app/coverage"] [data-storage-kind]')!.textContent).toBe('Coverage');
    });

    it('an item sent twice is drawn once', () => {
        expect(all('[data-storage-item="worktrees:repos/app-vm"]')).toHaveLength(1);
    });

    it('a worktree in use shows why and offers no Move', () => {
        const term = q('[data-storage-item="worktrees:wt/term"]')!;
        expect(term.textContent).toMatch(/In use: a terminal \(pwsh\) is working in it\./);
        expect(term.querySelector('[data-action="storage-trash"]')).toBeNull();
    });

    it('each category says its size and how many', () => {
        expect(q('[data-storage-category="worktrees"] h3')!.textContent).toMatch(/2 · 22\.9 MB/);
        expect(q('[data-storage-category="ci-artifacts"] h3')!.textContent).toMatch(/4 · 9\.8 KB/);
    });
});

describe('the Clean up confirmation groups by kind, with sizes', () => {
    it('one group per kind with its count and size; each thing once', () => {
        act(() => { q('[data-action="storage-cleanup"]')!.click(); });
        const groups = all('[data-cleanup-group]').map((g) => g.getAttribute('data-cleanup-group'));
        expect(groups).toEqual(['Worktrees', 'Coverage', 'Test results', 'CI output', 'Test queue results']);
        expect(q('[data-cleanup-group="Worktrees"] h4')!.textContent).toMatch(/Worktrees · 1 · 11\.4 MB/);
        expect(all('[data-cleanup-group="Worktrees"] li')).toHaveLength(1);
        expect(q('[data-cleanup-group="Worktrees"] li')!.textContent).toMatch(/repos\/app-vm.*Worktree of repos\/app, detached at abcdef1/);
    });
});
