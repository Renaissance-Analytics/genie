import { describe, expect, it } from 'vitest';
import {
    newPanelAttachment,
    newPanelLabel,
    openFileInEditor,
    pickReusePanel,
    resolveCursorLine,
    seedMetaForReuse,
    surfaceMaximized,
    type OpenFileDeps,
} from '../editor-open';
import type { TerminalSpec, ViewMeta, WorkspaceRow } from '../genie';

/** Minimal spec/row factories — only the fields pickReusePanel reads. */
function spec(p: Partial<TerminalSpec> & { id: string }): TerminalSpec {
    return {
        type: 'code',
        workspace_id: null,
        cwd: '',
        label: p.id,
        ...p,
    } as TerminalSpec;
}
function wsMap(entries: Array<[string, string]>): Map<string, WorkspaceRow> {
    const m = new Map<string, WorkspaceRow>();
    for (const [id, path] of entries) m.set(id, { id, path } as WorkspaceRow);
    return m;
}

describe('pickReusePanel', () => {
    const wsById = wsMap([['ws1', '/ws1']]);

    it('reuses an open code panel for a real workspace (root = workspace path)', () => {
        const specs = [spec({ id: 'c1', type: 'code', workspace_id: 'ws1', cwd: '/ws1' })];
        expect(
            pickReusePanel(
                specs,
                { workspaceId: 'ws1', root: '/ws1' },
                null,
                new Set(['c1']),
                wsById,
            ),
        ).toEqual({ id: 'c1', mounted: true });
    });

    it('reuses a HIDDEN (unselected) panel instead of opening yet another one', () => {
        // The accumulation bug: `selected` is this window's MOUNTED set, which
        // after launch only covers the workspace the app came up in. An agent
        // opening a file in any other workspace therefore saw "nothing to
        // reuse" and created `<ws>-files-2`, `-3`, … one per app session, even
        // though the workspace's editor panel was in its saved visible set.
        const specs = [spec({ id: 'c1', type: 'code', workspace_id: 'ws1', cwd: '/ws1' })];
        expect(
            pickReusePanel(specs, { workspaceId: 'ws1', root: '/ws1' }, null, new Set(), wsById),
        ).toEqual({ id: 'c1', mounted: false });
    });

    it('prefers a MOUNTED panel over a hidden one (signal the live panel)', () => {
        const specs = [
            spec({ id: 'hidden', type: 'code', workspace_id: 'ws1', cwd: '/ws1' }),
            spec({ id: 'live', type: 'code', workspace_id: 'ws1', cwd: '/ws1' }),
        ];
        expect(
            pickReusePanel(
                specs,
                { workspaceId: 'ws1', root: '/ws1' },
                null,
                new Set(['live']),
                wsById,
            ),
        ).toEqual({ id: 'live', mounted: true });
    });

    it('opens NEW (null) when the workspace has NO code panel at all', () => {
        expect(
            pickReusePanel([], { workspaceId: 'ws1', root: '/ws1' }, null, new Set(), wsById),
        ).toBeNull();
    });

    it('reuses a System panel matched by its cwd root', () => {
        const specs = [
            spec({ id: 's1', type: 'code', workspace_id: null, cwd: 'C:/Windows/System32', meta: { system: true } }),
        ];
        expect(
            pickReusePanel(
                specs,
                { workspaceId: '__system__', root: 'C:/Windows/System32' },
                null,
                new Set(['s1']),
                wsById,
            ),
        ).toEqual({ id: 's1', mounted: true });
    });

    it('does NOT reuse a System panel rooted at a different directory (opens new)', () => {
        const specs = [
            spec({ id: 's1', type: 'code', workspace_id: null, cwd: 'C:/a', meta: { system: true } }),
        ];
        expect(
            pickReusePanel(specs, { workspaceId: '__system__', root: 'C:/b' }, null, new Set(['s1']), wsById),
        ).toBeNull();
    });

    it('does NOT reuse a HIDDEN panel rooted elsewhere either', () => {
        // The hidden fallback must not relax the root rule: a panel rooted
        // somewhere else resolves its relative tabs against the WRONG tree.
        const specs = [
            spec({ id: 's1', type: 'code', workspace_id: null, cwd: 'C:/a', meta: { system: true } }),
            spec({ id: 'c1', type: 'code', workspace_id: 'ws1', cwd: '/ws1' }),
        ];
        expect(
            pickReusePanel(specs, { workspaceId: '__system__', root: 'C:/b' }, null, new Set(), wsById),
        ).toBeNull();
    });

    it('prefers the focused panel among multiple matches', () => {
        const specs = [
            spec({ id: 'c1', type: 'code', workspace_id: 'ws1', cwd: '/ws1' }),
            spec({ id: 'c2', type: 'code', workspace_id: 'ws1', cwd: '/ws1' }),
        ];
        expect(
            pickReusePanel(
                specs,
                { workspaceId: 'ws1', root: '/ws1' },
                'c2',
                new Set(['c1', 'c2']),
                wsById,
            ),
        ).toEqual({ id: 'c2', mounted: true });
    });

    it('ignores a focused panel that is HIDDEN when a mounted one matches', () => {
        // focusId can name a panel that is no longer visible; mounted wins so
        // the file lands in a panel the user can actually see.
        const specs = [
            spec({ id: 'c1', type: 'code', workspace_id: 'ws1', cwd: '/ws1' }),
            spec({ id: 'c2', type: 'code', workspace_id: 'ws1', cwd: '/ws1' }),
        ];
        expect(
            pickReusePanel(
                specs,
                { workspaceId: 'ws1', root: '/ws1' },
                'c1',
                new Set(['c2']),
                wsById,
            ),
        ).toEqual({ id: 'c2', mounted: true });
    });

    it('ignores non-code specs (a terminal never reuses)', () => {
        const specs = [spec({ id: 't1', type: 'terminal', workspace_id: 'ws1', cwd: '/ws1' })];
        expect(
            pickReusePanel(specs, { workspaceId: 'ws1', root: '/ws1' }, null, new Set(['t1']), wsById),
        ).toBeNull();
    });

    it('never reuses a code panel belonging to ANOTHER workspace', () => {
        const specs = [spec({ id: 'c1', type: 'code', workspace_id: 'ws2', cwd: '/ws2' })];
        expect(
            pickReusePanel(specs, { workspaceId: 'ws1', root: '/ws1' }, null, new Set(), wsById),
        ).toBeNull();
    });

    it('reuses the workspace panel for a file in a SUBDIRECTORY', () => {
        // A subdirectory file still roots at the workspace, so the workspace's
        // open editor is the one to reuse — the panel just gains a tab.
        const specs = [spec({ id: 'c1', type: 'code', workspace_id: 'ws1', cwd: '/ws1' })];
        expect(
            pickReusePanel(
                specs,
                { workspaceId: 'ws1', root: '/ws1' },
                null,
                new Set(['c1']),
                wsById,
            )?.id,
        ).toBe('c1');
    });
});

