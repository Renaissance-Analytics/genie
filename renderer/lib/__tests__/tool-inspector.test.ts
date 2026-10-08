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

/**
 * TERMINAL CONTROL SEQUENCES IN PROVIDER DATA — stripped for LEGIBILITY, not for safety.
 *
 * Being precise about which problem this solves, because the overclaim is tempting and
 * wrong. This pane renders through React, which escapes text nodes, so an escape sequence
 * here cannot execute or inject markup. What it CAN do is make a result pane unreadable:
 * C0/C1 controls render as nothing or as replacement glyphs, so `\x1b[31mFAILED\x1b[0m`
 * arrives as `[31mFAILED[0m` or worse, and a cursor-movement sequence silently eats the
 * characters a reader is looking for.
 *
 * ## Why it is OURS to do
 *
 * prism-acp 0.6.1 sanitises LABELS — approval titles, consent reasons, tool-call titles —
 * and deliberately does NOT sanitise tool-result `content` or `rawInput`. Its README states
 * the contract: *"result text may contain meaningful color codes for terminal clients, and
 * `rawInput` preserves the provider's exact arguments. Clients should not assume control
 * sequences have been removed from content or input data."*
 *
 * That is the right call for a library serving terminal clients as well as this one. It
 * also means a DOM pane that wants readable text has to ask. We use prism's own helper
 * rather than a local regex: theirs handles the 8-bit C1 introducers and both
 * string-terminator spellings, and prism found a defect in its own four-branch
 * implementation that three tests had missed — a hand-rolled `\x1b\[[0-9;]*m` here would
 * have exactly that hole, and 8-bit forms are what someone reaches for BECAUSE naive
 * filters only look for the 7-bit one.
 */
describe('provider control sequences', () => {
    it('strips colour codes from result text so the words survive', () => {
        const inspector = inspectorFor(
            call({
                result: [{ type: 'content', content: { type: 'text', text: '\u001b[31mFAILED\u001b[0m 3 tests' } }],
            }),
        );

        expect(inspector.result).toBe('FAILED 3 tests');
    });

    it('strips the 8-BIT C1 introducer too, which a naive filter misses', () => {
        // `\u009b` is CSI as a single byte — the form that defeats a `\x1b[`-only regex.
        // This is the case prism's own sanitiser had four branches for and no test on.
        const inspector = inspectorFor(
            call({ result: [{ type: 'content', content: { type: 'text', text: '\u009b2Kvisible' } }] }),
        );

        expect(inspector.result).toBe('visible');
    });

    it('does NOT strip arguments — JSON.stringify has already escaped them, and fidelity wins', () => {
        const inspector = inspectorFor(call({ rawInput: { command: 'ls \u001b[1;32m--color\u001b[0m' } }));

        // Two separate facts, and the first is why the second is the right choice.
        //
        // `JSON.stringify` escapes control characters itself, so the ESCAPE BYTE never
        // reaches the DOM — the pane shows the six visible characters `\u001b`. The args
        // pane was therefore never exposed, and stripping here would buy nothing.
        //
        // It would also COST something. prism keeps `rawInput` byte-exact deliberately —
        // *"you may need those byte for byte to echo or re-run a command"* — so a stripped
        // args pane would show a command that is not the command that ran. For a surface
        // whose entire job is "what did the agent actually pass", that is the worse failure.
        expect(inspector.args).not.toContain('\u001b'); // no raw byte...
        expect(inspector.args).toContain('\\u001b'); // ...because it is shown as an escape
        expect(inspector.args).toContain('--color');
    });

    it('is the one assertion above that was VACUOUS, so it is pinned in both directions', () => {
        // Kept as its own case because the original version of the test above asserted only
        // `not.toContain('\u001b')` and passed against unfixed code — `JSON.stringify` had
        // already made it true. A test that cannot fail is worse than no test: it reports
        // coverage of a decision nobody made. The pair of assertions above is what makes
        // the choice (escape, don't strip) visible and breakable.
        const raw = { s: '\u001b[0m' };
        expect(JSON.stringify(raw)).toBe('{"s":"\\u001b[0m"}');
    });

    it('leaves ordinary text completely alone', () => {
        // THE POSITIVE CONTROL. Every assertion above is "something was removed", and all of
        // them would pass on a sanitiser that returned the empty string, or one that mangled
        // punctuation. This pins that the common case — which is every real tool result —
        // comes through byte for byte.
        const plain = 'Wrote 42 lines to src/Auth/Store.php\n  - added: challenge()\n\ttabbed\r\nCRLF kept';
        const inspector = inspectorFor(
            call({ result: [{ type: 'content', content: { type: 'text', text: plain } }] }),
        );

        expect(inspector.result).toBe(plain);
    });

    it('keeps tabs and newlines, which are whitespace rather than chrome', () => {
        // Asserted separately from the control above because this is the boundary a
        // control-character filter is most likely to get wrong: `\t`, `\n` and `\r` ARE C0
        // controls, and stripping all C0 would silently flatten every multi-line result
        // into one unreadable line while every other test here still passed.
        const inspector = inspectorFor(
            call({ result: [{ type: 'content', content: { type: 'text', text: 'a\tb\nc\rd' } }] }),
        );

        expect(inspector.result).toBe('a\tb\nc\rd');
    });
});
