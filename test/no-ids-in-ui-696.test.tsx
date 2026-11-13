import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Drawer } from '@particle-academy/react-fancy';
import type { DeckItem, SignalState } from '../src/core/deck.js';
import { inboxThreads, pairKey, type ThreadMail } from '../src/core/inbox-threads.js';
import { idsIn, personText } from '../src/core/person-text.js';
import { AlertToasts } from '../src/renderer/components/AlertToasts.js';
import { ChatMailRow } from '../src/renderer/components/ChatFlyout.js';
import { ChatProse } from '../src/renderer/components/ChatProse.js';
import { Deck } from '../src/renderer/components/Deck.js';
import { InboxFlyoutView, type InboxFlyoutViewProps } from '../src/renderer/components/InboxFlyout.js';
import { MobileShell } from '../src/renderer/components/MobileShell.js';

/**
 * NO INTERNAL IDS IN FRONT OF THE PERSON (Tynn #696; the owner, 2026-11-13: "make sure we aren't showing agent ids in any
 * ui", over a chat mail card reading "Answer to your question q_90ef0195-4818-43f9-9273-3442f387948c: E-sign — …").
 *
 * The guard renders the surfaces a person reads from fixtures FULL of ids (agent_*, q_*, msg_*, flow_*, a workspace ULID,
 * a bare UUID) and fails on any id-shaped string in what a person sees: the text, and the title / aria-label / alt /
 * placeholder attributes. `data-*`, `href` and `key` are the app's, not the person's, and are not read.
 */
