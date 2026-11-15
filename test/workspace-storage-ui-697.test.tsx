// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRoute } from '../src/core/route.js';
import { approvalFor, approvalMatches, formatBytes, isArtifactName, parseWorktreeList, type StorageReport, type StorageView } from '../src/core/workspace-storage.js';
import { tabStrip } from '../src/core/workspace-tabs.js';
import { StoragePanel } from '../src/renderer/components/StoragePanel.js';
import type { FeatureAction } from '../src/renderer/features.js';
import { registerAppIcons } from '../src/renderer/icons.js';

/**
 * THE WORKSPACE'S STORAGE TAB (Tynn #697): totals by category, each item with its size, Move to .trash on what may be
 * reclaimed (and the reason on what may not), Restore on what is in .trash, and Empty trash only after a confirmation that
 * names what will be deleted and how much. All buttons are Fancy Buttons with registered icons.
 */
registerAppIcons();

const report: StorageReport = {
    measuredAt: 1_763_000_000_000,
    truncated: false,
    totals: { repos: 5_000_000, worktrees: 2_000_000, 'ci-artifacts': 1500, 'chat-files': 300, trash: 3_145_728 },
    reclaimableBytes: 1_001_500,
    items: [
        { id: 'repos:repos/app', category: 'repos', label: 'repos/app', rel: 'repos/app', bytes: 5_000_000, files: 10, truncated: false, reclaimable: false, refusal: null },
        { id: 'worktrees:wt/clean', category: 'worktrees', label: 'wt/clean (wt-clean)', rel: 'wt/clean', bytes: 1_000_000, files: 3, truncated: false, reclaimable: true, refusal: null },
        { id: 'worktrees:wt/dirty', category: 'worktrees', label: 'wt/dirty (wt-dirty)', rel: 'wt/dirty', bytes: 1_000_000, files: 3, truncated: false, reclaimable: false, refusal: 'It has uncommitted changes.' },
        { id: 'ci-artifacts:repos/app/ci-out', category: 'ci-artifacts', label: 'repos/app/ci-out', rel: 'repos/app/ci-out', bytes: 1500, files: 1, truncated: false, reclaimable: true, refusal: null },
    ],
    trash: [
        { id: 'genie-1-abc', origin: { kind: 'path', category: 'ci-artifacts', rel: 'repos/app/coverage' }, movedAt: 1_762_000_000_000, bytes: 2_097_152 },
        { id: 'old-notes.txt', origin: { kind: 'unknown', name: 'old-notes.txt' }, movedAt: null, bytes: 1_048_576 },
    ],
};
const view = (over: Partial<StorageView> = {}): StorageView => ({ measuring: false, report, error: null, outcome: null, ...over });

let host: HTMLDivElement;
let root: Root;
let actions: FeatureAction[];
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    actions = [];
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });
const draw = (v: StorageView | null) => act(() => { root.render(<StoragePanel workspaceId="ws1" view={v} onAction={(a) => { actions.push(a); }} />); });
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: HTMLElement | null) => act(() => { el!.click(); });

describe('the pure pieces', () => {
    it('sizes in words a person reads', () => {
        expect([formatBytes(0), formatBytes(999), formatBytes(1500), formatBytes(3_145_728), formatBytes(5 * 1024 ** 3)]).toEqual(['0 B', '999 B', '1.5 KB', '3.0 MB', '5.0 GB']);
    });

    it('artifact names: ci-out, smoke-out, coverage, test-results, playwright-report, .nyc_output; nothing else', () => {
        for (const n of ['ci-out', 'smoke-out', 'coverage', 'test-results', 'playwright-report', '.nyc_output']) expect(isArtifactName(n), n).toBe(true);
        for (const n of ['src', 'dist', 'node_modules', 'Coverage-notes', '']) expect(isArtifactName(n), n).toBe(false);
    });

    it('git worktree list --porcelain, as git prints it (main first, a locked and a detached one)', () => {
        const out = [
            'worktree /w/repos/app', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
            'worktree /w/wt/clean', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/wt-clean', 'locked In the workspace .trash', '',
            'worktree /w/wt/detached', 'HEAD 3333333333333333333333333333333333333333', 'detached', 'prunable gitdir file points to non-existent location', '',
        ].join('\n');
        expect(parseWorktreeList(out)).toEqual([
            { path: '/w/repos/app', head: '1111111111111111111111111111111111111111', branch: 'main', bare: false, locked: false, prunable: false },
            { path: '/w/wt/clean', head: '2222222222222222222222222222222222222222', branch: 'wt-clean', bare: false, locked: true, prunable: false },
            { path: '/w/wt/detached', head: '3333333333333333333333333333333333333333', branch: null, bare: false, locked: false, prunable: true },
        ]);
    });

    it('an approval is exactly what is in the trash: same ids, same bytes', () => {
        const a = approvalFor(report.trash);
        expect(a).toEqual({ ids: ['genie-1-abc', 'old-notes.txt'], bytes: 3_145_728 });
        expect(approvalMatches(report.trash, a)).toBe(true);
        expect(approvalMatches(report.trash, { ...a, bytes: a.bytes - 1 })).toBe(false);
        expect(approvalMatches(report.trash, { ids: ['genie-1-abc'], bytes: a.bytes })).toBe(false);
        expect(approvalMatches(report.trash.slice(0, 1), a)).toBe(false);
        expect(approvalMatches(report.trash, null)).toBe(false);
    });

    it('the Storage tab: in the strip when this window can measure, as view=storage', () => {
        expect(tabStrip({ tabs: [] } as never, [], { storage: true }).map((t) => t.kind)).toEqual(['dashboard', 'files', 'storage', 'add', 'settings']);
        expect(tabStrip({ tabs: [] } as never, []).map((t) => t.kind)).not.toContain('storage');
        expect(parseRoute('genie://workspace/ws1?view=storage')).toMatchObject({ surface: 'workspace', view: 'storage' });
    });
});

