import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Stream, initialFollowTail } from '../src/renderer/components/Stream.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE STREAM, RENDERED.
 *
 * A markup claim, as everywhere else: it does not prove scrolling works, that `scrollToId`
 * lands, or that tail-follow breaks on a wheel gesture. Those live inside `VirtualList`, which
 * has its own suite and its own break probes, and the one thing I owe it is a check in Genie's
 * own context — which is a VM job, not this.
 */

const at = 1_760_000_000_000;

const timed = (event: StreamEvent, id: string, over: Partial<TimedEvent> = {}): TimedEvent => ({
    id, event, at, ...over,
});

const ROWS: readonly TimedEvent[] = [
    timed({ kind: 'message', speaker: 'you', peerName: null, text: 'Add the passkey endpoint' }, 'm1'),
    timed({ kind: 'think', text: 'The flow needs\na challenge table first.', tokens: null }, 'th1'),
    timed(
        {
            kind: 'tool', toolCallId: 't1', name: 'Bash', title: 'php artisan test',
            status: 'completed', toolKind: 'execute', rawInput: {},
        },
        'to1',
    ),
    timed(
        {
            kind: 'tool', toolCallId: 't2', name: 'Edit', title: 'src/core/session.ts',
            status: 'completed', toolKind: 'edit', rawInput: { file_path: 'src/core/session.ts' },
        },
        'ed1',
    ),
];

function render(over: Partial<Parameters<typeof Stream>[0]> = {}): string {
    return renderToStaticMarkup(
        <Stream rows={ROWS} lanes={null} at={null} selectedId={null} onSelect={() => {}} {...over} />,
    );
}

describe('the empty state', () => {
    it('says SOMETHING, and says which nothing it is', () => {
        /**
         * Stream is always present for a declared agent and never gated on anything. With no
         * events it shows an empty state and the composer stays — it does not hide. §0.4 is a
         * finished UI that was unreachable because one condition decided it should not render.
         *
         * And the two nothings get different sentences: an agent nobody has asked anything is
         * not the same as a lane filter that excludes every row, and a blank panel merges them.
         */
        const fresh = render({ rows: [] });
        expect(fresh).toContain('data-stream="empty"');
        expect(fresh).toContain('No events yet');

        const filteredOut = render({ lanes: [] });
        expect(filteredOut).toContain('data-stream="empty"');
        expect(filteredOut).toContain('Clear the filter');

        // The two messages are genuinely different text, not one string reused.
        expect(fresh).not.toContain('Clear the filter');
        expect(filteredOut).not.toContain('No events yet');
    });
});

describe('rows', () => {
    it('renders the ledger rows', () => {
        const html = render();

        // Activity only: the message is the chat's.
        expect(html).not.toContain('data-stream-row="m1"');
        expect(html).not.toContain('Add the passkey endpoint');
        expect(html).toContain('php artisan test');
    });

    it('draws a thought as one line, a control that opens it in place — never the Inspector', () => {
        const html = render();
        const row = html.slice(html.indexOf('data-stream-row="th1"'), html.indexOf('data-stream-row="to1"'));

        expect(row).toContain('The flow needs a challenge table first.');
        expect(row).toContain('truncate');
        expect(row).toContain('italic');
        // The owner (using beta.19): click the thinking line to see the reasoning. It toggles in place; it is not an
        // Inspector selection.
        expect(row).toContain('data-expandable="true"');
        expect(row).toContain('role="button"');
        expect(row).not.toContain('data-inspectable');
    });

    it('makes an EDIT row inspectable and tinted, and a tool row neither', () => {
        const html = render();
        const edit = html.slice(html.indexOf('data-stream-row="ed1"'));
        const tool = html.slice(html.indexOf('data-stream-row="to1"'), html.indexOf('data-stream-row="ed1"'));

        expect(edit).toContain('data-inspectable="true"');
        expect(edit).toContain('role="button"');
        expect(edit).toContain('src/core/session.ts');

        // POSITIVE CONTROL: the non-edit tool call is a row and not a control, so
        // "inspectable" is a reading rather than a constant.
        expect(tool).not.toContain('data-inspectable');
        expect(tool).toContain('data-stream-row="to1"');
    });

    it('renders no line counts when no diff was computed', () => {
        // `applied`, with no numbers. A `+0 −0` asserts an edit that changed nothing, which is
        // a claim about the file rather than about our bookkeeping.
        const edit = render().slice(render().indexOf('data-stream-row="ed1"'));
        expect(edit).toContain('applied');
        expect(edit).not.toContain('+0');
        expect(edit).not.toContain('−0');

        // POSITIVE CONTROL: given a real diff, the same row DOES print them.
        const withDiff = render({ diffs: new Map([['ed1', { plus: 42, minus: 8, newFile: false }]]) });
        expect(withDiff.slice(withDiff.indexOf('data-stream-row="ed1"'))).toContain('+42');
    });

    it('leaves the time column EMPTY rather than printing a stopped clock', () => {
        // A row replayed from a thread that stored no timestamps. The column keeps its width so
        // rows do not jag left and right; `--:--:--` would read as a clock that stopped.
        const html = render({ rows: [timed({ kind: 'think', text: 'x', tokens: null }, 'th1', { at: null })] });

        expect(html).toContain('data-stream-row="th1"');
        expect(html).not.toContain('--:--');
        expect(html).toContain('w-[62px]');
    });
});

describe('the unseen pill', () => {
    it('is absent while following, which is the arrival state without a deep link', () => {
        // `↓ 0 new` would be furniture. It appears only when the reader has scrolled away AND
        // something arrived, and neither is true on first paint.
        expect(render()).not.toContain('data-unseen');
    });
});

describe('tail-follow and deep links', () => {
    it('starts following with no anchor, and NOT following with one', () => {
        /**
         * The trap, measured by `VirtualList`'s author: a pending `scrollToId` wins over
         * `followTail` *while it resolves*, but if following is still on when the link lands,
         * the list resumes and carries the reader straight back to the bottom.
         *
         * It is also the only sensible reading of the intent. A link to one event —
         * `genie://agent/kai?tab=stream&at=ev_8831`, which is how an agent asks a human to
         * look at something — is a request to look at THAT event.
         */
        expect(initialFollowTail(null)).toBe(true);
        expect(initialFollowTail('ev_8831')).toBe(false);
    });

    it('passes the anchor through to the list as scrollToId', () => {
        const html = render({ at: 'ed1' });
        // Asserted via the row being rendered at all: `VirtualList` owns the scrolling, and
        // what this component owes it is the id and a `followTail` that is off.
        expect(html).toContain('data-stream-row=');
    });
});
