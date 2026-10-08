import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../main/agentsession/model';
import { inspectorFor } from '../tool-inspector';

/**
 * THE INSPECTOR — §5.2's *"every tool call with its arguments and result"*.
 *
 * The board also draws a selected edit opening **as a diff**, and that part is NOT buildable
 * from what the provider sends. Measured, a real `tool_call_update` for a `Write` carries:
 *
 *     content: [{ type: 'content', content: { type: 'text', text: 'File created successfully…' } }]
 *
 * — a text confirmation. ACP *defines* a `diff` content variant carrying `path`/`oldText`/
 * `newText`, and this reads it when present, but claude did not send one in any captured turn.
 * So the diff view is supported and unproven, which is said out loud here rather than
 * discovered by someone wondering why it never appears.
 *
 * What IS real is the pair the owner asked for: the arguments the agent passed, and what came
 * back. Both were being discarded until genie#843.
 */

const call = (over: Partial<ToolCall> = {}): ToolCall => ({
    id: 't1',
    name: 'Write',
    status: 'success',
    kind: 'edit',
    rawInput: null,
    result: null,
    at: 1,
    ...over,
});

/** The EXACT nesting a real agent sent. Doubly wrapped — `content[].content.text`. */
const realResult = [
    {
        type: 'content',
        content: { type: 'text', text: 'File created successfully at: /tmp/x/hello.txt' },
    },
];

describe('the result pane', () => {
    it('reads the doubly-nested shape a real agent actually sends', () => {
        // `content[].content.text`, not `content[].text`. Getting this wrong yields an empty
        // pane for every successful call, which reads as "no result" rather than as a parse bug.
        const v = inspectorFor(call({ result: realResult }));
        expect(v.result).toBe('File created successfully at: /tmp/x/hello.txt');
    });

    it('joins several content entries in order', () => {
        const v = inspectorFor(
            call({
                result: [
                    { type: 'content', content: { type: 'text', text: 'first' } },
                    { type: 'content', content: { type: 'text', text: 'second' } },
                ],
            }),
        );
        expect(v.result).toBe('first\nsecond');
    });

    it('also reads the FLAT shape, since the protocol permits it', () => {
        // Defensive, and cheap: a provider sending `{type:'text', text}` directly is valid ACP.
        // Supporting both costs one branch; supporting one and guessing costs an empty pane.
        const v = inspectorFor(call({ result: [{ type: 'text', text: 'flat' }] }));
        expect(v.result).toBe('flat');
    });

    it('is NULL when there is no result, not an empty string', () => {
        // `null` means the call reported nothing — which for a pending call is the truth. An
        // empty string would render an empty pane that looks like a result of no content.
        expect(inspectorFor(call()).result).toBeNull();
        expect(inspectorFor(call({ result: [] })).result).toBeNull();
    });

    it('survives junk, because `result` is untrusted', () => {
        // It is an agent's payload. A string where an array was expected must not throw inside
        // a render and take the whole stream with it.
        for (const junk of ['a string', 42, {}, [null], [{ type: 'image' }], [{ content: {} }]]) {
            expect(() => inspectorFor(call({ result: junk }))).not.toThrow();
        }
    });
});

describe('the arguments pane', () => {
    it('shows what the agent passed, formatted to be read', () => {
        const v = inspectorFor(call({ rawInput: { file_path: '/w/a.ts', content: 'hi' } }));
        expect(v.args).toContain('"file_path"');
        expect(v.args).toContain('/w/a.ts');
        // Indented: a one-line JSON blob of a 40-line file write is not oversight.
        expect(v.args).toContain('\n');
    });

    it('is NULL when the agent reported no arguments', () => {
        expect(inspectorFor(call()).args).toBeNull();
    });

    it('renders a non-object payload rather than refusing it', () => {
        // The wire says `unknown`. A provider passing a bare string is unusual, not impossible,
        // and showing it is strictly better than an empty pane that implies no arguments.
        expect(inspectorFor(call({ rawInput: 'bare' })).args).toBe('"bare"');
    });

    it('survives a payload that cannot be serialised', () => {
        // A cyclic object would make `JSON.stringify` throw. Inside a render that is the whole
        // surface gone, so it degrades to a note instead.
        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic.self = cyclic;
        const v = inspectorFor(call({ rawInput: cyclic }));
        expect(v.args).toContain('could not be shown');
    });
});

describe('the diff view — supported, and UNPROVEN', () => {
    it('reads a diff content entry when one arrives', () => {
        /**
         * ACP defines this variant; claude did not send one in any captured turn. Supporting it
         * costs a branch and means the surface becomes correct the day a provider does send
         * one, with no component edit — the same reasoning as deriving `approvalsSupported`
         * from the driver rather than from a list of provider names.
         */
        const v = inspectorFor(
            call({
                result: [{ type: 'diff', path: '/w/a.ts', oldText: 'before', newText: 'after' }],
            }),
        );
        expect(v.diff).toEqual({ path: '/w/a.ts', oldText: 'before', newText: 'after' });
    });

    it('is NULL for the text result a real agent sends, which is the common case', () => {
        // The positive control for the honesty of the claim above: the observed shape produces
        // NO diff, so a surface showing one would be showing something it invented.
        expect(inspectorFor(call({ result: realResult })).diff).toBeNull();
    });

    it('ignores a diff entry missing its texts, rather than rendering half of one', () => {
        // A one-sided diff is not a diff. Better absent than a pane claiming nothing changed.
        expect(inspectorFor(call({ result: [{ type: 'diff', path: '/w/a.ts' }] })).diff).toBeNull();
    });
});