describe('seedMetaForReuse (reopening a HIDDEN panel on a file)', () => {
    it('appends the file as a tab and makes it active', () => {
        const meta: ViewMeta = { open_files: ['a.md'], active_file: 'a.md', file_path: 'a.md' };
        expect(seedMetaForReuse(meta, 'b.md')).toEqual({
            open_files: ['a.md', 'b.md'],
            active_file: 'b.md',
            file_path: 'b.md',
        });
    });

    it('does not duplicate a tab that is already open — it just activates it', () => {
        const meta: ViewMeta = { open_files: ['a.md', 'b.md'], active_file: 'a.md' };
        expect(seedMetaForReuse(meta, 'b.md').open_files).toEqual(['a.md', 'b.md']);
        expect(seedMetaForReuse(meta, 'b.md').active_file).toBe('b.md');
    });

    it('carries the reveal line so the remounted panel scrolls to it', () => {
        expect(seedMetaForReuse({}, 'b.md', 42).reveal_line).toBe(42);
    });

    it('CLEARS a stale reveal line when the request has no line', () => {
        // reveal_line is transient and file-agnostic: left behind, the mount
        // seed would jump the NEW file to the previous file's line.
        expect(seedMetaForReuse({ reveal_line: 42 }, 'b.md').reveal_line).toBeUndefined();
    });

    it('keeps the panel’s other settings (lock, tree, wrap) untouched', () => {
        const meta: ViewMeta = {
            locked: true,
            root: 'docs',
            tree_pinned: true,
            word_wrap: true,
            expanded_tree_ids: ['docs'],
        };
        expect(seedMetaForReuse(meta, 'docs/b.md')).toMatchObject({
            locked: true,
            root: 'docs',
            tree_pinned: true,
            word_wrap: true,
            expanded_tree_ids: ['docs'],
        });
    });

    it('seeds a panel that has no tabs yet (and a legacy file_path-only panel)', () => {
        expect(seedMetaForReuse(undefined, 'b.md').open_files).toEqual(['b.md']);
        expect(seedMetaForReuse({ file_path: 'a.md' }, 'b.md').open_files).toEqual(['a.md', 'b.md']);
    });
});

