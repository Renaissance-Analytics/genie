import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statePill } from '../src/core/agent-view.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { LiveSession } from '../src/core/roster.js';
import { AgentSession, type DriverEvents, type SessionDriver, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * THE PILL'S TWO STAMPS (the board): `Turn 15 · parked · waiting on you 0:42` and `Broken · stream closed 14:31`.
 * Neither is on the wire; both are Genie's OWN observations — the moment the request parked here, the moment the
 * failure was recorded — so the session stamps them with the clock it is given, the host passes its clock, the
 * snapshot carries them, and the pill reads them. Without a stamp the pill says nothing about time (never a guess).
 */
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const fmt = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

describe('the session stamps', () => {
    const dirs: string[] = [];
    afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

    function open(clock: () => number) {
        let events: DriverEvents = {};
        const factory: SessionDriverFactory = (options) => {
            events = options.events;
            const driver: SessionDriver = { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
            return driver;
        };
        const dir = mkdtempSync(join(tmpdir(), 'genie2-stamps-'));
        dirs.push(dir);
        const session = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noProcessTree, clock });
        session.start();
        return { session, ev: () => events };
    }

    it('parkedAt: the clock when the request parked; cleared when it is answered', () => {
        let t = 1_000;
        const { session, ev } = open(() => t);
        expect(session.parkedAt).toBeNull();
        t = 5_000;
        void ev().onRequestPermission?.({ toolCall: { title: 'php artisan migrate --force' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
        expect(session.parkedAt).toBe(5_000);
        t = 9_000;
        expect(session.parkedAt).toBe(5_000); // The stamp does not drift with the clock.
        expect(session.answerApproval('allow')).toBe(true);
        expect(session.parkedAt).toBeNull();
    });

    it('failedAt: the clock when the FIRST reason was recorded (a later symptom does not move it); cleared by a clean turn', () => {
        let t = 1_000;
        const { session, ev } = open(() => t);
        t = 7_000;
        ev().onProtocolError?.('thread/start response did not contain thread.id');
        t = 8_000;
        ev().onProtocolError?.('transport closed');
        expect(session.failure).toBe('thread/start response did not contain thread.id');
        expect(session.failedAt).toBe(7_000);

        const b = open(() => t);
        t = 11_000;
        b.ev().onTurnEnd?.({ stopReason: null, isError: true, raw: 'api error 529' });
        expect(b.session.failedAt).toBe(11_000);
        t = 12_000;
        b.ev().onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
        expect(b.session.failure).toBeNull();
        expect(b.session.failedAt).toBeNull();
    });
});

describe('the host carries them to the snapshot', () => {
    let dir: string;
    let now = 1_760_000_000_000;
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => {
        const factory: SessionDriverFactory = (options) => { events = options.events; return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } }; };
        return factory;
    };
    let host: SessionHost;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-stamps-host-'));
        now = 1_760_000_000_000;
        host = new SessionHost({ userData: dir, driverFor, clock: () => now, processTree: noProcessTree });
    });
    afterEach(async () => { host.stopAll(); await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });

    it('parkedAt and failure.at come from the host clock', () => {
        const r = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        host.start(r, dir);
        now += 42_000;
        void events.onRequestPermission?.({ toolCall: { title: 'rm -rf build' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] });
        expect(host.probe(r.id)?.parkedAt).toBe(now);

        const f = agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'wren' });
        host.start(f, dir);
        now += 1_000;
        events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'stream closed' });
        expect(host.probe(f.id)?.failure).toMatchObject({ reason: 'stream closed', at: now });
    });
});

describe('the pill reads them', () => {
    const session = (over: Partial<LiveSession> = {}): LiveSession =>
        ({ running: true, turnState: 'working', startedAt: 1_000_000 - 155_000, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null, ...over }) as LiveSession;
    const now = () => 1_000_000;
    const parked = { question: 'Allow?', options: [] } as never;

    it('parked: the wait since the stamp; nothing without one', () => {
        expect(statePill(session({ turnState: 'idle', pendingApproval: parked, parkedAt: 1_000_000 - 42_000 }), now, { turns: 15 })).toEqual({ word: 'Turn 15 · parked · waiting on you', elapsed: '0:42', tone: 'warn' });
        expect(statePill(session({ turnState: 'idle', pendingApproval: parked }), now, { turns: 15 }).elapsed).toBeNull();
        expect(statePill(session({ turnState: 'idle', pendingApproval: parked, parkedAt: null }), now, { turns: 15 }).elapsed).toBeNull();
    });

    it('broken: the reason and when Genie recorded it; the reason alone without a stamp', () => {
        const at = Date.UTC(2026, 9, 12, 14, 31);
        expect(statePill(session({ failure: { reason: 'stream closed', fixes: [], at } }), now, { turns: 3 })).toEqual({ word: `Broken · stream closed ${fmt(at)}`, elapsed: null, tone: 'bad' });
        expect(statePill(session({ failure: { reason: 'stream closed', fixes: [] } }), now, { turns: 3 }).word).toBe('Broken · stream closed');
    });
});
