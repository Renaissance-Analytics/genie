import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { AUTONOMY_PERSON_ONLY, AUTONOMY_UNTRUSTED, permissionDecisionFor } from '../src/core/agent-ops.js';
import { agentRecord, mintAgentId, type AgentPermissions, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { DriverEvents, PermissionRequestLike } from '../src/core/session.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { ApprovalCardView } from '../src/renderer/components/ApprovalCard.js';

/**
 * AN AUTONOMOUS AGENT IS NOT ASKED (Tynn #439; the owner, 2026-11-04: "why is it that I have an agent with autonomous
 * turned on but it's still prompting me to approve an execution").
 *
 * The cause, in the code: the Autonomous switch (`autoApprove`, Tynn #801) reached Genie's own approval queue and a
 * Codex agent's LAUNCH options, and nothing else. A Claude agent's shell commands were answered from its tool setting
 * alone (`permissionDecisionFor`), so "ask before shell commands" + Autonomous still asked for every command. A Codex
 * agent switched to Autonomous while running kept the approval policy it was launched with, and every request Codex
 * raised reached the person. Now autonomy answers both at the moment they ask; where it does not apply — a workspace that
 * is not trusted, an action that always asks — the prompt says so in words.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };

const shellAsk: PermissionRequestLike = {
    toolCall: { title: 'npm run build', name: 'Bash', rawInput: { command: 'npm run build' } },
    options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
};

const agent = (provider: 'claude' | 'codex', extra: { permissions?: AgentPermissions; autoApprove?: boolean } = {}): AgentRecord =>
    ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider, name: provider === 'claude' ? 'moic' : 'cx' }), ...extra });

function rig(start: AgentRecord, untrusted = false) {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-autonomy-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const state = { current: start, untrusted: false };
    const driverFor: DriverFor = () => (options) => { events = options.events; return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } }; };
    const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree, currentRecord: (id) => (id === state.current.id ? state.current : null), untrustedNow: () => state.untrusted });
    expect(host.start(start, dir)).toEqual({ ok: true });
    // Launched trusted; the verdict is read again at each ask.
    state.untrusted = untrusted;
    return { host, state, ask: () => events.onRequestPermission!(shellAsk), parked: () => host.probe(state.current.id)?.pendingApproval ?? null };
}

describe('Claude: Autonomous answers its shell commands, whatever its tool setting', () => {
    it('RED before #439: "ask before shell commands" + Autonomous → allowed at once, nobody asked', async () => {
        const t = rig(agent('claude', { permissions: 'ask', autoApprove: true }));
        try {
            expect(await t.ask()).toEqual({ outcome: 'selected', optionId: 'allow_once' });
            expect(t.parked()).toBeNull();
        } finally { t.host.stopAll(); }
    });

    it('switched on while it runs: the next command is not asked', async () => {
        const t = rig(agent('claude', { permissions: 'ask' }));
        try {
            const first = t.ask();
            expect(t.parked()).toMatchObject({ question: 'npm run build' });
            t.host.settleParked(t.state.current.id, 'allow');
            await first;
            t.state.current = { ...t.state.current, autoApprove: true };
            expect(await t.ask()).toEqual({ outcome: 'selected', optionId: 'allow_once' });
            expect(t.parked()).toBeNull();
        } finally { t.host.stopAll(); }
    });

    it('CONTROL: not autonomous, "ask" still asks, and the card has no reason to give', async () => {
        const t = rig(agent('claude', { permissions: 'ask' }));
        try {
            void t.ask();
            const parked = t.parked();
            expect(parked).toMatchObject({ question: 'npm run build' });
            expect(parked?.why ?? null).toBeNull();
        } finally { t.host.stopAll(); }
    });

    it('edits only stays a refusal: Autonomous is about not being ASKED, and edits only never asks', async () => {
        const t = rig(agent('claude', { permissions: 'edits', autoApprove: true }));
        try {
            expect(await t.ask()).toEqual({ outcome: 'selected', optionId: 'reject_once' });
        } finally { t.host.stopAll(); }
    });

    it('a workspace that is not trusted still asks, and the card says WHY in words', async () => {
        const t = rig(agent('claude', { permissions: 'all', autoApprove: true }), true);
        try {
            void t.ask();
            expect(t.parked()).toMatchObject({ question: 'npm run build', why: AUTONOMY_UNTRUSTED });
        } finally { t.host.stopAll(); }
    });
});

describe('Codex: Autonomous answers what Codex asks, even when switched on after it launched', () => {
    it('RED before #439: launched not autonomous, switched on → the next request is allowed at once', async () => {
        const t = rig(agent('codex'));
        try {
            t.state.current = { ...t.state.current, autoApprove: true };
            expect(await t.ask()).toEqual({ outcome: 'selected', optionId: 'allow_once' });
            expect(t.parked()).toBeNull();
        } finally { t.host.stopAll(); }
    });

    it('CONTROL: not autonomous → the request reaches the person, with no reason to give', async () => {
        const t = rig(agent('codex'));
        try {
            void t.ask();
            expect(t.parked()).toMatchObject({ question: 'npm run build' });
            expect(t.parked()?.why ?? null).toBeNull();
        } finally { t.host.stopAll(); }
    });

    it('autonomous in a workspace that is not trusted → asked, and the card says why', async () => {
        const t = rig(agent('codex', { autoApprove: true }), true);
        try {
            void t.ask();
            expect(t.parked()).toMatchObject({ why: AUTONOMY_UNTRUSTED });
        } finally { t.host.stopAll(); }
    });
});

describe('the decision, as a table', () => {
    it('autonomous allows ask and all; edits stays deny; untrusted asks', () => {
        expect(permissionDecisionFor('ask', { autonomous: true })).toBe('allow');
        expect(permissionDecisionFor('all', { autonomous: true })).toBe('allow');
        expect(permissionDecisionFor(undefined, { autonomous: true })).toBe('allow');
        expect(permissionDecisionFor('edits', { autonomous: true })).toBe('deny');
        expect(permissionDecisionFor('all', { autonomous: true, untrusted: true })).toBe('ask');
        // Unchanged without autonomy.
        expect(permissionDecisionFor('ask')).toBe('ask');
        expect(permissionDecisionFor('all')).toBe('allow');
        expect(permissionDecisionFor('edits')).toBe('deny');
    });
});

describe("Genie's own approvals: an action autonomy never covers says so", () => {
    const atlas: Caller = { agentId: 'agent_' + 'a'.repeat(32) as Caller['agentId'], agentName: 'atlas', workspaceId: 'tynn', workspacePath: '/w/tynn' };

    it('an autonomous agent creating an agent is asked, and the Deck item says why', () => {
        const q = new ApprovalQueue({ autoApproved: () => true });
        void q.gate(atlas, 'agents.create', 'reviewer');
        expect(q.deckItems()).toHaveLength(1);
        expect(q.deckItems()[0]!.why).toBe(AUTONOMY_PERSON_ONLY);
    });

    it('CONTROL: an agent that is not autonomous is asked with no reason added', () => {
        const q = new ApprovalQueue({ autoApproved: () => false });
        void q.gate(atlas, 'agents.create', 'reviewer');
        expect(q.deckItems()[0]!.why).toBeUndefined();
    });
});

describe('the card shows the reason', () => {
    const base = { question: 'npm run build', options: [{ id: 'allow_once', label: 'Allow once', tone: 'ok' as const }] };
    const card = (why?: string) => renderToStaticMarkup(<ApprovalCardView approval={{ ...base, ...(why ? { why } : {}) }} answering={null} onAnswer={() => {}} note="" onNote={() => {}} />);

    it('a reason is drawn on the card, in words', () => {
        const html = card(AUTONOMY_UNTRUSTED);
        expect(html).toContain('data-approval-why');
        expect(html).toContain('this workspace isn’t trusted');
    });

    it('CONTROL: no reason, nothing drawn', () => {
        expect(card()).not.toContain('data-approval-why');
    });
});