describe('surfaceMaximized', () => {
    it('maximizes the opened panel instead of leaving it behind another', () => {
        // A file "surfaced" behind someone else's maximized panel is invisible.
        expect(surfaceMaximized('other', 'c1')).toBe('c1');
    });

    it('leaves the normal grid alone (nothing maximized → nothing to fix)', () => {
        expect(surfaceMaximized(null, 'c1')).toBeNull();
    });

    it('is a no-op when the opened panel is already the maximized one', () => {
        expect(surfaceMaximized('c1', 'c1')).toBe('c1');
    });
});

describe('newPanelAttachment', () => {
    it('attaches to the workspace when the panel roots at the workspace path', () => {
        expect(newPanelAttachment({ workspaceId: 'ws1', root: '/ws1' }, '/ws1')).toEqual({
            workspaceId: 'ws1',
            system: false,
        });
    });

    it('never attaches a panel rooted somewhere OTHER than the workspace path', () => {
        // The field bug: an attached panel resolves its tabs against the
        // WORKSPACE root (CodePanel: `workspace?.path ?? spec.cwd`), so a panel
        // rooted at `/elsewhere/notes` with a `todo.md` tab read `/ws1/todo.md`.
        expect(newPanelAttachment({ workspaceId: 'ws1', root: '/elsewhere/notes' }, '/ws1')).toEqual(
            { workspaceId: null, system: true },
        );
    });

    it('opens a System target as an unattached System panel', () => {
        expect(newPanelAttachment({ workspaceId: '__system__', root: '/var/log' }, null)).toEqual({
            workspaceId: null,
            system: true,
        });
    });

    it('falls back to a System panel when the workspace row is unknown', () => {
        expect(newPanelAttachment({ workspaceId: 'ws9', root: '/ws9' }, undefined)).toEqual({
            workspaceId: null,
            system: true,
        });
    });
});

describe('resolveCursorLine (openFileForUser line → CodeEditor cursorLine)', () => {
    it('reveals the line on the file it targets', () => {
        expect(resolveCursorLine({ file: 'a.ts', line: 42 }, 'a.ts')).toBe(42);
    });

    it('does NOT reveal on a different active tab (no cross-file jump)', () => {
        expect(resolveCursorLine({ file: 'a.ts', line: 42 }, 'b.ts')).toBeUndefined();
    });

    it('is undefined with no pending reveal', () => {
        expect(resolveCursorLine(null, 'a.ts')).toBeUndefined();
    });

    it('is undefined when no tab is active', () => {
        expect(resolveCursorLine({ file: 'a.ts', line: 42 }, null)).toBeUndefined();
    });

    it('carries a 1-based line through verbatim (incl. line 1)', () => {
        expect(resolveCursorLine({ file: 'a.ts', line: 1 }, 'a.ts')).toBe(1);
    });
});

