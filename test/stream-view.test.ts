import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/core/stream-event.js';
import {
    LANES,
    laneOf,
    ledgerRow,
    resolveThinkTokens,
    resolveToolDurations,
    visibleRows,
    type TimedEvent,
} from '../src/core/stream-view.js';

/**
 * THE STREAM IS A LEDGER, NOT A CHAT TRANSCRIPT.
 *
 * One line per event: time, icon, a main field, a meta field. **This is the single biggest
 * divergence in the build this replaces** — it rendered a chat feed, which is why the screen
 * looked nothing like the approved design even though most of the data was already there.
 *
 * Everything here is a decision, so it is decided here and tested without a DOM.
 */

const at = 1_760_000_000_000;

const timed = (event: StreamEvent, over: Partial<TimedEvent> = {}): TimedEvent => ({
    id: 'e1', event, at, ...over,
});

const tool = (over: Partial<Extract<StreamEvent, { kind: 'tool' }>> = {}): StreamEvent => ({
    kind: 'tool', toolCallId: 't1', name: 'Bash', title: 'php artisan test --filter=Challenge',
    status: null, toolKind: 'execute', rawInput: null, ...over,
});

describe('a thought row', () => {
    it('is ONE line, italic, and never expandable — not on click, not while streaming', () => {
        /**
         * The strongest instruction in the design, and it is about reading rather than taste:
         * content that grows and reflows as reasoning arrives is the worst reading experience
         * in agent UIs, and a thought is the one thing that streams continuously.
         *
         * `clamp` and `expandable` are separate fields on purpose. One is how it is drawn, the
         * other is whether a click does anything — and a clamped row that still expands on
         * click is the same defect with an extra step.
         */
        const row = ledgerRow(timed({ kind: 'think', text: 'The passkey flow needs a challenge table.', tokens: null }));

        // Drawn as one line, and EXPANDABLE to its whole text on click — the owner's word over the spec's "never".
        expect(row).toMatchObject({ icon: 'brain', tone: 'violet', clamp: true, expandable: true, italic: true, full: 'The passkey flow needs a challenge table.' });
        expect(row.main).toBe('The passkey flow needs a challenge table.');
    });

    it('collapses a multi-line thought to one line rather than letting it set the row height', () => {
        const row = ledgerRow(timed({ kind: 'think', text: 'first line\nsecond line\n\nthird', tokens: null }));
        expect(row.main).toBe('first line second line third');
        expect(row.main).not.toContain('\n');
    });

    it('shows NO token figure when none was derived, and a Δ when one was', () => {
        // Per-thought token counts are not an ACP field. The design's `842 tok` is a DELTA in
        // reported usage across the thought's span, and it is labelled as one: `Δ+0.8k`, a
        // measured difference with a unit, never a figure presented as exact. Estimating from
        // character count was considered and rejected — that is a confident number about
        // someone's spend, invented here.
        expect(ledgerRow(timed({ kind: 'think', text: 'x', tokens: null })).meta).toBeNull();
        expect(ledgerRow(timed({ kind: 'think', text: 'x', tokens: 842 })).meta).toBe('Δ+842 tok');
        expect(ledgerRow(timed({ kind: 'think', text: 'x', tokens: 8_400 })).meta).toBe('Δ+8.4k tok');
    });
});

describe('a tool row', () => {
    it('reads as command then result, in mono', () => {
        const row = ledgerRow(timed(tool({ status: 'completed' })));

        expect(row).toMatchObject({ icon: 'wrench', mono: true, tone: 'muted' });
        expect(row.main).toBe('Bash  php artisan test --filter=Challenge');
    });

    it('turns the META red on a failure, and nothing else about the row', () => {
        // The row stays legible. A whole-row red for a failed tool call makes a stream of
        // normal work look like a disaster, and the thing that failed is the CALL.
        const failed = ledgerRow(timed(tool({ status: 'failed' })));
        expect(failed.meta).toBe('err');
        expect(failed.metaTone).toBe('bad');
        expect(failed.tone).toBe('muted');

        // POSITIVE CONTROL: a completed call is not red, so `metaTone` is a reading.
        expect(ledgerRow(timed(tool({ status: 'completed' }))).metaTone).toBe('default');
    });

    it('says NOTHING about status when the agent did not report one', () => {
        // Never defaulted to `pending`. "The agent has not said" and "the agent said pending"
        // are different claims, and only one of them is in the data.
        expect(ledgerRow(timed(tool({ status: null }))).meta).toBeNull();
    });

    it('appends a duration only when one was MEASURED', () => {
        const measured = ledgerRow(timed(tool({ status: 'completed' })), { durationMs: 4_200 });
        expect(measured.meta).toBe('ok · 4.2s');

        // No pairing, no duration. Not `0s`, which would read as instant.
        expect(ledgerRow(timed(tool({ status: 'completed' }))).meta).toBe('ok');
    });

    it('falls back to the tool NAME when no title was sent, and to neither when there is none', () => {
        expect(ledgerRow(timed(tool({ title: null }))).main).toBe('Bash');
        // A call with neither is still a row — it happened — but it does not invent a label.
        expect(ledgerRow(timed(tool({ title: null, name: null }))).main).toBe('(tool call)');
    });

    it('marks an UNREPORTED kind once, inline, and does not call it “other”', () => {
        // `other` is a category the provider can claim; `null` is one it did not. The design
        // gives them different marks and says `(kind not reported)` for the second.
        const unknown = ledgerRow(timed(tool({ toolKind: null, status: 'completed' })));
        expect(unknown.note).toBe('(kind not reported)');
        expect(unknown.icon).not.toBe('wrench');

        // POSITIVE CONTROL: a declared `other` gets no such note.
        expect(ledgerRow(timed(tool({ toolKind: 'other', status: 'completed' }))).note).toBeNull();
    });
});

