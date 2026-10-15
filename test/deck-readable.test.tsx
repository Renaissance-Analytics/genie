import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Question } from '../src/core/attention.js';
import { DAY_MS, type DeckItem, type SignalState } from '../src/core/deck.js';
import { deckItemsFrom } from '../src/core/deck-sources.js';
import { mintAgentId } from '../src/core/identity.js';
import { workspaceDisplayName } from '../src/core/workspace-name.js';
import type { PendingQuestion } from '../src/main/attention-store.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { Deck } from '../src/renderer/components/Deck.js';

/**
 * THE DECK'S QUESTIONS, READABLE (the owner, 2026-10-15, with a screenshot of the Deck: "I can't read this. This UI is
 * totally garbage."). What it showed: each row TITLED by the raw first question — Markdown unrendered, cut off — and the
 * question again in a monospace box. Now:
 *
 * - the title is the question's short HEADER, plain text ("Engine", "Engine + 1 more") — never `**` or backticks;
 * - the row says WHO asked, the workspace's NAME (the rail's, never the id) and HOW LONG AGO;
 * - the body is the question rendered from its Markdown (QuestionForm), sans at 13px, at a reading width.
 */
const QUIET: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false } as SignalState;
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const MARKDOWN = 'Which **engine** should `db` use?\n\n- postgres for prod\n- sqlite for tests';
const WS_ID = 'ws_01JTYNN0000000000000000';

const pending = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
    id: 'q_1',
    key: 'k',
    agentId: 'agent_a' as PendingQuestion['agentId'],
    agentName: 'atlas',
    workspaceId: WS_ID,
    questions: [{ header: 'Engine', question: MARKDOWN, options: [{ label: 'postgres' }, { label: 'sqlite' }] }],
    priority: 'normal',
    askedAt: '2026-10-15T10:00:00.000Z',
    ...over,
});
const itemsOf = (qs: PendingQuestion[]) =>
    deckItemsFrom({ questions: qs, userList: [], unreadDms: [], finished: [], agents: {}, workspaceNames: { [WS_ID]: 'Tynn.ai' } });
const render = (items: readonly DeckItem[], extra: Partial<Parameters<typeof Deck>[0]> = {}) =>
    renderToStaticMarkup(<Deck items={items} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} now={NOW} {...extra} />);
const titleOf = (html: string, id: string) => html.match(new RegExp(`data-deck-title="${id}"[^>]*>([^<]*)<`))?.[1] ?? null;

describe('the title is the header, as plain text', () => {
    it('one question: its header — no `**`, no backticks, not the question', () => {
        const [item] = itemsOf([pending()]);
        expect(item!.title).toBe('Engine');
        expect(item!.title).not.toMatch(/\*\*|`/);
        const html = render([item!]);
        expect(titleOf(html, 'q_1')).toBe('Engine');
    });

    it('several: "<header> + N more"; a header written in Markdown has its marks taken out', () => {
        const [item] = itemsOf([pending({ questions: [
            { header: '**DB** `x`', question: MARKDOWN, options: [{ label: 'a' }, { label: 'b' }] },
            { header: 'Where', question: 'Where?', options: [{ label: 'x' }, { label: 'y' }] },
            { header: 'When', question: 'When?', options: [{ label: 'now' }, { label: 'later' }] },
        ] as Question[] })]);
        expect(item!.title).toBe('DB x + 2 more');
        expect(item!.title).not.toMatch(/\*|`/);
    });

    it('control: the question’s Markdown IS rendered — as HTML in the body, never raw', () => {
        const html = render(itemsOf([pending()]));
        expect(html).toContain('<strong>engine</strong>');
        expect(html).toContain('<code>db</code>');
        expect((html.match(/<li>/g) ?? []).length).toBe(2);
        // COUNTED: the raw marks appear nowhere on the page.
        expect(html.split('**').length - 1).toBe(0);
        expect(html).not.toContain('`db`');
    });
});

describe('who asked, where, and how long ago', () => {
    it('the agent’s name, the workspace’s NAME (never its id) and the age from askedAt', () => {
        const html = render(itemsOf([pending()]));
        expect(html).toMatch(/data-deck-agent="agent_a"[^>]*>atlas</);
        expect(html).toMatch(new RegExp(`data-deck-workspace="${WS_ID}"[^>]*>Tynn\\.ai<`));
        // The id rides as an attribute; it is never text a person reads.
        expect(html).not.toContain(`>${WS_ID}<`);
        expect(html).toMatch(/data-deck-age="q_1"[^>]*>2 h ago</);
    });

    it('an unknown workspace gets no name rather than its id', () => {
        const [item] = deckItemsFrom({ questions: [pending({ workspaceId: 'ws_gone' })], userList: [], unreadDms: [], finished: [], agents: {}, workspaceNames: { [WS_ID]: 'Tynn.ai' } });
        expect(item!.workspaceName).toBeUndefined();
        expect(render([item!])).not.toContain('ws_gone<');
    });
});

