import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentActivity } from '../Master/AgentActivity';
import {
    emptyAgentSession,
    type AgentSession,
    type AgentSessionIdentity,
    type Message,
    type ToolCall,
} from '../../../main/agentsession/model';

/**
 * That the ACTIVITY tab draws what the projection says.
 *
 * The decisions are tested in `lib/__tests__/agent-activity.test.ts`; this asserts the render
 * carries them, because a rule computed correctly and then dropped on the floor is
 * indistinguishable from one computed wrong — and `AgentStream.tsx` once carried a comment
 * describing a whole feature for a release while no implementation existed.
 *
 * Two things can only be checked here: that an unknown time renders NO element rather than a
 * placeholder, and that a row with something behind it is a real `<button>` while a row with
 * nothing behind it stays an inert `<div>`.
 */

const IDENTITY: AgentSessionIdentity = {
    agentId: 'atlas',
    specId: 'spec-1',
    provider: 'claude',
    name: 'atlas',
    cwd: '/w',
    workspaceId: 'tynn',
};

function session(over: Partial<AgentSession> = {}): AgentSession {
    const base = emptyAgentSession(IDENTITY, 1_000_000);
    return { ...base, ...over, session: { ...base.session, ...(over.session ?? {}) } };
}

const msg = (over: Partial<Message> & { id: string }): Message => ({
    role: 'user',
    content: 'ship it',
    author: null,
    at: 10,
    ...over,
});

const tool = (over: Partial<ToolCall> & { id: string }): ToolCall => ({
    name: 'Write',
    status: 'success',
    kind: 'write',
    rawInput: { file_path: '/w/main/ipc.ts' },
    result: null,
    at: 20,
    ...over,
});

const render = (s: AgentSession, onInspect?: (id: string) => void): string =>
    renderToStaticMarkup(
        React.createElement(AgentActivity, { session: s, ...(onInspect ? { onInspect } : {}) }),
    );

/** How many times a fragment appears. Counts, not booleans: "it is there" passes on a surface
 *  that renders the thing once for every row by mistake just as happily as on a correct one. */
const count = (html: string, needle: string): number => html.split(needle).length - 1;

/** Rows, counted on the FULL class attribute. `class="activity-row"` and not the bare class
 *  name, because the container's `activity-rows` contains it as a substring — a looser count
 *  reported one extra row and would have gone on reporting it for every future container. */
const rows = (html: string): number => count(html, 'class="activity-row"');

describe('the activity list', () => {
    it('POSITIVE CONTROL: draws a row per observed event, with its text and its kind', () => {
        const html = render(
            session({
                transcript: [msg({ id: 'm1', author: 'wren', content: 'take the migration' })],
                tools: [tool({ id: 't1' })],
            }),
        );
        expect(rows(html)).toBe(2);
        expect(html).toContain('take the migration');
        expect(html).toContain('wren');
        expect(html).toContain('ipc.ts');
        expect(html).toContain('data-kind="heard"');
        expect(html).toContain('data-kind="wrote"');
    });

    it('makes a row with something behind it a BUTTON, and leaves the rest inert', () => {
        /**
         * The `AgentStream` idiom, kept: never a div with an onClick. A row that responds to
         * Enter and announces itself as activatable is the difference between a surface a
         * keyboard reaches and one it does not — and a row with nothing to open stays a div
         * rather than becoming a control that does nothing when pressed.
         */
        const s = session({ transcript: [msg({ id: 'm1' })], tools: [tool({ id: 't1' })] });
        const html = render(s, () => {});
        // One button for the one tool call. The message row has nothing to inspect, so a
        // second button here would mean every row became a control.
        expect(count(html, '<button')).toBe(1);
        expect(html).toContain('data-kind="wrote"');
    });

    it('renders no button at all when nothing can act on the rows', () => {
        // POSITIVE CONTROL is the test above: the same session WITH a handler has one.
        const s = session({ transcript: [msg({ id: 'm1' })], tools: [tool({ id: 't1' })] });
        expect(count(render(s), '<button')).toBe(0);
        expect(rows(render(s))).toBe(2);
    });

    it('renders NO time element for a row Genie cannot place in time', () => {
        // Not a dash and not "unknown" — a placeholder in a time column reads as a time that
        // failed to load, when the truth is that nobody stamped the event.
        expect(count(render(session({ transcript: [msg({ id: 'm1', at: null })] })), '<time')).toBe(0);
    });

    it('POSITIVE CONTROL: a stamped row does render a machine-readable time', () => {
        /**
         * Asserted on `dateTime` rather than on the visible text on purpose: the label is
         * local-time, and CI runs in a different zone from this desktop — a test pinned to the
         * rendered clock would pass here and fail on the ubuntu runner.
         */
        const html = render(session({ transcript: [msg({ id: 'm1', at: 0 })] }));
        expect(count(html, '<time')).toBe(1);
        // React 19 emits the attribute in its camelCase form rather than lowercasing it to
        // `datetime`. Harmless -- HTML attribute names are case-insensitive, so a browser
        // reads it as `datetime` either way -- but asserted as it is actually rendered, since
        // a test written against the spelling I expected would fail on correct markup.
        expect(html).toContain('dateTime="1970-01-01T00:00:00.000Z"');
    });
});

describe('the sources panel', () => {
    it('says what it CANNOT see instead of showing an empty list', () => {
        /**
         * The defect this surface exists to avoid. An Observed agent with no mail yet has an
         * empty Activity list, and an empty list reads as "this agent has done nothing" — when
         * the truth is that two of the board's three sources never reach Genie at all.
         */
        const html = render(session());
        expect(html).toContain('Terminal I/O');
        expect(html).toContain('Commits');
        expect(html).toContain('per workspace');
        expect(rows(html)).toBe(0);
    });

    it('prints a number ONLY for a source it measured', () => {
        /**
         * The null/zero rule, as markup. `mail` is counted because Genie owns AgentInbox;
         * `terminal` and `commits` never are. A count rendered for all six would put a
         * confident `0` beside "Commits", which is a claim nobody can support.
         */
        const html = render(session({ transcript: [msg({ id: 'm1' })] }));
        expect(count(html, 'activity-source-count')).toBe(1);
        // Counted on the data attribute, not the class: `activity-blind-label` and
        // `activity-blind-reason` both contain the row's own class name, so a substring count
        // on it would report three hits per source and pass whatever the real number was.
        expect(count(html, 'data-blind')).toBe(5);
    });

    it('POSITIVE CONTROL: every source it can measure prints its number', () => {
        // Without this, the test above passes on a panel that prints one count and drops the
        // rest — the counts would still be "only for measured sources", and still wrong.
        const html = render(
            session({ transcript: [msg({ id: 'm1' })], tools: [tool({ id: 't1' })] }),
        );
        // mail, files and tools are all measurable once a tool call has arrived.
        expect(count(html, 'activity-source-count')).toBe(3);
    });
});