describe('openFileInEditor (the open-file handler, end to end over fakes)', () => {
    const wsById = new Map<string, WorkspaceRow>([
        ['ws1', { id: 'ws1', path: '/ws1', project_name: 'The Ripple Effect' } as WorkspaceRow],
    ]);

    /** Records every effect the handler has on the Floor, in order. */
    function harness(
        specs: TerminalSpec[],
        selected: string[] = [],
        opts: { updateFails?: boolean; createThrows?: boolean } = {},
    ) {
        const calls: string[] = [];
        const state = { specs: [...specs], created: null as null | Record<string, unknown> };
        const deps: OpenFileDeps = {
            specs: () => state.specs,
            focusId: () => null,
            selected: () => new Set(selected),
            workspacesById: () => wsById,
            updateMeta: async (id, meta) => {
                calls.push(`updateMeta:${id}`);
                if (opts.updateFails) return null;
                return { ...state.specs.find((s) => s.id === id)!, meta };
            },
            createPanel: async (input) => {
                calls.push(`createPanel:${input.label}`);
                if (opts.createThrows) throw new Error('db down');
                state.created = input as unknown as Record<string, unknown>;
                return { id: 'new1', ...input } as TerminalSpec;
            },
            putSpec: (s) => {
                calls.push(`putSpec:${s.id}`);
                state.specs = [...state.specs.filter((x) => x.id !== s.id), s];
            },
            activateWorkspace: (id) => calls.push(`activateWorkspace:${id}`),
            surface: (id) => calls.push(`surface:${id}`),
            revealSystem: () => calls.push('revealSystem'),
            emitOpenInPanel: (id, rel, line) => calls.push(`emit:${id}:${rel}:${line ?? '-'}`),
        };
        return { deps, calls, state };
    }

    const codeSpec = (id: string) =>
        spec({ id, type: 'code', workspace_id: 'ws1', cwd: '/ws1', meta: { open_files: ['a.md'] } });

    it('signals a MOUNTED panel over the live bus and reports it reused', async () => {
        const h = harness([codeSpec('c1')], ['c1']);
        const out = await openFileInEditor(
            { workspaceId: 'ws1', root: '/ws1', relPath: 'b.md', line: 7 },
            h.deps,
        );
        expect(out).toEqual({ reused: true, opened: false });
        expect(h.calls).toContain('emit:c1:b.md:7');
        expect(h.calls.some((c) => c.startsWith('createPanel'))).toBe(false);
        expect(h.calls.some((c) => c.startsWith('updateMeta'))).toBe(false);
    });

    it('activates the workspace BEFORE surfacing the panel', async () => {
        // activateWorkspace RESTORES this window's saved visible set for the
        // workspace — surfacing first would be undone a line later.
        const h = harness([codeSpec('c1')], ['c1']);
        await openFileInEditor({ workspaceId: 'ws1', root: '/ws1', relPath: 'b.md' }, h.deps);
        expect(h.calls.indexOf('activateWorkspace:ws1')).toBeLessThan(h.calls.indexOf('surface:c1'));
    });

    it('reopens a HIDDEN panel by seeding its meta, then surfacing it', async () => {
        const h = harness([codeSpec('c1')], []);
        const out = await openFileInEditor(
            { workspaceId: 'ws1', root: '/ws1', relPath: 'b.md' },
            h.deps,
        );
        expect(out).toEqual({ reused: true, opened: false });
        // No live listener exists on a hidden panel — the bus must NOT be used.
        expect(h.calls.some((c) => c.startsWith('emit:'))).toBe(false);
        expect(h.calls.some((c) => c.startsWith('createPanel'))).toBe(false);
        // The meta must land BEFORE the panel is surfaced: mounting is what
        // reads it, so a later write would miss the mount seed entirely.
        expect(h.calls.indexOf('putSpec:c1')).toBeLessThan(h.calls.indexOf('surface:c1'));
        expect(h.state.specs.find((s) => s.id === 'c1')?.meta?.open_files).toEqual(['a.md', 'b.md']);
    });

    it('still opens the file when persisting the seed FAILS', async () => {
        const h = harness([codeSpec('c1')], [], { updateFails: true });
        const out = await openFileInEditor(
            { workspaceId: 'ws1', root: '/ws1', relPath: 'b.md' },
            h.deps,
        );
        expect(out).toEqual({ reused: true, opened: false });
        expect(h.calls).toContain('surface:c1');
        expect(h.state.specs.find((s) => s.id === 'c1')?.meta?.active_file).toBe('b.md');
    });

    it('creates a panel only when the workspace has none, seeded with the file', async () => {
        const h = harness([], []);
        const out = await openFileInEditor(
            { workspaceId: 'ws1', root: '/ws1', relPath: 'b.md', line: 3 },
            h.deps,
        );
        expect(out).toEqual({ reused: false, opened: true });
        expect(h.state.created).toMatchObject({
            workspace_id: 'ws1',
            label: 'the-ripple-effect-files',
            cwd: '/ws1',
            type: 'code',
            meta: { open_files: ['b.md'], active_file: 'b.md', reveal_line: 3 },
        });
        expect(h.calls.indexOf('activateWorkspace:ws1')).toBeLessThan(
            h.calls.indexOf('surface:new1'),
        );
    });

    it('reports failure (and surfaces nothing) when the panel cannot be created', async () => {
        const h = harness([], [], { createThrows: true });
        const out = await openFileInEditor(
            { workspaceId: 'ws1', root: '/ws1', relPath: 'b.md' },
            h.deps,
        );
        expect(out).toEqual({ reused: false, opened: false });
        expect(h.calls.some((c) => c.startsWith('surface:'))).toBe(false);
    });

    it('opens a System target as an unattached System panel and reveals System', async () => {
        const h = harness([], []);
        await openFileInEditor(
            { workspaceId: '__system__', root: 'C:/logs', relPath: 'app.log' },
            h.deps,
        );
        expect(h.calls).toContain('revealSystem');
        expect(h.state.created).toMatchObject({
            workspace_id: null,
            label: 'system-files',
            cwd: 'C:/logs',
            meta: { system: true, open_files: ['app.log'] },
        });
    });
});

