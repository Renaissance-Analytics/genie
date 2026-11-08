import { describe, expect, it } from 'vitest';
import { toStreamEvent, type StreamEvent } from '../src/core/stream-event.js';
import { LedgerRowCache, ledgerRow, type TimedEvent } from '../src/core/stream-view.js';
import { inspectorFor } from '../src/core/inspector.js';
import { revertToolEdit, toolEditPathIn } from '../src/core/revert-edit.js';
import { diffHeader } from '../src/core/agent-view.js';
import { attributionFrom, fileEventsOf } from '../src/core/files-panel.js';
import { deliveryFrom } from '../src/core/delivery.js';

/**
 * CODEX'S EDITS, LIKE CLAUDE'S (Tynn #440 part C). prism-acp 0.39.0 hands every native edit over as
 * `_meta['particle.academy/file_edits']`: workspace-relative `path`, a rename's `movePath`, `kind`, and a unified `diff`.
 * Genie reads the path, the diff and the +/- counts from it (Codex's own `changes` input names none of Claude's
 * `file_path` / `old_string` / `new_string`), shows a rename as a move, reverts by reverse-applying the diff (refused
 * with the reason when it does not apply cleanly), and says "diff unavailable (too large)" when prism left the list out.
 */

const FILE_EDITS = 'particle.academy/file_edits';
const OMITTED = 'particle.academy/omitted';

const UPDATE_DIFF = [
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' export { a };',
    '',
].join('\n');
const BEFORE = 'const a = 1;\nconst b = 2;\nexport { a };\n';
const AFTER = 'const a = 1;\nconst b = 3;\nconst c = 4;\nexport { a };\n';

const update = (edits: unknown, extraMeta: Record<string, unknown> = {}, status = 'completed'): Record<string, unknown> => ({
    sessionUpdate: 'tool_call_update', toolCallId: 'e1', name: 'edit', title: 'Apply file changes', kind: 'edit', status,
    rawInput: [{ path: '/work/src/app.ts', kind: { type: 'update' }, diff: '@@ ...' }],
    _meta: { ...(edits === undefined ? {} : { [FILE_EDITS]: edits }), ...extraMeta },
});
const tool = (u: Record<string, unknown>): Extract<StreamEvent, { kind: 'tool' }> => {
    const e = toStreamEvent(u);
    if (!e || e.kind !== 'tool') throw new Error('not a tool row');
    return e;
};
const timed = (u: Record<string, unknown>, id = 'r1'): TimedEvent => ({ id, at: 1_000, event: tool(u) });

const ONE = [{ path: 'src/app.ts', kind: 'update', textScope: 'file', diff: UPDATE_DIFF }];
const MOVE = [{ path: 'src/old.ts', movePath: 'src/new.ts', kind: 'update', textScope: 'file', diff: 'diff --git a/src/old.ts b/src/new.ts\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n' }];
const ADD = [{ path: 'docs/n.md', kind: 'add', textScope: 'file', newText: 'one\ntwo\n', diff: '--- /dev/null\n+++ b/docs/n.md\n@@ -0,0 +1,2 @@\n+one\n+two\n' }];

