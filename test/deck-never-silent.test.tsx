import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question } from '../src/core/attention.js';
import type { DeckItem, SignalState } from '../src/core/deck.js';
import { deckRefusalLine } from '../src/core/deck-refusal.js';
import { mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { answerDeck } from '../src/main/deck-answer.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import type { ComposedServices } from '../src/main/compose.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { Deck } from '../src/renderer/components/Deck.js';
import { composeServices } from './helpers/compose-alone.js';

/**
 * A DECK ACTION IS NEVER A SILENT NO-OP (Tynn #600). The owner dismissed and answered two stale questions and they stayed:
 * nothing of theirs ever reached the store, and nothing said why. Every Deck action that is refused says so to the person,
 * on that item, and in the lifecycle log; an answer to a copy of a question its agent has since changed is refused, and
 * the current question is what the Deck then shows.
 */
const QUIET = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false } as SignalState;
const questions = [{ header: 'Harness rel', question: 'Release both?', options: [{ label: 'Release' }, { label: 'Hold' }] }];
const item = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: 'q_dd6bedde-0000', source: 'agent-question', agentId: 'a1', agentName: 'prism', workspaceId: 'ws', title: 'Harness rel', blocking: true,
    priority: 'normal', at: 1, answer: { kind: 'form', fields: 1, questions }, forwardedFrom: null, ...over,
} as DeckItem);

describe('an answer to an out-of-date copy', () => {
    const ports = (current: { id: string; revision?: number } | null) => {
        const answer = vi.fn(async () => {});
        return { answer, ports: { attention: { answer, lists: { done: async () => true }, pending: () => (current ? [current] : []) }, approvals: { resolve: () => true }, inbox: { unread: () => [], receive: async () => [] } } as never };
    };

    it('is refused, naming the change, and nothing is answered', async () => {
        const { answer, ports: p } = ports({ id: 'q_dd6bedde-0000', revision: 3 });
        await expect(answerDeck({ kind: 'deck.answerForm', item: item({ revision: 1 }), selections: [['Release']], notes: [''], note: '' }, p)).rejects.toThrow(/changed since/);
        expect(answer).not.toHaveBeenCalled();
    });

    it('a question no longer waiting is refused in words', async () => {
        const { answer, ports: p } = ports(null);
        await expect(answerDeck({ kind: 'deck.answerForm', item: item(), selections: [['Release']], notes: [''], note: '' }, p)).rejects.toThrow(/no longer waiting/);
        expect(answer).not.toHaveBeenCalled();
    });

    it('CONTROL: the current copy is answered', async () => {
        const { answer, ports: p } = ports({ id: 'q_dd6bedde-0000', revision: 3 });
        await answerDeck({ kind: 'deck.answerForm', item: item({ revision: 3 }), selections: [['Release']], notes: [''], note: '' }, p);
        expect(answer).toHaveBeenCalledOnce();
    });
});

describe('the lifecycle line', () => {
    it('names the action, the item and the reason, on one line', () => {
        expect(deckRefusalLine({ kind: 'deck.dismiss', item: item() } as never, new Error('no pending question q_dd6bedde-0000\nsecond line')))
            .toBe('deck action refused kind=deck.dismiss item=q_dd6bedde-0000 reason=no pending question q_dd6bedde-0000 second line');
        expect(deckRefusalLine({ kind: 'deck.dismissStale', ids: ['q_a', 'q_b'] } as never, new Error('none')))
            .toBe('deck action refused kind=deck.dismissStale item=q_a,q_b reason=none');
    });

    it('main writes it for every refused Deck action, and still refuses', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/catch \(error\) \{\s*if \(action\.kind\.startsWith\('deck\.'\)\) lifecycleLog\(deckRefusalLine\(action, error\)\);\s*throw error;/);
    });
});

describe('the person sees the reason on that item', () => {
    it('a stale row, its form folded, shows the refusal under it', () => {
        const html = renderToStaticMarkup(<Deck items={[item({ stale: 'session-ended' } as never)]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} onDismiss={() => {}} formRefusal={{ itemId: 'q_dd6bedde-0000', reason: 'This question is no longer waiting.' }} />);
        expect(html).toMatch(/data-deck-refusal="q_dd6bedde-0000"[^>]*>[^<]*This question is no longer waiting\./);
    });

    it('CONTROL: another item’s refusal is not drawn here', () => {
        const html = renderToStaticMarkup(<Deck items={[item({ stale: 'session-ended' } as never)]} signals={QUIET} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onAnswerForm={() => {}} onDismiss={() => {}} formRefusal={{ itemId: 'q_other', reason: 'nope' }} />);
        expect(html).not.toContain('data-deck-refusal');
    });

    it('the window keeps every Deck refusal for its item: dismiss, dismiss all and the one-click answer included', () => {
        const shell = readFileSync('src/renderer/Shell.tsx', 'utf8');
        expect(shell).toMatch(/onDismiss=\{\(item, notes\) => deckAct\(item\.id, \{ kind: 'deck\.dismiss', item, notes \}\)\}/);
        expect(shell).toMatch(/onDismissStale=\{\(ids\) => deckAct\('deck:stale', \{ kind: 'deck\.dismissStale', ids \}\)\}/);
        expect(shell).toMatch(/onDismissOlder=\{\(olderThanMs\) => deckAct\('deck:older', \{ kind: 'deck\.dismissOlder', olderThanMs \}\)\}/);
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).toMatch(/console\.error\('\[genie\] deck answer refused:', reason\);\s*setDeckFormRefusal\(\{ itemId: item\.id, reason \}\);/);
    });
});

const pty: PtyPort = {
    open: (o) => ({ id: 'term_x', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const STATE = { toolStatuses: null, knowledgeQuery: '' };
const q = (header: string): Question[] => [{ header, question: `About ${header}?`, options: [{ label: 'a' }, { label: 'b' }] }];

describe('"Dismiss all stale" that finds nothing to dismiss', () => {
    let dir: string;
    let services: ComposedServices;
    let roster: AgentRecord[];
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-deck-silent-'));
        roster = [];
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, roster: () => roster, askerLive: () => undefined });
    });
    afterEach(async () => { await services.shutdown(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

    it('is refused in words, and nothing leaves', async () => {
        const asked = await services.attention.ask({ agentId: mintAgentId(), agentName: 'ghost', workspaceId: 'ws', questions: q('Gone') }, { userActive: true });
        await expect(handleFeatureAction(services, { kind: 'deck.dismissStale', ids: [asked.questionId] }, STATE)).rejects.toThrow(/nothing was dismissed/);
        expect(services.attention.pending()).toHaveLength(1);
    });
});
