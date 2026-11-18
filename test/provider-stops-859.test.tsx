import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { chatContext } from '../src/core/chat-view.js';
import { mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { KNOWN_PROVIDER_STOPS, explainProviderStop, providerStopNote } from '../src/core/provider-stops.js';
import type { LiveSession } from '../src/core/roster.js';
import { AgentSession, type DriverEvents, type SessionDriverFactory } from '../src/core/session.js';
import { openAgentThread, openDurableStore } from '../src/core/thread-store.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * PROVIDER STOPS ARE EXPLAINED (Tynn #859; the owner, 2026-11-18). A Codex agent kept being stopped by its provider:
 * the chat showed only a red `cyberPolicy`, and the agent said "I can't see the reason for that interruption", carried
 * on, and repeated the same thing. Neither the person nor the agent learned what happened.
 *
 * Now every stop code Genie can receive (Codex's `codexErrorInfo`, Claude Code's assistant `error`, ACP's `refusal` /
 * `max_tokens` / `max_turn_requests`) maps to what it means and what to do, from the provider's own docs; a code with
 * no documented meaning says so, and an unknown one shows the raw code plus "the provider gave no more detail". The red
 * stop line shows that sentence; the agent's NEXT turn starts with one short line naming the stop; and repeated stops
 * for the same reason are counted and shown.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noTree: ProcessTree = { snapshot: () => [], killTree: (p) => ({ killed: p.length, refused: false }) };

function open() {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-stops-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const prompts: string[] = [];
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return {
            start: () => {},
            prompt: (t: string | readonly { type: string; text?: string }[]) => { prompts.push(typeof t === 'string' ? t : t.map((b) => b.text ?? '').join('')); },
            kill: () => {}, get running() { return true; }, get cliSessionId() { return null; },
        };
    };
    const store = openDurableStore(dir);
    const id = mintAgentId();
    const session = new AgentSession({ agentId: id, cwd: dir, store, driverFactory: factory, processTree: noTree });
    session.start();
    const fail = (reason: string, kind = 'other') => events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'failed', failure: { kind, reason } } as never);
    const end = (stopReason: string) => events.onTurnEnd?.({ stopReason, isError: false, raw: stopReason } as never);
    const notices = async () => {
        await session.settled();
        return (await openAgentThread(store, id).messages()).map((r) => r.message as { kind: string; level?: string; message?: string }).filter((m) => m.kind === 'notice');
    };
    return { session, prompts, fail, end, notices };
}

describe('the stop codes, in words', () => {
    it('cyberPolicy says it is OpenAI\'s cybersecurity policy, and what the agent should do instead', () => {
        const stop = explainProviderStop('cyberPolicy');
        expect(stop.code).toBe('cyberPolicy');
        expect(stop.documented).toBe(true);
        expect(stop.meaning).toMatch(/OpenAI/);
        expect(stop.meaning).toMatch(/cybersecurity/i);
        expect(stop.todo.length).toBeGreaterThan(20);
        expect(stop.words).toContain(stop.meaning);
        expect(stop.words).toContain(stop.todo);
    });

    it('an unknown code shows the raw code plus "the provider gave no more detail"', () => {
        const stop = explainProviderStop('quantumFlux');
        expect(stop.documented).toBe(false);
        expect(stop.words).toContain('quantumFlux');
        expect(stop.words).toContain('the provider gave no more detail');
        // Never an own-property surprise: a code named like an Object member is still unknown (prism-acp G-96).
        expect(explainProviderStop('constructor').documented).toBe(false);
        expect(explainProviderStop('toString').words).toContain('the provider gave no more detail');
    });

    it('every code prism-acp sorts (Codex and Claude) and every ACP stop is in the table, with a meaning and a what-to-do', () => {
        // prism-acp 0.42.0 src/turn-failure.ts CODEX_KINDS / CLAUDE_KINDS, and src/claude/driver.ts StopReason.
        const codex = ['usageLimitExceeded', 'rateLimitExceeded', 'serverOverloaded', 'unauthorized', 'cyberPolicy', 'contextWindowExceeded'];
        const claude = ['rate_limit', 'overloaded', 'authentication_failed', 'oauth_org_not_allowed', 'cloud_credential_error', 'billing_error', 'account_on_hold', 'verification_required'];
        const acp = ['refusal', 'max_tokens', 'max_turn_requests'];
        for (const code of [...codex, ...claude, ...acp]) {
            expect(Object.hasOwn(KNOWN_PROVIDER_STOPS, code), code).toBe(true);
            const stop = explainProviderStop(code);
            expect(stop.meaning.length, code).toBeGreaterThan(10);
            expect(stop.todo.length, code).toBeGreaterThan(10);
            expect(stop.words, code).not.toContain('the provider gave no more detail');
        }
        // A code whose meaning the provider never documented says so, rather than a guess.
        for (const [code, entry] of Object.entries(KNOWN_PROVIDER_STOPS)) {
            if (!entry.documented) expect(explainProviderStop(code).words, code).toMatch(/not documented/i);
        }
    });

    it('the provider\'s own message, when one is given, is quoted', () => {
        const stop = explainProviderStop('cyberPolicy', 'This request was flagged for potentially high-risk cyber activity.');
        expect(stop.words).toContain('"This request was flagged for potentially high-risk cyber activity."');
    });

    it('the note for the agent is ONE short line naming the stop and its meaning, with the count from the second time', () => {
        const once = providerStopNote(explainProviderStop('cyberPolicy'), 1);
        expect(once.split('\n')).toHaveLength(1);
        expect(once).toContain('cyberPolicy');
        expect(once.length).toBeLessThan(400);
        expect(providerStopNote(explainProviderStop('cyberPolicy'), 3)).toMatch(/3 times/);
    });
});

