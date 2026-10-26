import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@particle-academy/prism-acp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import { promptDeliveries } from '../src/core/prompt-delivery.js';
import type { DriverEvents } from '../src/core/session.js';
import { openDurableStore, readHistory } from '../src/core/thread-store.js';
import { RESUME_AFTER_RESTART } from '../src/core/upgrade-drain.js';
import { restartAgent, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { sessionHostPort } from '../src/main/agent-ops-host-port.js';
import { sessionsDir } from '../src/main/paths.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * WHAT A RESTART OWES (genie#1238; the owner, 2026-10-26, after beta.45): agents went Broken, the resume prompt Genie
 * wrote for their interrupted turn ("Genie shut down while you were in the middle of a turn … Continue") was recorded
 * `undelivered`, and Restart neither brought them back nor ever sent it. A Restart that went ahead delivers what the
 * agent is owed — the undelivered resume prompt and the person's undelivered drafts — in the order they were written,
 * EXACTLY ONCE: a second Restart sends none of them again.
 *
 * The REAL SessionHost behind the port main.ts builds (`sessionHostPort`); the providers and the process table are
 * fakes, and the preparation each start waits on (the agent's MCP context) is held in the test's hand.
 */

function deferred<T>() {
    let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
const GENIE: McpServer = { type: 'http', name: 'genie', url: 'http://127.0.0.1:12345/mcp', headers: [] };
const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';
let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-restart-owed-')); });
afterEach(async () => { for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); } await rm(dir, { recursive: true, force: true }); });

function world() {
    const preparations: Array<ReturnType<typeof deferred<readonly McpServer[]>>> = [];
    const readiness: Array<ReturnType<typeof deferred<void>>> = [];
    const sent: unknown[] = [];
    const resumedWith: Array<string | null> = [];
    let events: DriverEvents = {};
    let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
    const tree: ProcessTree = {
        snapshot: () => [...processes],
        killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
    };
    let spawns = 0;
    const driverFor: DriverFor = (_agent, _cwd, resume) => {
        resumedWith.push(resume);
        const ready = deferred<void>(); readiness.push(ready);
        return ({ events: callbacks }) => {
            events = callbacks;
            const pid = process.pid + 1_000_000 + (spawns += 1);
            return {
                start: () => { processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' }); },
                prompt: (content) => { sent.push(content); },
                kill: () => { processes = processes.filter((p) => p.pid !== pid); },
                cliSessionId: null, ready: ready.promise,
            };
        };
    };
    const options: ConstructorParameters<typeof SessionHost>[0] & {
        prepareMcpServers(agent: AgentRecord, cwd: string, signal: AbortSignal): Promise<readonly McpServer[]>;
    } = {
        userData: dir, driverFor, processTree: tree, stopGraceMs: 0, mcpServersFor: () => [GENIE],
        prepareMcpServers: async () => { const p = deferred<readonly McpServer[]>(); preparations.push(p); return p.promise; },
    };
    const host = new SessionHost(options); hosts.push(host);
    const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'atlas' }), threadId: THREAD };
    const ports = {
        registry: { find: (id: string) => (id === record.id ? record : null), clearThread: async () => record },
        host: sessionHostPort(() => host),
        cwdFor: () => dir,
        startRefusal: () => null,
    } as unknown as AgentOpsPorts;
    const deliveries = async () => {
        await host.settled();
        const { rows } = await readHistory(openDurableStore(sessionsDir(dir)), record.id);
        const states = promptDeliveries(rows);
        return rows.flatMap(({ event: e }) => (e.kind === 'message' && e.pending ? [{ text: e.text, status: states.get(e.pending.id) }] : []));
    };
    /**
     * The CURRENT run's preparation: the newest one not yet taken. A run stopped while preparing (a second Restart) had
     * its preparation cancelled; resolving that one would start nothing.
     */
    let consumed = 0;
    const nextPreparation = async () => {
        await vi.waitFor(() => expect(preparations.length).toBeGreaterThan(consumed));
        consumed = preparations.length;
        return preparations[consumed - 1]!;
    };
    /** The run in progress gets its MCP context and its provider says it is ready. */
    const comeUp = async () => {
        const drivers = readiness.length;
        (await nextPreparation()).resolve([GENIE]);
        await vi.waitFor(() => expect(readiness.length).toBe(drivers + 1));
        readiness.at(-1)!.resolve();
    };
    const failPreparation = async (why: string) => {
        (await nextPreparation()).reject(new Error(why));
        await vi.waitFor(() => expect(host.probe(record.id)?.failure).toBeTruthy());
    };
    const endTurn = () => events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: 'end_turn' });
    return { host, record, ports, sent, resumedWith, deliveries, comeUp, failPreparation, endTurn };
}