describe('the body reads like prose', () => {
    it('the question is the form, in the sans face at 13px, at a reading width — no monospace anywhere in it', () => {
        const html = render(itemsOf([pending()]));
        const form = html.match(/<form[^>]*data-deck-form="q_1"[\s\S]*?<\/form>/)?.[0] ?? '';
        expect(form).not.toBe('');
        expect(form).toMatch(/^<form[^>]*class="[^"]*max-w-\[72ch\][^"]*font-sans/);
        const text = form.match(/data-question-text="0"[\s\S]*?<\/div><\/div><\/div>/)?.[0] ?? '';
        expect(text).toMatch(/class="[^"]*font-sans[^"]*text-\[13px\]/);
        expect(form).not.toContain('font-mono');
        // Not cut off: the whole question is there.
        expect(form).toContain('sqlite for tests');
    });

    it('one question: no header chip under a title that already IS the header; several: a chip each', () => {
        expect(render(itemsOf([pending()]))).not.toContain('data-question-header');
        const two = render(itemsOf([pending({ questions: [pending().questions[0]!, { header: 'Where', question: 'Where?', options: [{ label: 'x' }, { label: 'y' }] }] })]));
        expect((two.match(/data-question-header="/g) ?? []).length).toBe(2);
    });

    it('a to-do is read as text with its Done button — never again in a monospace box', () => {
        const [todo] = deckItemsFrom({ questions: [], userList: [{ workspaceId: WS_ID, item: { id: 'li_1', text: 'rotate the GitHub token', askedBy: 'agent_a', createdAt: '2026-10-15T11:00:00.000Z', done: false } }], unreadDms: [], finished: [], agents: {}, workspaceNames: { [WS_ID]: 'Tynn.ai' } });
        const html = render([todo!]);
        expect(html.split('rotate the GitHub token').length - 1).toBe(1);
        expect(html).toContain('data-approval-option="done"');
        expect(html).not.toContain('font-mono text-xs text-[var(--fg-1)]');
    });
});

describe('Dismiss on the Deck', () => {
    const approval: DeckItem = {
        id: 'approval:kai', source: 'agent-question', agentId: 'kai', agentName: 'kai', workspaceId: WS_ID, title: 'Allow rm -rf build?',
        blocking: true, priority: 'normal', at: NOW - 3 * DAY_MS, answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] }, forwardedFrom: null,
    };

    it('every agent question has Dismiss beside Answer; a tool approval does not (control)', () => {
        const html = render([...itemsOf([pending()]), approval], { onDismiss: () => {} });
        expect(html).toMatch(/data-action="deck-submit"[\s\S]*?data-action="question-dismiss"[^>]*data-deck-dismiss="q_1"[^>]*>Dismiss</);
        expect((html.match(/data-deck-dismiss="/g) ?? []).length).toBe(1);
        expect(html).not.toContain('data-deck-dismiss="approval:kai"');
    });

    it('"Dismiss all older than 1 day" shows, with how many, only when such questions exist', () => {
        const old = pending({ id: 'q_old', key: 'k2', askedAt: '2026-10-14T09:00:00.000Z' });
        const fresh = pending({ id: 'q_new', key: 'k3', askedAt: '2026-10-15T11:30:00.000Z' });
        const html = render(itemsOf([old, fresh]), { onDismissOlder: () => {} });
        expect(html).toMatch(/data-action="deck-dismiss-older"[^>]*data-deck-older="1"[^>]*>Dismiss all older than 1 day \(1\)</);
        // Control: only fresh questions (and an old APPROVAL, which is not dismissable) — no such button.
        expect(render([...itemsOf([fresh]), approval], { onDismissOlder: () => {} })).not.toContain('deck-dismiss-older');
    });
});

describe('the names reach the Deck from the rail’s namer', () => {
    const pty: PtyPort = {
        open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-deck-readable-'));
        const ws = join(dir, 'tynn-folder');
        await mkdir(ws, { recursive: true });
        await writeFile(join(ws, 'project.json'), JSON.stringify({ name: 'Tynn.ai' }));
        services = await composeServices({
            userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0,
            workspaces: () => [{ id: WS_ID, path: ws }],
            // main.ts passes its rail namer (workspaceNameFor: project.json's name, else the folder); this is the same rule.
            workspaceName: (path) => workspaceDisplayName(readFileSync(join(path, 'project.json'), 'utf8'), path),
        });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    it('a question asked in a workspace carries that workspace’s NAME — the envelope’s, not the folder’s, not the id', async () => {
        const asked = await services.attention.ask({ agentId: mintAgentId(), agentName: 'kai', workspaceId: WS_ID, questions: [{ header: 'Engine', question: MARKDOWN, options: [{ label: 'a' }, { label: 'b' }] }] }, { userActive: true });
        const item = services.deckItems().find((i) => i.id === asked.questionId)!;
        expect(item.workspaceName).toBe('Tynn.ai');
        expect(item.title).toBe('Engine');
    });
});