describe('a turn the provider stops', () => {
    it('the agent\'s NEXT turn starts with a line naming the stop; the turn after that does not', () => {
        const { session, prompts, fail, end } = open();
        session.prompt('scan the ports', 'you');
        fail('cyberPolicy');
        session.prompt('go on', 'you');
        // Not vacuous (the RED run caught `startsWith('')` passing against an empty note): the note is there, and named.
        const note = providerStopNote(explainProviderStop('cyberPolicy'), 1);
        expect(note).toContain('cyberPolicy');
        expect(prompts[1]).not.toBe('go on');
        expect(prompts[1]!.startsWith(note)).toBe(true);
        expect(prompts[1]!.endsWith('go on')).toBe(true);
        end('end_turn');
        session.prompt('next thing', 'you');
        expect(prompts[2]).toBe('next thing');
    });

    it('repeated stops for the same reason are counted, shown on the session, and told to the agent', () => {
        const { session, prompts, fail } = open();
        session.prompt('a', 'you');
        fail('cyberPolicy');
        expect(session.providerStop).toMatchObject({ code: 'cyberPolicy', count: 1 });
        session.prompt('b', 'you');
        fail('cyberPolicy');
        expect(session.providerStop).toMatchObject({ code: 'cyberPolicy', count: 2 });
        expect(session.providerStop!.words).toMatch(/cybersecurity/i);
        session.prompt('c', 'you');
        expect(prompts[2]).toContain(providerStopNote(explainProviderStop('cyberPolicy'), 2));
        // Another reason has its own count.
        fail('contextWindowExceeded');
        expect(session.providerStop).toMatchObject({ code: 'contextWindowExceeded', count: 1 });
    });

    it('a Claude refusal (stop_reason refusal, no error) is no longer a silent finish: it says so in the chat and tells the agent', async () => {
        const { session, prompts, end, notices } = open();
        session.prompt('write it', 'you');
        end('refusal');
        const said = (await notices()).filter((n) => n.message?.includes(explainProviderStop('refusal').meaning));
        expect(said).toHaveLength(1);
        expect(session.providerStop).toMatchObject({ code: 'refusal', count: 1 });
        session.prompt('try again', 'you');
        expect(prompts[1]!.startsWith(providerStopNote(explainProviderStop('refusal'), 1))).toBe(true);
    });

    it('control: a turn that ends cleanly, or one the person stopped, carries no note and shows no stop', () => {
        const { session, prompts, end } = open();
        session.prompt('a', 'you');
        end('end_turn');
        session.prompt('b', 'you');
        end('cancelled');
        session.prompt('c', 'you');
        expect(prompts).toEqual(['a', 'b', 'c']);
        expect(session.providerStop).toBeNull();
    });
});

describe('the red stop line', () => {
    const broken = (stop: LiveSession['providerStop']): LiveSession => ({
        failure: { reason: 'cyberPolicy', fixes: ['Restart'] }, providerStop: stop, pendingApproval: null, limit: null, running: true, turnState: 'failed',
    } as unknown as LiveSession);
    const agent = { id: 'a1', name: 'lark', provider: 'codex', fidelity: 'declared' as const };

    it('shows the sentence and the count, not the bare code', () => {
        const stop = explainProviderStop('cyberPolicy');
        const context = chatContext({ agent, session: broken({ code: 'cyberPolicy', words: stop.words, count: 3 }), rows: [] });
        expect(context.stop).toEqual({ code: 'cyberPolicy', words: stop.words, count: 3 });
        const thread: ChatThread = { agentId: 'a1', name: 'lark', fidelity: 'declared', unread: null, context, messages: [] };
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} />);
        const line = html.slice(html.indexOf('data-chat-error'));
        expect(line).toContain('cybersecurity');
        expect(line).toMatch(/data-chat-stop-count[^>]*>[^<]*3/);
    });

    it('control: a failure that is not a provider stop keeps its own words and shows no count', () => {
        const context = chatContext({ agent, session: broken(null), rows: [] });
        expect(context.stop).toBeUndefined();
        const thread: ChatThread = { agentId: 'a1', name: 'lark', fidelity: 'declared', unread: null, context, messages: [] };
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} />);
        expect(html).toContain('data-chat-error');
        expect(html).not.toContain('data-chat-stop-count');
    });
});
