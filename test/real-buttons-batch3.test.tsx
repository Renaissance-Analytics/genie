import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import type { RailItem } from '../src/core/rail-view.js';
import { ApprovalCardView } from '../src/renderer/components/ApprovalCard.js';
import { QuestionForm } from '../src/renderer/components/QuestionForm.js';
import { Sidebar } from '../src/renderer/components/Sidebar.js';
import { control } from './helpers/control-markup.js';

/**
 * REAL BUTTONS, batch 3 (the owner, 2026-11-01: "too many confusing UI that look like a button but aren't, and things
 * that are clickable but it doesn't look like they are"). The controls the owner presses most — an approval, a question's
 * Answer — show their work while it runs, and the Sidebar's runtime pill is made of real buttons, not spans inside the row.
 * Markup claims only (docs/decisions.md D3).
 */

type Approval = Parameters<typeof ApprovalCardView>[0]['approval'];
const approval = { question: 'git push origin', tool: 'shell', toolCallId: 'call_1', options: [{ id: 'allow', label: 'Allow once', tone: 'ok' }, { id: 'deny', label: 'Reject', tone: 'bad' }] } as unknown as Approval;
const card = (answering: string | null) =>
    renderToStaticMarkup(<ApprovalCardView approval={approval} answering={answering} onAnswer={() => {}} note="" onNote={() => {}} />);

describe('an approval: the option being sent shows its work, and every option waits', () => {
    it('the pressed option is a Button with a spinner and aria-busy; the other is disabled and says nothing', () => {
        const html = card('allow');
        const allow = control(html, 'data-approval-option="allow"');
        const deny = control(html, 'data-approval-option="deny"');
        expect(allow).toMatchObject({ tag: 'button', fancy: true });
        expect(allow!.open).toMatch(/\saria-busy="true"/);
        expect(allow!.inner).toMatch(/animate-spin/);
        expect(deny!.open).toMatch(/\sdisabled=""/);
        expect(deny!.open).not.toMatch(/aria-busy/);
        expect(deny!.inner).not.toMatch(/animate-spin/);
    });

    it('CONTROL: nothing in flight — both live, no spinner', () => {
        const html = card(null);
        for (const id of ['allow', 'deny']) {
            const c = control(html, `data-approval-option="${id}"`);
            expect(c).toMatchObject({ tag: 'button', fancy: true });
            expect(c!.open).not.toMatch(/\sdisabled=""|aria-busy/);
        }
    });
});

const questions = [{ header: 'Workers', question: 'How many workers?', options: [{ label: '4' }, { label: '8' }] }];
const item: DeckItem = { id: 'q_1', source: 'agent-question', agentId: 'a1', agentName: 'lark', workspaceId: 'moic', title: 'Workers', blocking: true, priority: 'normal', at: 1, answer: { kind: 'form', fields: 1, questions }, forwardedFrom: null };

describe('a question: Answer shows its work while the answer is sent', () => {
    it('sending: Answer is busy (spinner, aria-busy) and cannot be pressed again', () => {
        const html = renderToStaticMarkup(<QuestionForm item={item} answering="q_1" refusal={null} onSubmit={() => {}} />);
        const answer = control(html, 'data-action="deck-submit"');
        expect(answer).toMatchObject({ tag: 'button', fancy: true });
        expect(answer!.open).toMatch(/\saria-busy="true"/);
        expect(answer!.open).toMatch(/\sdisabled=""/);
        expect(answer!.inner).toMatch(/animate-spin/);
    });

    it('CONTROL: not sending — Answer is not busy', () => {
        const html = renderToStaticMarkup(<QuestionForm item={item} answering={null} refusal={null} onSubmit={() => {}} />);
        expect(control(html, 'data-action="deck-submit"')!.open).not.toMatch(/aria-busy/);
    });
});

describe('the Sidebar’s runtime pill: real buttons BESIDE the row, not spans inside it', () => {
    const row = { id: 'tynn', path: '/w/tynn', name: 'tynn', count: 2, alert: false, working: 0, processes: 'running', processesTitle: '1 process running', sites: 'none', sitesTitle: 'No hosted sites yet' } as unknown as RailItem;
    const memory = { getItem: () => '0', setItem: () => {} };
    const html = renderToStaticMarkup(
        <Sidebar route="genie://dashboard" deckCount={0} workspaces={[row]} available={['deck', 'dashboard', 'genie', 'workspace', 'settings']} onNavigate={() => {}} railStorage={memory} onOpenProcesses={() => {}} onOpenSites={() => {}} />,
    );

    it('processes and sites are react-fancy Buttons, named for what they open', () => {
        expect(control(html, 'data-ws-processes="tynn"')).toMatchObject({ tag: 'button', fancy: true });
        expect(control(html, 'data-ws-processes="tynn"')!.open).toContain('aria-label="1 process running"');
        expect(control(html, 'data-ws-sites="tynn"')).toMatchObject({ tag: 'button', fancy: true });
        expect(html).not.toContain('role="button"');
    });

    it('neither sits inside the workspace row’s button (no interactive content nested in a button)', () => {
        const rowButton = control(html, 'data-workspace="tynn"');
        expect(rowButton).toMatchObject({ tag: 'button' });
        expect(rowButton!.open).toContain('data-react-fancy-sidebar-item=""');
        expect(rowButton!.inner).not.toContain('data-ws-processes');
        expect(rowButton!.inner).not.toContain('data-ws-sites');
        expect(rowButton!.inner).not.toMatch(/<button\b/);
    });
});