describe('Restart delivers what a Broken agent is owed — once', () => {
    it('the undelivered resume prompt of an agent that went Broken on relaunch is sent after Restart, and never again', async () => {
        const w = world();
        // The relaunch after an upgrade (main.ts): start, and the interrupted agent is told to continue.
        expect(w.host.start(w.record, '.')).toEqual({ ok: true });
        expect(w.host.prompt(w.record.id, RESUME_AFTER_RESTART, 'genie')).toBe(true);
        // Its preparation fails: Broken, and the resume prompt is left `undelivered` — what the owner saw.
        await w.failPreparation('the tynn token could not be minted');
        expect(await w.deliveries()).toEqual([{ text: RESUME_AFTER_RESTART, status: 'undelivered' }]);

        // The person presses Restart. Red on main: refused, "only a fresh restart reaches a wedged agent".
        expect(await restartAgent(w.ports, w.record.id, 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        await w.comeUp();
        await vi.waitFor(() => expect(w.sent).toEqual([RESUME_AFTER_RESTART]));
        // On the same conversation, and the ledger says it was delivered — the message row once, not a copy of it.
        expect(w.resumedWith.at(-1)).toBe(THREAD);
        await vi.waitFor(async () => expect(await w.deliveries()).toEqual([{ text: RESUME_AFTER_RESTART, status: 'sent' }]));

        // Restart again: nothing owed any more, so nothing is sent again.
        w.endTurn();
        expect(await restartAgent(w.ports, w.record.id, 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        await w.comeUp();
        await vi.waitFor(() => expect(w.host.probe(w.record.id)?.turnState).not.toBe('failed'));
        await w.host.settled();
        expect(w.sent).toEqual([RESUME_AFTER_RESTART]);
        expect(await w.deliveries()).toEqual([{ text: RESUME_AFTER_RESTART, status: 'sent' }]);
    });

    it('the resume prompt and the person’s undelivered drafts go in the order they were written, each once', async () => {
        const w = world();
        expect(w.host.start(w.record, '.')).toEqual({ ok: true });
        expect(w.host.prompt(w.record.id, RESUME_AFTER_RESTART, 'genie')).toBe(true);
        expect(w.host.deliver(w.record.id, 'and then rebase the Deck branch', 'you')).toBe(true);
        await w.failPreparation('preparation failed');
        expect((await w.deliveries()).map((d) => d.status)).toEqual(['undelivered', 'undelivered']);

        expect(await restartAgent(w.ports, w.record.id, 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        // Pressed twice while it comes up (a second surface, an impatient click): still each once.
        expect(await restartAgent(w.ports, w.record.id, 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        await w.comeUp();
        await vi.waitFor(() => expect(w.sent).toEqual([RESUME_AFTER_RESTART, 'and then rebase the Deck branch']));
        await vi.waitFor(async () => expect((await w.deliveries()).map((d) => d.status)).toEqual(['sent', 'sent']));
    });

    it('a relaunch whose START was refused keeps the resume prompt as owed (it was dropped), and Restart delivers it once', async () => {
        const w = world();
        // No session: `prompt` has nothing to take it (main.ts's relaunch used to stop there, and the work was lost).
        expect(w.host.prompt(w.record.id, RESUME_AFTER_RESTART, 'genie')).toBe(false);
        await w.host.recordOwed(w.record.id, RESUME_AFTER_RESTART, 'genie');
        expect(await w.deliveries()).toEqual([{ text: RESUME_AFTER_RESTART, status: 'undelivered' }]);

        expect(await restartAgent(w.ports, w.record.id, 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        await w.comeUp();
        await vi.waitFor(() => expect(w.sent).toEqual([RESUME_AFTER_RESTART]));
        await vi.waitFor(async () => expect(await w.deliveries()).toEqual([{ text: RESUME_AFTER_RESTART, status: 'sent' }]));
    });

    it('a Restart whose preparation fails AGAIN leaves them owed, and the next Restart delivers them', async () => {
        const w = world();
        expect(w.host.start(w.record, '.')).toEqual({ ok: true });
        expect(w.host.prompt(w.record.id, RESUME_AFTER_RESTART, 'genie')).toBe(true);
        await w.failPreparation('first');

        expect(await restartAgent(w.ports, w.record.id, 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        await w.failPreparation('second');
        expect(w.sent).toEqual([]);
        expect(await w.deliveries()).toEqual([{ text: RESUME_AFTER_RESTART, status: 'undelivered' }]);

        expect(await restartAgent(w.ports, w.record.id, 'graceful')).toEqual({ ok: true, kind: 'graceful' });
        await w.comeUp();
        await vi.waitFor(() => expect(w.sent).toEqual([RESUME_AFTER_RESTART]));
    });
});