describe('the edit, as prism-acp hands it over', () => {
    it('path, diff and +/- counts come from the edit list, counted from the diff', () => {
        const e = tool(update(ONE));
        expect(e.edits).toEqual([{ path: 'src/app.ts', kind: 'update', diff: UPDATE_DIFF, plus: 2, minus: 1 }]);
        expect(e.editsOmitted).toBeUndefined();
    });

    it('a rename is a move: source and destination', () => {
        expect(tool(update(MOVE)).edits).toEqual([expect.objectContaining({ path: 'src/old.ts', movePath: 'src/new.ts', plus: 0, minus: 0 })]);
    });

    it('Claude\'s fragments (textScope: fragment) are not read from here: its own input stays the source', () => {
        const e = tool(update([{ path: 'src/app.ts', kind: 'update', textScope: 'fragment', oldText: 'a', newText: 'b', diff: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n' }]));
        expect(e.edits).toBeUndefined();
    });

    it('LEFT OUT for size (`omitted.file_edits`): marked, never an empty list', () => {
        const e = tool(update(undefined, { [OMITTED]: { file_edits: 'frame_budget', frameBytes: 70_000_000 } }));
        expect(e.editsOmitted).toBe(true);
        expect(e.edits).toBeUndefined();
    });
});

describe('the row, the inspector and the diff header', () => {
    it('the row names the file and carries its counts', () => {
        const r = new LedgerRowCache().row(timed(update(ONE)));
        expect(r.main).toBe('src/app.ts');
        expect(r.plus).toBe(2);
        expect(r.minus).toBe(1);
    });

    it('a move reads as one: `src/old.ts → src/new.ts`', () => {
        expect(ledgerRow(timed(update(MOVE))).main).toBe('src/old.ts → src/new.ts');
    });

    it('several files: the first and how many more', () => {
        expect(ledgerRow(timed(update([...ONE, ...ADD]))).main).toBe('src/app.ts and 1 more file');
    });

    it('the inspector shows the edit\'s own unified diff, with its path', () => {
        expect(inspectorFor(tool(update(ONE)))).toEqual({ kind: 'unified', path: 'src/app.ts', unified: UPDATE_DIFF });
    });

    it('TOO LARGE: the inspector and the row say "diff unavailable (too large)" — never "no changes"', () => {
        const e = tool(update(undefined, { [OMITTED]: { file_edits: 'frame_budget', frameBytes: 70_000_000 } }));
        expect(inspectorFor(e)).toEqual({ kind: 'none', reason: 'diff unavailable (too large)' });
        expect(ledgerRow({ id: 'r1', at: null, event: e }).note).toBe('diff unavailable (too large)');
    });

    it('the diff header counts from the diff too', () => {
        expect(diffHeader([timed(update(ONE))], 'r1')).toMatchObject({ plus: 2, minus: 1 });
    });
});

describe('revert: the diff applied in reverse, or refused with the reason', () => {
    it('applies cleanly: the file is put back as it was', () => {
        expect(revertToolEdit(AFTER, tool(update(ONE)))).toEqual({ ok: true, text: BEFORE });
    });

    it('the file changed since: refused, saying so, nothing guessed', () => {
        const r = revertToolEdit(AFTER.replace('const c = 4;', 'const c = 5;'), tool(update(ONE)));
        expect(r.ok).toBe(false);
        expect(r.ok ? '' : r.reason).toMatch(/does not apply/);
    });

    it('a move, a new file, several files, or a diff left out: refused, each with its reason', () => {
        for (const edits of [MOVE, ADD, [...ONE, ...ONE]]) {
            const r = revertToolEdit(AFTER, tool(update(edits)));
            expect(r.ok).toBe(false);
            expect(r.ok ? '' : r.reason.length).toBeGreaterThan(0);
        }
        const omitted = revertToolEdit(AFTER, tool(update(undefined, { [OMITTED]: { file_edits: 'frame_budget' } })));
        expect(omitted).toEqual({ ok: false, reason: 'diff unavailable (too large)' });
    });

    it('the file to revert is the edit\'s path inside the workspace; one outside it is none', () => {
        expect(toolEditPathIn(tool(update(ONE)), '/work')).toBe('src/app.ts');
        expect(toolEditPathIn(tool(update([{ ...ONE[0], path: '../escape.ts' }])), '/work')).toBeNull();
    });

    it('control: Claude\'s own edit still reverts from its old/new strings', () => {
        const claude = tool({ sessionUpdate: 'tool_call', toolCallId: 'c1', name: 'Edit', title: 'Edit', kind: 'edit', status: 'completed', rawInput: { file_path: '/work/a.ts', old_string: 'x = 1', new_string: 'x = 2' } });
        expect(revertToolEdit('let x = 2;', claude)).toEqual({ ok: true, text: 'let x = 1;' });
        expect(toolEditPathIn(claude, '/work')).toBe('a.ts');
    });
});

describe('where else an edit\'s file is read', () => {
    it('the Files panel marks the file the agent changed (a move: its destination)', () => {
        const rows = [timed(update(ONE), 'a'), timed({ ...update(MOVE), toolCallId: 'e2' }, 'b')];
        const marked = [...attributionFrom(fileEventsOf(rows, { id: 'ag', name: 'codex-a' }), '/work').keys()].sort();
        expect(marked).toEqual(['src/app.ts', 'src/new.ts']);
    });

    it('the Dashboard\'s last delivery names the file with its counts', () => {
        expect(deliveryFrom([timed(update(ONE))], 2_000)).toMatchObject({ kind: 'file', main: 'src/app.ts', plus: 2, minus: 1 });
    });
});