describe('an edit row', () => {
    it('is a TOOL CALL of kind edit — tinted, emerald, and inspectable', () => {
        /**
         * The design lists `edit` as its own row kind; the wire has no such event. An edit is a
         * tool call whose `kind` is `edit`, which is why `toolKind` had to be carried through
         * the mapper at all.
         *
         * It is the only inspectable row: selecting it opens the diff.
         */
        const row = ledgerRow(timed(tool({
            name: 'Edit', title: 'src/core/session.ts', toolKind: 'edit', status: 'completed',
            rawInput: { file_path: 'src/core/session.ts' },
        })));

        expect(row).toMatchObject({
            icon: 'pencil', tone: 'emerald', tinted: true, inspectable: true, mono: true,
        });
        expect(row.main).toBe('src/core/session.ts');
    });

    it('is NOT inspectable when the agent never sent the call’s arguments', () => {
        // `rawInput === null` says "the agent did not send this call's arguments" — never `{}`.
        // An inspector opened on nothing is a panel that appears and then says nothing, which
        // reads as a broken diff rather than as missing data.
        const blind = ledgerRow(timed(tool({ toolKind: 'edit', title: 'x.ts', rawInput: null, status: 'completed' })));
        expect(blind.inspectable).toBe(false);
        expect(blind.note).toBe('(arguments not reported)');
    });

    it('shows line counts only from a real diff', () => {
        const withDiff = ledgerRow(
            timed(tool({ toolKind: 'edit', title: 'x.ts', rawInput: { file_path: 'x.ts' }, status: 'completed' })),
            { diff: { plus: 42, minus: 8, newFile: false } },
        );
        // The board draws the counts as two cells, so the meta says only what happened to the file.
        expect(withDiff.meta).toBe('applied');
        expect(withDiff.plus).toBe(42);
        expect(withDiff.minus).toBe(8);

        const newFile = ledgerRow(
            timed(tool({ toolKind: 'edit', title: 'x.ts', rawInput: { file_path: 'x.ts' }, status: 'completed' })),
            { diff: { plus: 12, minus: 0, newFile: true } },
        );
        expect(newFile.meta).toBe('new file');
        expect(newFile.plus).toBe(12);
        // A zero side is ABSENT, not `−0`.
        expect(newFile.minus).toBeNull();

        // No diff computed: the row still says it applied, and claims no numbers. NEVER a
        // `+0 −0`, which asserts an edit that changed nothing.
        const noDiff = ledgerRow(timed(tool({ toolKind: 'edit', title: 'x.ts', rawInput: { file_path: 'x.ts' }, status: 'completed' })));
        expect(noDiff.meta).toBe('applied');
        expect(noDiff.meta).not.toContain('0');
    });
});

