import { describe, expect, it } from 'vitest';
import { inspectorFor } from '../src/core/inspector.js';
import type { StreamEvent } from '../src/core/stream-event.js';

const tool = (over: Partial<Extract<StreamEvent, { kind: 'tool' }>> = {}): Extract<StreamEvent, { kind: 'tool' }> => ({
    kind: 'tool', toolCallId: 't1', name: 'Edit', title: 'src/core/session.ts',
    status: 'completed', toolKind: 'edit', rawInput: null, ...over,
});

/**
 * WHAT THE INSPECTOR SHOWS, AND WHAT IT REFUSES TO SHOW.
 *
 * The hard case is a `Write` that replaced an existing file. The tool reports only the new
 * content, so a diff would have to invent the old — and an empty `before` renders the whole
 * file as newly added, which is a confident lie about what the agent did. That one gets a
 * content view with the reason stated, not a diff.
 */

describe('an Edit call', () => {
    it('is a diff, from the strings the tool actually reported', () => {
        const content = inspectorFor(tool({
            name: 'Edit',
            rawInput: { file_path: 'src/core/session.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
        }));

        expect(content).toEqual({
            kind: 'diff', path: 'src/core/session.ts', before: 'const a = 1;', after: 'const a = 2;',
        });
    });

    it('still diffs when the path is missing, rather than refusing', () => {
        // The diff is the useful part. An unnamed file is a label problem, not a data problem.
        const content = inspectorFor(tool({ rawInput: { old_string: 'a', new_string: 'b' } }));
        expect(content).toMatchObject({ kind: 'diff', path: null });
    });
});

describe('a Write call', () => {
    it('shows the CONTENT and says why it is not a diff', () => {
        /**
         * The whole reason this module exists. `Write` reports only what it wrote, so there is
         * no `before` — and `before: ''` renders every line as newly added, which is exactly
         * right for a new file and a confident lie about an overwrite.
         *
         * Genie cannot tell the two apart from the wire. So it shows the content, says what it
         * is showing, and does not guess.
         */
        const content = inspectorFor(tool({
            name: 'Write',
            rawInput: { file_path: 'src/new.ts', content: 'export const x = 1;\n' },
        }));

        expect(content).toMatchObject({
            kind: 'content', path: 'src/new.ts', text: 'export const x = 1;\n',
        });
        expect((content as { note: string }).note).toContain('prior contents');
    });
});

describe('a MultiEdit call', () => {
    it('diffs every edit it reported, in order', () => {
        const content = inspectorFor(tool({
            name: 'MultiEdit',
            rawInput: {
                file_path: 'x.ts',
                edits: [
                    { old_string: 'a', new_string: 'A' },
                    { old_string: 'b', new_string: 'B' },
                ],
            },
        }));

        expect(content).toMatchObject({ kind: 'diff', path: 'x.ts' });
        // Concatenated so one view covers the call, which is what the agent did in one step.
        expect(content).toMatchObject({ before: 'a\nb', after: 'A\nB' });
    });

    it('ignores a malformed entry rather than diffing undefined against undefined', () => {
        const content = inspectorFor(tool({
            name: 'MultiEdit',
            rawInput: { file_path: 'x.ts', edits: [{ old_string: 'a', new_string: 'A' }, { nonsense: true }] },
        }));
        expect(content).toMatchObject({ before: 'a', after: 'A' });
    });
});

describe('a non-edit call', () => {
    it('renders its arguments as JSON', () => {
        const content = inspectorFor(tool({
            name: 'Bash', toolKind: 'execute',
            rawInput: { command: 'php artisan test', timeout: 120_000 },
        }));

        expect(content).toEqual({ kind: 'json', value: { command: 'php artisan test', timeout: 120_000 } });
    });

    it('renders a plain string argument as text, not as JSON', () => {
        expect(inspectorFor(tool({ toolKind: 'execute', rawInput: 'ls -la' }))).toEqual({ kind: 'text', text: 'ls -la' });
    });
});

describe('the two nothings, which must not look alike', () => {
    it('refuses when the agent did not send the arguments', () => {
        /**
         * `rawInput === null` says *"the agent did not send this call's arguments"* — **never
         * `{}`**. The two are different claims: `{}` is "it sent an empty object", which is a
         * thing some tools genuinely do.
         *
         * A refusal with a reason beats an inspector that opens and then says nothing, which
         * reads as a broken diff rather than as missing data.
         */
        const content = inspectorFor(tool({ rawInput: null }));
        expect(content).toMatchObject({ kind: 'none' });
        expect((content as { reason: string }).reason).toContain('did not report');
    });

    it('shows an EMPTY OBJECT as an empty object, because that is what arrived', () => {
        // The other half, and the half usually forgotten. `{}` is data.
        expect(inspectorFor(tool({ toolKind: 'execute', rawInput: {} }))).toEqual({ kind: 'json', value: {} });
    });

    it('refuses an edit whose strings are absent, rather than diffing nothing against nothing', () => {
        // An `Edit` with neither string is a call we cannot show. A diff of '' against '' is an
        // empty panel claiming the agent changed nothing.
        const content = inspectorFor(tool({ name: 'Edit', rawInput: { file_path: 'x.ts' } }));
        expect(content).toMatchObject({ kind: 'none' });

        // POSITIVE CONTROL: the same shape WITH strings does produce a diff, so the refusal is
        // a reading rather than a function that refuses every edit.
        expect(inspectorFor(tool({ name: 'Edit', rawInput: { file_path: 'x.ts', old_string: 'a', new_string: 'b' } })))
            .toMatchObject({ kind: 'diff' });
    });

    it('never returns a diff with both sides identical', () => {
        // COUNT over the shapes that could produce one. An identical-sides diff renders an
        // empty panel, which reads as "the inspector is broken" rather than "nothing changed".
        const shapes = [
            tool({ rawInput: { old_string: 'same', new_string: 'same' } }),
            tool({ name: 'MultiEdit', rawInput: { edits: [{ old_string: 'x', new_string: 'x' }] } }),
        ];

        const identical = shapes
            .map(inspectorFor)
            .filter((c) => c.kind === 'diff' && c.before === c.after);
        expect(identical).toEqual([]);
    });
});

describe('arguments that are not JSON', () => {
    it('does NOT hand a cyclic object to the JSON view', () => {
        /**
         * `rawInput` arrives from a `JSON.parse` of the provider's stdout, so in practice it is
         * JSON. "In practice" is not a type, and the failure if it is ever wrong is not
         * cosmetic: a cyclic object makes the JSON view throw, which takes the Agent view down
         * while somebody is reading a turn.
         */
        const cyclic: Record<string, unknown> = { command: 'ls' };
        cyclic['self'] = cyclic;

        const content = inspectorFor(tool({ toolKind: 'execute', rawInput: cyclic }));
        expect(content.kind).toBe('text');

        // POSITIVE CONTROL: break the cycle and the same object IS a JSON view, so the
        // rejection is a reading rather than a function that refuses every object.
        cyclic['self'] = 'no longer a cycle';
        expect(inspectorFor(tool({ toolKind: 'execute', rawInput: cyclic })).kind).toBe('json');
    });

    it('does not let NaN through as a legitimate-looking number', () => {
        // `JSON.stringify` turns `NaN` into `null`, which silently converts a broken number
        // into a value that reads as a deliberate one.
        expect(inspectorFor(tool({ toolKind: 'execute', rawInput: { timeout: Number.NaN } })).kind).toBe('text');
        expect(inspectorFor(tool({ toolKind: 'execute', rawInput: { timeout: 120 } })).kind).toBe('json');
    });

    it('keeps a legitimate null inside the arguments', () => {
        // The other direction: `null` is a real JSON value and a real argument. Rejecting it
        // would push ordinary tool calls into the text view.
        expect(inspectorFor(tool({ toolKind: 'execute', rawInput: { cwd: null, command: 'ls' } })))
            .toEqual({ kind: 'json', value: { cwd: null, command: 'ls' } });
    });
});