const AGENT = 'agent_0123456789abcdef0123456789abcdef';
const QID = 'q_90ef0195-4818-43f9-9273-3442f387948c';
const MSG = 'msg_1b2c3d4e-1111-4222-8333-444455556666';
const FLOW = 'flow_7a8b9c0d-aaaa-4bbb-8ccc-dddddddddddd';
const WS = '01JD3X5ZQ8K2M4N6P8R0T2V4W6';
const UUID = '5f0c1e2d-3b4a-4c5d-9e6f-7a8b9c0d1e2f';
const T = Date.UTC(2026, 10, 13, 12, 0, 0);

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&nbsp;': ' ' };
/** What a person reads of some markup: its text, and the attributes a screen, a tooltip or a screen reader shows. */
function personFacing(html: string): string {
    const attrs = [...html.matchAll(/\s(?:title|aria-label|alt|placeholder)="([^"]*)"/g)].map((m) => m[1]!);
    const text = html.replace(/<[^>]*>/g, ' ');
    return [text, ...attrs].join('\n').replace(/&(?:amp|lt|gt|quot|#x27|#39|nbsp);/g, (e) => ENTITIES[e] ?? e);
}
const idsShown = (html: string): string[] => idsIn(personFacing(html));

describe('the gauge (positive and negative controls)', () => {
    it('recognises every id shape the app mints or relays — and not a name, a commit, a version or a sentence', () => {
        for (const id of [AGENT, QID, MSG, FLOW, WS, UUID, 'q_e07a0573…', 'conn_9f8e7d6c5b4a']) expect(idsIn(`see ${id} here`), id).toEqual([id]);
        for (const text of ['atlas', 'commit 3b4a4c5', 'v2.0.0-beta.62', 'Answer to your question:', 'snake_case_name', 'E-sign — DocuSign']) expect(idsIn(text), text).toEqual([]);
    });

    it('an id rendered deliberately — as text, a tooltip or an accessible name — makes the guard fail', () => {
        expect(idsShown(renderToStaticMarkup(<p>{`from ${AGENT}`}</p>))).toEqual([AGENT]);
        expect(idsShown(renderToStaticMarkup(<span title={QID}>x</span>))).toEqual([QID]);
        expect(idsShown(renderToStaticMarkup(<button type="button" aria-label={`Open ${MSG}`}>x</button>))).toEqual([MSG]);
    });

    it('an id the app keeps for itself — data-*, an href — is not the person’s and passes', () => {
        expect(idsShown(renderToStaticMarkup(<a href={`#${QID}`} data-agent={AGENT}>the question</a>))).toEqual([]);
    });
});

describe('personText: the person’s reading of a text, ids removed, at render', () => {
    it('the FTQ answer mail’s first line reads "Answer to your question:" — the agent’s copy keeps its id', () => {
        const mail = `Answer to your question ${QID}:\n- **E-sign** — Which provider?\n  → DocuSign`;
        expect(personText(mail)).toBe('Answer to your question:\n- **E-sign** — Which provider?\n  → DocuSign');
        expect(mail).toContain(QID);
    });

    it('a dismissal’s "(Your question q_….)" reads "(Your question.)"; an id in backticks leaves no empty code', () => {
        expect(personText(`Dismissed. (Your question ${QID}.)`)).toBe('Dismissed. (Your question.)');
        expect(personText(`wrote to \`${AGENT}\` about it`)).toBe('wrote to about it');
    });

    it('link targets and URLs keep theirs (they are how an in-app link reaches its agent); their words do not', () => {
        expect(personText(`[atlas](genie-agent://${AGENT}) and [${AGENT}](genie-agent://${AGENT})`)).toBe(`[atlas](genie-agent://${AGENT}) and [](genie-agent://${AGENT})`);
        expect(personText(`see https://tynn.ai/s/${UUID}`)).toBe(`see https://tynn.ai/s/${UUID}`);
    });

    it('text with no id comes back the same object', () => {
        const plain = 'Shipped — **diff attached**';
        expect(personText(plain)).toBe(plain);
    });
});

describe('the surfaces, from fixtures full of ids (control: each fixture really carries them)', () => {
    const answer = `Answer to your question ${QID}:\n- **E-sign** — Which provider?\n  → DocuSign`;
    const prose = `Asked ${AGENT} about it; see ${MSG}.\n\nThe flow ${FLOW} ran in workspace ${WS} (run ${UUID}).\n\n\`\`\`\ngenie agent restart ${AGENT}\n\`\`\`\n\n[agent:${AGENT}|atlas] is on it.`;

    it('a chat mail card and its preview: "Answer to your question: E-sign — …"', () => {
        expect(idsIn(answer).length).toBeGreaterThan(0);
        const html = renderToStaticMarkup(<ChatMailRow m={{ id: MSG, who: 'mail', from: 'you → atlas', text: answer, delivered: true, at: T, mailId: MSG } as never} onOpenMail={() => {}} />);
        expect(idsShown(html)).toEqual([]);
        expect(personFacing(html)).toContain('Answer to your question: E-sign — Which provider? → DocuSign');
    });

    it('an agent’s reply in the chat and the stream (ChatProse), code blocks and pills included', () => {
        expect(idsIn(prose).length).toBeGreaterThan(4);
        const html = renderToStaticMarkup(<ChatProse text={prose} />);
        expect(idsShown(html)).toEqual([]);
        // CONTROL: the words around the ids are still there.
        for (const words of ['Asked', 'about it', 'genie agent restart', 'atlas', 'is on it']) expect(personFacing(html)).toContain(words);
    });

    describe('the AgentInbox flyout', () => {
        let seq = 0;
        const m = (from: string, to: string, text: string, at: number): ThreadMail =>
            ({ seq: ++seq, id: `msg_00000000-0000-4000-8000-00000000000${seq}`, from, to, text, attachments: [], sentAt: new Date(at).toISOString(), readAt: null });
        const mail = [
            m('human', AGENT, answer, T - 60_000),
            m(AGENT, 'human', prose, T - 30_000),
        ];
        const names: Record<string, string> = { human: 'you', [AGENT]: 'atlas' };
        const threads = inboxThreads(mail, (p) => names[p] ?? p);
        const key = pairKey('human', AGENT);
        const noop = () => {};
        const record = {
            id: QID, agentName: 'atlas', askedAt: new Date(T - 90_000).toISOString(), at: new Date(T - 60_000).toISOString(), outcome: 'answered' as const,
            questions: [{ header: 'E-sign', question: 'Which provider?', options: [{ label: 'DocuSign' }, { label: 'HelloSign' }] }],
            selections: [['DocuSign']], notes: [''], note: '',
        };
        const props = (over: Partial<InboxFlyoutViewProps> = {}): InboxFlyoutViewProps => ({
            threads, peers: [{ address: 'tynn:claude:atlas', agentId: AGENT, name: 'atlas', reachable: true }],
            thread: { key, messages: mail as never, more: false, limit: 50, focus: null }, openKey: key, query: '', filter: 'all', now: T,
            uncollected: 0, unread: 0, draft: '',
            onQuery: noop, onFilter: noop, onOpenThread: noop, onLoadOlder: noop, onDraft: noop, onSend: noop, onDownload: noop, onMarkAllRead: noop, onDelete: noop, onClose: noop,
            ...over,
        });
        const html = (p: InboxFlyoutViewProps) => renderToStaticMarkup(<Drawer open onClose={noop} attach="container"><InboxFlyoutView {...p} /></Drawer>);

        it('the thread list and the open thread: no id; the FTQ answer is named by its question’s header', () => {
            const out = html(props());
            expect(idsShown(out)).toEqual([]);
            expect(personFacing(out)).toContain('E-sign');
        });

        it('the question panel expanded', () => {
            expect(idsShown(html(props({ expandedQuestions: [QID], questions: { [QID]: { status: 'ok', record } } })))).toEqual([]);
        });

        it('search results', () => {
            const out = html(props({ threadQuery: 'about', search: { query: 'about', status: 'done', hits: [mail[1]] as never, total: 1, error: null } }));
            expect(out).toContain('data-inbox-search-hit');
            expect(idsShown(out)).toEqual([]);
        });
    });

    const deckItem = (over: Partial<DeckItem> = {}): DeckItem => ({
        id: QID, source: 'agent-question', agentId: AGENT, agentName: 'atlas', workspaceId: WS,
        title: `atlas asks (${QID}): ship the flow ${FLOW}?`, blocking: true, priority: 'normal', at: T,
        answer: { kind: 'form', fields: 1, questions: [] }, forwardedFrom: null, detail: `run ${UUID} failed in ${MSG}`, ...over,
    } as DeckItem);
    const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };

    it('the Deck', () => {
        const html = renderToStaticMarkup(<Deck items={[deckItem()]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} focusId={QID} />);
        expect(html).toContain('data-deck-item');
        expect(idsShown(html)).toEqual([]);
        expect(personFacing(html)).toContain('ship the flow');
    });

    it('the mobile UI’s Needs you', () => {
        const html = renderToStaticMarkup(<MobileShell host="alphar" locked={false} refusal={null} items={[deckItem()]} answering={null} onAnswer={() => {}} onDisconnect={() => {}} />);
        expect(html).toContain('data-mobile-item');
        expect(idsShown(html)).toEqual([]);
        expect(personFacing(html)).toContain('ship the flow');
    });

    it('a toast', () => {
        const html = renderToStaticMarkup(<AlertToasts toasts={[{ id: MSG, title: `bolt@${WS}`, body: `Finished: merged ${MSG} for ${AGENT}` }]} onDismiss={() => {}} />);
        expect(idsShown(html)).toEqual([]);
        expect(personFacing(html)).toContain('bolt');
    });
});
