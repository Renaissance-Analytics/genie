import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { refusalWords } from '../src/core/approval-words.js';
import { resolveDeckAnswer } from '../src/core/deck-resolve.js';
import { Baton, PairingPins } from '../src/core/remote.js';
import { REMOTE_METHODS, capabilityOf, type RemoteMethod, type ServerTransport } from '../src/core/remote-protocol.js';
import { APPROVAL_SWEEP_MS, APPROVAL_TIMEOUT_MS, ApprovalQueue } from '../src/main/approval-queue.js';
import { APPROVAL_CALL_DEADLINE_MS, readGateRequest, windowApprovals } from '../src/main/approvals-gate-protocol.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { HOST_ALONE_METHODS } from '../src/main/host-alone-api.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { ownProtocolClient, type OwnCallAnswer } from '../src/main/own-protocol-client.js';
import { DeviceStore } from '../src/main/remote-devices.js';
import { RemoteHost, type HostApi } from '../src/main/remote-host.js';
import { allowEveryPairing } from './support/allow-every-pairing.js';

/*
 * CLIENT/HOST SPLIT STEP 2g-4b2 (Tynn #1006; part of #955). The few tools the window runs for an agent (createAgent,
 * workspaceTabs, pages) ask the person through genie-host's one approval queue over the one protocol: a local
 * `approvals.gate` only main's own client may call, with a deadline from the approval's own expiry. That expiry was never
 * enforced (genie-host never swept the queue): it is now, every minute, and an approval nobody answered in 30 minutes is
 * EXPIRED, not denied: the Deck says "expired, no answer in 30 min", and the agent's tool says nobody answered, in plain
 * words (the coordinator, 2026-11-22). main reads none of the agentStores any more; the input goes with compose in 2g-4d.
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const src = (path: string) => readFileSync(resolve(root, path), 'utf8');
const code = (text: string) => text.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const GATE = 'approvals.gate' as RemoteMethod;
const CALLER: Caller = { agentId: 'agent_01ARZ3NDEKTSV4RRFFQ69G5FAV' as never, agentName: 'Builder', workspaceId: 'ws_a', workspacePath: '/work/a' };

describe('the approval expires, and the person and the agent are told', () => {
    it('the queue’s expiry is 30 minutes, swept every minute', () => {
        expect(APPROVAL_TIMEOUT_MS).toBe(30 * 60_000);
        expect(APPROVAL_SWEEP_MS).toBe(60_000);
    });

    it('nobody answered in 30 minutes: the ask ends EXPIRED (not denied), and the Deck says so, dismissable, no longer blocking', async () => {
        let now = 1_000;
        const q = new ApprovalQueue({ now: () => now });
        const asked = q.gate(CALLER, 'agents.create', 'an agent "Docs" in ws_a', undefined);
        // CONTROL: a sweep before the expiry changes nothing.
        now += APPROVAL_TIMEOUT_MS - 1;
        q.sweep();
        expect(q.deckItems().map((i) => i.id)).toEqual([expect.stringMatching(/^appr_/)]);
        now += 2;
        q.sweep();
        expect(await asked).toBe('expired');
        const items = q.deckItems();
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ id: expect.stringMatching(/^apprx_/), blocking: false, agentId: CALLER.agentId });
        expect(items[0]!.title).toMatch(/expired, no answer in 30 min/);
        expect(items[0]!.answer).toEqual({ kind: 'inline', options: [{ id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] });
        // The person dismisses it, once.
        expect(q.dismissExpired(items[0]!.id)).toBe(true);
        expect(q.deckItems()).toEqual([]);
        expect(q.dismissExpired(items[0]!.id)).toBe(false);
    });

    it('CONTROL: an answered ask never expires', async () => {
        let now = 1_000;
        const q = new ApprovalQueue({ now: () => now });
        const asked = q.gate(CALLER, 'agents.create', 'x', undefined);
        q.resolve(q.deckItems()[0]!.id, 'allow');
        now += APPROVAL_TIMEOUT_MS * 2;
        q.sweep();
        expect(await asked).toBe('allowed');
        expect(q.deckItems()).toEqual([]);
    });

    it('the Deck routes an expired item’s Dismiss to the queue, never to Allow or Deny', () => {
        // Each reading of the clock is one expiry later, so the sweep finds the ask expired.
        const aged = new ApprovalQueue({ now: (() => { let t = 0; return () => (t += APPROVAL_TIMEOUT_MS + 1); })() });
        void aged.gate(CALLER, 'agents.create', 'x', undefined);
        aged.sweep();
        const item = aged.deckItems()[0]!;
        expect(resolveDeckAnswer(item, 'dismiss')).toEqual({ kind: 'dismiss-expired-approval', approvalId: item.id });
    });

    it('the agent is told which: the person said no, or nobody answered in time', () => {
        expect(refusalWords('denied', 'adding Postgres 17', 'nothing was pulled or created')).toBe('adding Postgres 17 was denied by the person; nothing was pulled or created');
        expect(refusalWords('expired', 'adding Postgres 17', 'nothing was pulled or created')).toBe('adding Postgres 17 was not approved in time: nobody answered within 30 minutes, so the request expired; nothing was pulled or created');
    });

    it('wired: every gated tool words its refusal through refusalWords, and genie-host sweeps the queue', () => {
        const files = ['mcp-tools-agents', 'mcp-tools-workspace-tabs', 'mcp-tools-flows', 'mcp-tools-hosting', 'mcp-tools-more', 'mcp-tools-playwright', 'mcp-tools-plugins', 'mcp-tools-processes'];
        for (const f of files) {
            const text = code(src(`src/main/${f}.ts`));
            expect(text, f).not.toMatch(/!== 'allowed'\) return err\(['`]/);
            expect(text, f).toMatch(/refusalWords\(/);
        }
        expect(code(src('src/main/genie-host.ts'))).toMatch(/setInterval\(\(\) => \{ approvals\.sweep\(\); \}, APPROVAL_SWEEP_MS\)/);
    });
});

describe('approvals.gate: a local method only main’s own client may call', () => {
    it('is in the protocol table, local, and genie-host’s own', () => {
        expect(REMOTE_METHODS as readonly string[]).toContain(GATE);
        expect(capabilityOf(GATE)).toBe('local');
        expect(HOST_ALONE_METHODS.has(GATE)).toBe(true);
    });

    const request = [CALLER, 'agents.create', 'an agent "Docs"', 'fc_7'];
    const base = { connectionId: 'c1', origin: 'local-window', profile: 'desktop', isOwner: true, workspaceId: null, readonly: false, label: 'Genie’s tray' } as const;

    it('main’s own client is answered by the host’s queue, tied to the agent’s call; a page in the window, or no own tunnel, is refused and the queue never asked', async () => {
        const gate = vi.fn(async () => 'allowed' as const);
        const api = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null, approvalsGate: gate } as unknown as HostApiDeps);
        expect(await api.invoke(GATE, request, { ...base, own: true })).toBe('allowed');
        expect(gate).toHaveBeenCalledWith(CALLER, 'agents.create', 'an agent "Docs"', 'fc_7');
        expect(await api.invoke(GATE, request, base)).toMatchObject({ ok: false });
        expect(gate).toHaveBeenCalledTimes(1);
        // CONTROL: a host with no queue says so.
        const none = buildHostApi({ features: {}, workspaceOps: {}, agentOps: {}, updates: null } as unknown as HostApiDeps);
        expect(await none.invoke(GATE, request, { ...base, own: true })).toMatchObject({ ok: false });
    });

    it('the request is read strictly: a caller of an unknown kind, a missing field or a too-long word is refused, never asked', () => {
        expect(readGateRequest(request)).toEqual({ caller: CALLER, action: 'agents.create', detail: 'an agent "Docs"', forwardedCallId: 'fc_7' });
        expect(readGateRequest([{ ...CALLER, kind: 'flow' }, 'x', 'y', null])).toMatchObject({ caller: { kind: 'flow' }, forwardedCallId: null });
        for (const bad of [
            [{ ...CALLER, kind: 'person' }, 'x', 'y', null],
            [{ ...CALLER, agentId: 7 }, 'x', 'y', null],
            [{ agentName: 'x' }, 'x', 'y', null],
            [CALLER, '', 'y', null],
            [CALLER, 'x'.repeat(300), 'y', null],
            [CALLER, 'x', 'y'.repeat(5_000), null],
            [CALLER, 'x', 'y', 7],
            [],
        ]) expect(readGateRequest(bad as unknown[]), JSON.stringify(bad).slice(0, 80)).toMatchObject({ ok: false });
    });
});

describe('the window’s side: asked with the approval’s own deadline, and anything but an answer is a no', () => {
    function own(answer: OwnCallAnswer) {
        const calls: Array<[string, unknown[], { timeoutMs?: number } | undefined]> = [];
        return { calls, client: { call: async (method: 'approvals.gate', args: unknown[], options?: { timeoutMs?: number }) => { calls.push([method, args, options]); return answer; } } };
    }

    it('the deadline is the queue’s expiry, its sweep, and a minute', () => {
        expect(APPROVAL_CALL_DEADLINE_MS).toBe(APPROVAL_TIMEOUT_MS + APPROVAL_SWEEP_MS + 60_000);
    });

    it('asks genie-host with the agent’s forwarded call and that deadline, and says what it answered', async () => {
        for (const verdict of ['allowed', 'denied', 'expired'] as const) {
            const o = own({ ok: true, value: verdict });
            expect(await windowApprovals(o.client).gate(CALLER, 'agents.create', 'x', { forwardedCallId: 'fc_9' })).toBe(verdict);
            expect(o.calls).toEqual([['approvals.gate', [CALLER, 'agents.create', 'x', 'fc_9'], { timeoutMs: APPROVAL_CALL_DEADLINE_MS }]]);
        }
        const o = own({ ok: true, value: 'allowed' });
        await windowApprovals(o.client).gate(CALLER, 'agents.create', 'x', undefined);
        expect(o.calls[0]![1]).toEqual([CALLER, 'agents.create', 'x', null]);
    });

    it('a refusal, a dropped link, a timeout or an answer that does not read is denied: the queue’s own safe default', async () => {
        for (const answer of [{ ok: false, reason: 'Genie is still starting' }, { ok: true, value: { ok: false, reason: 'no queue' } }, { ok: true, value: 'yes' }, { ok: true, value: null }] as OwnCallAnswer[]) {
            expect(await windowApprovals(own(answer).client).gate(CALLER, 'agents.create', 'x', undefined), JSON.stringify(answer)).toBe('denied');
        }
    });

    it('main’s own client keeps a call open to its own deadline, not the client’s', async () => {
        const home = await mkdtemp(join(tmpdir(), 'genie-2g4b2-'));
        const devices = await DeviceStore.open(home, { now: Date.now, random: () => 'tok' });
        const api = { invoke: vi.fn(async () => { await new Promise((r) => setTimeout(r, 150)); return 'allowed'; }), onEvent: () => () => {}, workspaceOfAgent: () => null } as unknown as HostApi;
        const client = ownProtocolClient({ timeoutMs: 40 });
        new RemoteHost({ api, hostName: 'alphar', baton: new Baton(), devices, pins: new PairingPins({ now: Date.now, random: () => 0.4 }), confirm: allowEveryPairing, transport: client.door as ServerTransport });
        try {
            // CONTROL: the client's own 40 ms deadline ends a call the host answers at 150 ms.
            expect(await client.call(GATE, [])).toMatchObject({ ok: false, reason: expect.stringMatching(/no answer from Genie in time/) });
            expect(await client.call(GATE, [], { timeoutMs: 2_000 })).toEqual({ ok: true, value: 'allowed' });
        } finally { await devices.flushed(); await rm(home, { recursive: true, force: true }); }
        await settle();
    });
});

describe('wired: main asks over the protocol, and reads none of the agent stores', () => {
    const main = code(src('src/main/main.ts'));
    it('main’s window tools ask the host’s queue over its own client', () => {
        expect(main).toMatch(/const approvalsNow = windowApprovals\(ownProtocol\);/);
        expect(main).toMatch(/approve: \(caller, action, detail, call\) => approvalsNow\.gate\(caller, action, detail, call\),/);
        expect(main).not.toMatch(/composed\.approvals\.gate\(/);
    });
    it('main reads nothing of the agent stores: no inbox, attention, knowledge, approvals or settings of the composition, and no comms cache', () => {
        expect(main).not.toMatch(/(composed|services!?\??)\.(inbox|attention|knowledge|approvals|settings)\b/);
        expect(main).not.toMatch(/dashboardComms|CommsCache|comms: \(agentId/);
        // CONTROL: the same scan finds what main still reads of the composition.
        // (composed.routes() left main in 2g-4d-D1, Tynn #1046: the front door is genie-host's frontdoor.watch.)
        // (composed.untrustedNow left main in 2g-4d D2, Tynn #1046: `sites open` and its trust gate are genie-host's.)
        expect(main).toMatch(/services = composed;/);
    });
    it('genie-host answers approvals.gate from its one queue, tied to the agent’s real call', () => {
        expect(code(src('src/main/genie-host.ts'))).toMatch(/approvalsGate: \(caller, action, detail, forwardedCallId\) => approvals\.gate\(caller, action, detail, forwardedCallId \? forwardedCalls\.get\(forwardedCallId\) : undefined\),/);
    });
});