describe('newPanelLabel', () => {
    const code = (id: string, label: string, ws: string | null) =>
        spec({ id, type: 'code', workspace_id: ws, cwd: '/ws1', label });

    it('names the first editor panel `<base>-files`', () => {
        expect(newPanelLabel([], 'ws1', 'the-ripple-effect')).toBe('the-ripple-effect-files');
    });

    it('numbers the next one from 2', () => {
        const specs = [code('c1', 'the-ripple-effect-files', 'ws1')];
        expect(newPanelLabel(specs, 'ws1', 'the-ripple-effect')).toBe('the-ripple-effect-files-2');
    });

    it('never reuses a name already on screen (a deleted panel left a gap)', () => {
        // Numbering from the COUNT handed out `-3` again once `-files-2` was
        // deleted, leaving two panels wearing the same name.
        const specs = [
            code('c1', 'the-ripple-effect-files', 'ws1'),
            code('c3', 'the-ripple-effect-files-3', 'ws1'),
        ];
        expect(newPanelLabel(specs, 'ws1', 'the-ripple-effect')).toBe('the-ripple-effect-files-2');
    });

    it('counts only the target workspace panels', () => {
        const specs = [code('c1', 'other-files', 'ws2')];
        expect(newPanelLabel(specs, 'ws1', 'the-ripple-effect')).toBe('the-ripple-effect-files');
    });
});