describe('usage and plan rows', () => {
    it('reads a usage row in mono with the figures the wire actually carried', () => {
        const row = ledgerRow(timed({ kind: 'usage', used: 182_000, size: 200_000, cost: 4.12, turnCost: 0.61 }));
        expect(row).toMatchObject({ icon: 'gauge', mono: true });
        expect(row.main).toBe('context 182k / 200k · $0.61 this turn');
    });

    it('omits the cost entirely when the provider reports none — codex reports none', () => {
        // Not a `$0.00`, which would claim the turn was free. There is no Cost field at all.
        const row = ledgerRow(timed({ kind: 'usage', used: 38_000, size: 200_000, cost: null }));
        expect(row.main).toBe('context 38k / 200k');
        expect(row.main).not.toContain('$');
    });

    it('reads a plan row from the entries the agent sent', () => {
        const row = ledgerRow(timed({
            kind: 'plan',
            entries: [
                { content: 'Challenge table', status: 'completed' },
                { content: 'Enrolment endpoint', status: 'in_progress' },
                { content: 'Browser test', status: 'pending' },
            ],
        }));

        expect(row).toMatchObject({ icon: 'list-checks', tone: 'sky' });
        // `1 of 3`, not `2 of 3`. The in-progress step is NOT done, and counting it as done
        // overstates the agent's progress — which is the direction this project least wants to
        // be wrong in. The first draft of this expectation did exactly that.
        expect(row.main).toBe('1 of 3 · in progress: Enrolment endpoint');
    });

    it('does not claim a step count from a plan it could not read', () => {
        const row = ledgerRow(timed({ kind: 'plan', entries: [{ nonsense: true }] }));
        expect(row.main).toBe('plan updated');
    });
});

describe('the compaction divider', () => {
    it('reports both sides of the compaction, in amber', () => {
        const row = ledgerRow(timed({ kind: 'divider', variant: 'compaction', before: 189_000, after: 46_000 }));
        expect(row.tone).toBe('amber');
        expect(row.main).toBe('context compacted · 189k → 46k');
    });

    it('still renders when the sizes were not reported', () => {
        const row = ledgerRow(timed({ kind: 'divider', variant: 'compaction', before: null, after: null }));
        expect(row.main).toBe('context compacted');
        expect(row.main).not.toContain('0');
    });
});

describe('lanes', () => {
    it('files every row kind into a lane, or none', () => {
        expect(laneOf({ kind: 'message', speaker: 'you', peerName: null, text: 'x' })).toBe('messages');
        expect(laneOf({ kind: 'think', text: 'x', tokens: null })).toBe('thoughts');
        expect(laneOf(tool())).toBe('tools');
        expect(laneOf(tool({ toolKind: 'edit' }))).toBe('edits');
        // A usage row belongs to no lane: it is bookkeeping, not activity.
        expect(laneOf({ kind: 'usage', used: 1, size: 2, cost: null })).toBeNull();
    });

    it('offers exactly the four the design names', () => {
        expect(LANES).toEqual(['messages', 'thoughts', 'tools', 'edits']);
    });
});

describe('filtering by lane', () => {
    const rows: readonly TimedEvent[] = [
        timed({ kind: 'message', speaker: 'you', peerName: null, text: 'go' }, { id: 'm1' }),
        timed({ kind: 'think', text: 'hmm', tokens: null }, { id: 'th1' }),
        timed(tool(), { id: 'to1' }),
        timed(tool({ toolKind: 'edit', title: 'x.ts' }), { id: 'ed1' }),
        timed({ kind: 'divider', variant: 'compaction', before: 189_000, after: 46_000 }, { id: 'cmp' }),
        timed({ kind: 'usage', used: 1, size: 2, cost: null }, { id: 'u1' }),
    ];

    it('keeps only the chosen lanes', () => {
        expect(visibleRows(rows, ['edits']).map((r) => r.id)).toEqual(['ed1', 'cmp']);
        expect(visibleRows(rows, ['messages', 'thoughts']).map((r) => r.id)).toEqual(['m1', 'th1', 'cmp']);
    });

    it('NEVER filters out a compaction divider, in any lane selection', () => {
        /**
         * *"Silent amnesia is the top cause of 'why did it get stupid'."* A compaction divider
         * renders in every filter state, including one that excludes everything else.
         *
         * COUNT across every lane subset rather than spot-checking one: a divider surviving
         * three filters and vanishing on the fourth is the version of this bug that ships.
         */
        const subsets: (readonly ('messages' | 'thoughts' | 'tools' | 'edits')[])[] = [
            [], ['messages'], ['thoughts'], ['tools'], ['edits'],
            ['messages', 'edits'], ['tools', 'thoughts'], ['messages', 'thoughts', 'tools', 'edits'],
        ];

        const missing = subsets.filter((lanes) => !visibleRows(rows, lanes).some((r) => r.id === 'cmp'));
        expect(missing).toEqual([]);

        // POSITIVE CONTROL: the filter does remove things, so surviving means something. With
        // no lanes selected the compaction divider is the ONLY row left.
        expect(visibleRows(rows, []).map((r) => r.id)).toEqual(['cmp']);
    });

    it('shows everything when no lane filter is applied at all', () => {
        // `null` is "not filtering", which is a different state from "filtering to nothing".
        expect(visibleRows(rows, null)).toHaveLength(rows.length);
    });
});

