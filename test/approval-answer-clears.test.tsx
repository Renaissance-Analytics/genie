import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Approval } from '../src/core/approval.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { LiveSession } from '../src/core/roster.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { EMPTY_SNAPSHOT } from '../src/renderer/bridge.js';
import { ApprovalCardView } from '../src/renderer/components/ApprovalCard.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * AN ANSWER IN FLIGHT IS PER APPROVAL, AND IT ENDS (the owner, 2026-10-22, blocked: "I have agents trying to do work and
 * ask for approval from me but I can't approve anything because the UI is disabled").
 *
 * The desktop window kept ONE `answering: string | null`, set on every answer path and cleared by nothing — its own
 * comment said "cleared when the agent's detail changes", and no code did that. So the FIRST approval answered in a
 * window disabled the buttons of every approval after it, for the life of the window (since at least beta.30): a
 * Codex card reading "Allow once / Allow and remember / Reject", all grey, "turn parked · waiting on you", and the
 * ledger closing it as `cancelled` — never answered. The host's own refusal (`{ ok: false }`: nothing parked, an
 * option it did not offer, the agent not running) was thrown away too, so a refused press looked identical.
 *
 * Now: the answer in flight names the agent AND the approval it answers (`core/approval-answering.ts`); the card of
 * any OTHER approval is live; the host's reply ends the flight, and a refusal is said on the card in words (the
 * owner, 2026-10-14: "I click the answer button but nothing happens" — a refusal that only reached the console was
 * nothing happening). The module is imported lazily so that on origin/main the tests of the surfaces still run and
 * fail on their assertions, not on a missing file.
 */
const answering = () => import('../src/core/approval-answering.js');

const first: Approval = { question: 'pwsh -Command "git -C .ai/sandbox/g-agent-ops fetch origin"', tool: 'shell', toolCallId: 'call_1', options: [{ id: 'allow', label: 'Allow once', tone: 'ok' }, { id: 'deny', label: 'Reject', tone: 'bad' }] };
const second: Approval = { question: 'pwsh -Command "git -C .ai/sandbox/g-agent-ops push origin"', tool: 'shell', toolCallId: 'call_2', options: [{ id: 'allow', label: 'Allow once', tone: 'ok' }, { id: 'deny', label: 'Reject', tone: 'bad' }] };

describe('the answer in flight (core/approval-answering.ts)', () => {
    it('is in flight for the approval it answers, and for no other', async () => {
        const { answeringFor, approvalKey } = await answering();
        const inFlight = { agentId: 'a_lark', key: approvalKey(first), optionId: 'allow' };
        expect(answeringFor(inFlight, 'a_lark', first)).toBe('allow');
        // The next approval of the SAME agent is live — this is the bug.
        expect(answeringFor(inFlight, 'a_lark', second)).toBeNull();
        // Another agent's approval never was this one's.
        expect(answeringFor(inFlight, 'a_wren', first)).toBeNull();
        expect(answeringFor(null, 'a_lark', first)).toBeNull();
    });

    it('with no approval to compare (a Deck row), the agent alone is the identity — a session parks one at a time', async () => {
        const { answeringFor, approvalKey } = await answering();
        const inFlight = { agentId: 'a_lark', key: approvalKey(first), optionId: 'allow' };
        expect(answeringFor(inFlight, 'a_lark', null)).toBe('allow');
        expect(answeringFor(inFlight, 'a_wren', null)).toBeNull();
    });

    it('identity is the provider’s tool-call id when it gave one, else the question, tool and command', async () => {
        const { approvalKey } = await answering();
        expect(approvalKey(first)).not.toBe(approvalKey(second));
        expect(approvalKey({ ...first, toolCallId: null })).not.toBe(approvalKey({ ...second, toolCallId: null }));
        expect(approvalKey({ ...first, toolCallId: null })).toBe(approvalKey({ question: first.question, tool: 'shell' }));
        // The same call asked again is the same identity; the flight ends on the host's reply, not on this.
        expect(approvalKey(first)).toBe(approvalKey({ ...first, options: [] } as Approval));
    });

    it('a refusal is said in words, for the approval it refused', async () => {
        const { refusalFor, refusalWords, approvalKey } = await answering();
        expect(refusalWords({ ok: false, reason: 'this agent is not running' })).toBe('Not answered: this agent is not running');
        // A host that gave no reason still gets a sentence, never an empty line.
        expect(refusalWords({ ok: false })).toMatch(/^Not answered: /);
        const refusal = { agentId: 'a_lark', key: approvalKey(first), reason: 'Not answered: this agent is not running' };
        expect(refusalFor(refusal, 'a_lark', first)).toBe('Not answered: this agent is not running');
        expect(refusalFor(refusal, 'a_lark', second)).toBeNull();
        expect(refusalFor(null, 'a_lark', first)).toBeNull();
    });
});

describe('the card', () => {
    it('says the host’s refusal beside its buttons, which are live again', () => {
        const html = renderToStaticMarkup(<ApprovalCardView approval={first} answering={null} refusal="Not answered: this agent is not running" onAnswer={() => {}} note="" onNote={() => {}} />);
        expect(html).toContain('data-approval-refusal');
        expect(html).toContain('Not answered: this agent is not running');
        // The attribute, not the class (`disabled:opacity-50` is on every button).
        expect(html.match(/<button[^>]*data-approval-option="allow"[^>]*>/)?.[0]).not.toContain('disabled=""');
    });
});