describe('the Storage tab', () => {
    it('never measured: asks main to measure, once, and says it is measuring', () => {
        draw(null);
        expect(actions).toEqual([{ kind: 'storage.measure', workspaceId: 'ws1' }]);
        draw(view({ measuring: true, report: null }));
        expect(actions).toHaveLength(1);
        expect(q('[data-storage]')?.textContent).toContain('Measuring');
    });

    it('totals by category with sizes, and what may be reclaimed', () => {
        draw(view());
        expect(q('[data-storage-total="worktrees"]')?.textContent).toContain('1.9 MB');
        expect(q('[data-storage-total="trash"]')?.textContent).toContain('3.0 MB');
        expect(q('[data-storage-reclaimable]')?.textContent).toContain('978.0 KB');
    });

    it('a reclaimable item: Move to .trash (Fancy Button with its icon) sends that item only', () => {
        draw(view());
        const button = q('[data-action="storage-trash"][data-item="worktrees:wt/clean"]');
        expect(button?.querySelector('[data-react-fancy-icon]')).not.toBeNull();
        click(button);
        expect(actions.at(-1)).toEqual({ kind: 'storage.trash', workspaceId: 'ws1', itemId: 'worktrees:wt/clean' });
    });

    it('a refused item: the reason, and no button; a repo: no button', () => {
        draw(view());
        expect(q('[data-storage-item="worktrees:wt/dirty"]')?.textContent).toContain('It has uncommitted changes.');
        expect(q('[data-action="storage-trash"][data-item="worktrees:wt/dirty"]')).toBeNull();
        expect(q('[data-action="storage-trash"][data-item="repos:repos/app"]')).toBeNull();
    });

    it('.trash: each entry with where it came from and Restore (Genie’s own only)', () => {
        draw(view());
        expect(q('[data-trash-entry="genie-1-abc"]')?.textContent).toContain('repos/app/coverage');
        click(q('[data-action="storage-restore"][data-item="genie-1-abc"]'));
        expect(actions.at(-1)).toEqual({ kind: 'storage.restore', workspaceId: 'ws1', trashId: 'genie-1-abc' });
        expect(q('[data-action="storage-restore"][data-item="old-notes.txt"]')).toBeNull();
    });

    it('Empty trash asks first, naming what and how much; Cancel deletes nothing', () => {
        draw(view());
        click(q('[data-action="storage-empty-trash"]'));
        expect(actions.some((a) => a.kind === 'storage.emptyTrash')).toBe(false);
        const confirm = q('[data-storage-confirm-empty]');
        expect(confirm?.textContent).toContain('2 items');
        expect(confirm?.textContent).toContain('3.0 MB');
        expect(confirm?.textContent).toContain('repos/app/coverage');
        expect(confirm?.textContent).toContain('old-notes.txt');
        expect(confirm?.textContent).toContain('cannot be undone');
        click(q('[data-action="storage-empty-cancel"]'));
        expect(q('[data-storage-confirm-empty]')).toBeNull();
        expect(actions.some((a) => a.kind === 'storage.emptyTrash')).toBe(false);
    });

    it('confirmed: sends the approval of exactly what was shown', () => {
        draw(view());
        click(q('[data-action="storage-empty-trash"]'));
        click(q('[data-action="storage-empty-confirm"]'));
        expect(actions.at(-1)).toEqual({ kind: 'storage.emptyTrash', workspaceId: 'ws1', approval: { ids: ['genie-1-abc', 'old-notes.txt'], bytes: 3_145_728 } });
    });

    it('CONTROL: an empty trash offers no Empty trash', () => {
        draw(view({ report: { ...report, trash: [], totals: { ...report.totals, trash: 0 } } }));
        expect(q('[data-action="storage-empty-trash"]')).toBeNull();
    });

    it('what the last action did, in words; Measure again', () => {
        draw(view({ outcome: 'Moved wt/clean to .trash.' }));
        expect(q('[data-storage-outcome]')?.textContent).toBe('Moved wt/clean to .trash.');
        click(q('[data-action="storage-measure"]'));
        expect(actions.at(-1)).toEqual({ kind: 'storage.measure', workspaceId: 'ws1' });
    });
});