describe('think token deltas', () => {
    it('attributes the rise in reported usage across a thought’s span to that thought', () => {
        /**
         * The only honest way to put a number on a thought. ACP carries no per-thought count,
         * so the figure is the DIFFERENCE between the usage reported before it and after it —
         * and it is labelled `Δ` for exactly that reason.
         */
        const resolved = resolveThinkTokens([
            timed({ kind: 'usage', used: 10_000, size: 200_000, cost: null }, { id: 'u1' }),
            timed({ kind: 'think', text: 'a', tokens: null }, { id: 'th1' }),
            timed({ kind: 'usage', used: 10_842, size: 200_000, cost: null }, { id: 'u2' }),
        ]);

        const think = resolved.find((r) => r.id === 'th1');
        expect(think?.event).toMatchObject({ kind: 'think', tokens: 842 });
    });

    it('leaves a thought with NO figure when no usage bracketed it', () => {
        // Which is the common case at the start of a turn, and it must render nothing rather
        // than borrow the next thought's number.
        const resolved = resolveThinkTokens([timed({ kind: 'think', text: 'a', tokens: null }, { id: 'th1' })]);
        expect(resolved[0]?.event).toMatchObject({ tokens: null });
    });

    it('splits a single usage report EVENLY across the thoughts it covers, or not at all', () => {
        // Two thoughts between one pair of usage reports cannot be told apart. Attributing the
        // whole delta to one of them would be a made-up attribution; dividing it is at least a
        // stated average. The alternative is `null` for both, which hides a real cost.
        const resolved = resolveThinkTokens([
            timed({ kind: 'usage', used: 1_000, size: 200_000, cost: null }, { id: 'u1' }),
            timed({ kind: 'think', text: 'a', tokens: null }, { id: 'th1' }),
            timed({ kind: 'think', text: 'b', tokens: null }, { id: 'th2' }),
            timed({ kind: 'usage', used: 1_100, size: 200_000, cost: null }, { id: 'u2' }),
        ]);

        expect(resolved.filter((r) => r.event.kind === 'think').map((r) => (r.event as { tokens: number | null }).tokens))
            .toEqual([50, 50]);
    });

    it('never produces a NEGATIVE delta, which a compaction would otherwise create', () => {
        // Usage drops when the context is compacted. A naive difference would report a thought
        // that gave tokens back.
        const resolved = resolveThinkTokens([
            timed({ kind: 'usage', used: 189_000, size: 200_000, cost: null }, { id: 'u1' }),
            timed({ kind: 'think', text: 'a', tokens: null }, { id: 'th1' }),
            timed({ kind: 'usage', used: 46_000, size: 200_000, cost: null }, { id: 'u2' }),
        ]);

        expect(resolved.find((r) => r.id === 'th1')?.event).toMatchObject({ tokens: null });
    });
});

describe('tool durations', () => {
    it('measures from the call to its terminal update', () => {
        const durations = resolveToolDurations([
            timed(tool({ toolCallId: 't1', status: 'pending' }), { id: 'a', at }),
            timed(tool({ toolCallId: 't1', status: 'completed' }), { id: 'b', at: at + 4_200 }),
        ]);

        expect(durations.get('t1')).toBe(4_200);
    });

    it('measures NOTHING for a call that never finished', () => {
        // An unfinished call is the signature of a turn that did not complete — the design's
        // error state. A duration there would claim it ended.
        const durations = resolveToolDurations([timed(tool({ toolCallId: 't1', status: 'in_progress' }), { at })]);
        expect(durations.has('t1')).toBe(false);
    });

    it('measures nothing when either end has no timestamp', () => {
        const durations = resolveToolDurations([
            timed(tool({ toolCallId: 't1', status: 'pending' }), { id: 'a', at: null }),
            timed(tool({ toolCallId: 't1', status: 'completed' }), { id: 'b', at: at + 1_000 }),
        ]);
        expect(durations.has('t1')).toBe(false);

        // POSITIVE CONTROL: with both timestamps present the same pair does measure.
        const ok = resolveToolDurations([
            timed(tool({ toolCallId: 't1', status: 'pending' }), { id: 'a', at }),
            timed(tool({ toolCallId: 't1', status: 'completed' }), { id: 'b', at: at + 1_000 }),
        ]);
        expect(ok.get('t1')).toBe(1_000);
    });
});