describe('the window', () => {
    const row: AgentRow = {
        id: 'a_lark', name: 'lark', provider: 'codex', workspaceId: 'ws_example', fidelity: 'declared', state: 'working', duration: '3m',
        ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null,
        contextUsed: null, contextSize: null,
    } as AgentRow;
    const session = (pendingApproval: Approval | null): LiveSession =>
        ({ running: true, turnState: 'parked', startedAt: 1, pendingApproval, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null }) as unknown as LiveSession;
    const render = (pending: Approval, inFlight: unknown, refusal: unknown = null) => renderToStaticMarkup(
        <Shell
            route="genie://dashboard?chat=a_lark"
            snapshot={{ ...EMPTY_SNAPSHOT, agents: [row], workspaces: [{ id: 'ws_example', path: '/srv/example.test', agentsKnown: true }] }}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={null}
            agentResolved={false}
            selectedRowId={null}
            chatThread={{ agentId: 'a_lark', name: 'lark', fidelity: 'declared', unread: null, messages: [] }}
            chatSession={session(pending)}
            pinned={null}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onCloseChat={() => {}}
            answeringApproval={inFlight as never}
            approvalRefusal={refusal as never}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
        />,
    );
    const optionDisabled = (html: string, id: string): boolean => /disabled=""/.test(html.match(new RegExp(`<button[^>]*data-approval-option="${id}"[^>]*>`))?.[0] ?? '');

    it('answered approval #1, shown approval #2: the buttons are LIVE (they were disabled for the life of the window)', async () => {
        const { approvalKey } = await answering();
        const inFlight = { agentId: 'a_lark', key: approvalKey(first), optionId: 'allow' };
        const html = render(second, inFlight);
        expect(html).toContain('data-approval-option="allow"');
        expect(optionDisabled(html, 'allow')).toBe(false);
        expect(optionDisabled(html, 'deny')).toBe(false);
    });

    it('POSITIVE CONTROL: while approval #1’s own answer is in flight, its buttons refuse a second press', async () => {
        const { approvalKey } = await answering();
        const inFlight = { agentId: 'a_lark', key: approvalKey(first), optionId: 'allow' };
        const html = render(first, inFlight);
        expect(optionDisabled(html, 'allow')).toBe(true);
        expect(optionDisabled(html, 'deny')).toBe(true);
    });

    it('the host’s refusal reaches the card of the approval it refused', async () => {
        const { approvalKey } = await answering();
        const refusal = { agentId: 'a_lark', key: approvalKey(first), reason: 'Not answered: this agent is not running' };
        expect(render(first, null, refusal)).toContain('Not answered: this agent is not running');
        expect(render(second, null, refusal)).not.toContain('Not answered');
    });

    it('every answer path ends its flight on the host’s reply; none sets a bare option id', () => {
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        // The bug, verbatim: four sites set it, none cleared it.
        expect(app).not.toContain('setAnswering(optionId)');
        // The one path every surface takes: begin, send, settle on the reply (ok clears; a refusal is said on the card).
        expect(app).toContain('refusalWords(');
        expect(app.match(/\.answerApproval\(/g)?.length ?? 0).toBeGreaterThan(0);
        // The reply is read. A fire-and-forget bridge call cannot be: it returns nothing.
        const bridge = readFileSync('src/renderer/bridge.ts', 'utf8');
        expect(bridge).toMatch(/answerApproval\(agentId: string, optionId: string, note\?: string\): Promise</);
        const preload = readFileSync('src/main/preload.ts', 'utf8');
        expect(preload).not.toContain("void ipcRenderer.invoke('genie:answer-approval'");
        const remote = readFileSync('src/renderer/remote-bridge.ts', 'utf8');
        expect(remote).not.toContain("fire('answerApproval'");
        // The surfaces derive their own card's flight from the agent + approval, never a window-wide string.
        const shell = readFileSync('src/renderer/Shell.tsx', 'utf8');
        expect(shell).toContain('answeringFor(');
        expect(shell).toContain('refusalFor(');
    });
});

describe('the host', () => {
    let dir: string;
    let host: SessionHost;
    let events: DriverEvents = {};
    const driverFor: DriverFor = (record) => {
        if (record.provider !== 'codex' && record.provider !== 'claude') return null;
        const factory: SessionDriverFactory = (options) => {
            events = options.events;
            return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } };
        };
        return factory;
    };
    const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
    const record = (): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'prism-slave' });
    const ask = { toolCall: { title: 'git fetch origin' }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Reject', kind: 'reject_once' }] };

    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-answer-')); host = new SessionHost({ userData: dir, driverFor, clock: () => 1_760_000_000_000, processTree: noProcessTree }); });
    /*
     * The answer appends an `approval` ledger row, fire-and-forget (the session's `#writes`); `stopAll()` stops the
     * PROVIDER and does not await it. Removing the directory while that append is in flight is ENOTEMPTY (the established
     * host tests say the same), and under the full suite's load it happened once here: so the writes are awaited
     * (`settled()`), and the removal retries as session-host.test.ts's does.
     */
    afterEach(async () => { host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

    it('says WHY an answer was not taken: not running, nothing parked, an option it never offered — and takes a real one', async () => {
        const r = record();
        expect(host.answerApproval(r.id, 'allow')).toEqual({ ok: false, reason: 'this agent is not running' });
        host.start(r, dir);
        expect(host.answerApproval(r.id, 'allow')).toEqual({ ok: false, reason: 'nothing is waiting for an answer — it was already answered, or the turn ended' });
        const pending = events.onRequestPermission?.(ask);
        expect(host.answerApproval(r.id, 'rm -rf /')).toEqual({ ok: false, reason: '“rm -rf /” is not one of the options this request offered' });
        // POSITIVE CONTROL: the refusals are readings, not a dead path.
        expect(host.answerApproval(r.id, 'allow')).toEqual({ ok: true });
        expect(await pending).toEqual({ outcome: 'selected', optionId: 'allow' });
    });
});
