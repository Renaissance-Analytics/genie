import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { ProcessInfo, ProcessTree } from '../src/core/process-tree.js';
import { CANCEL_STATE_UNCERTAIN, CANCEL_STATE_UNCERTAIN_CODE, RESTARTED_FOR_QUEUE, type DriverEvents, type SessionDriver, type TurnOutcomeLike } from '../src/core/session.js';
import { AgentToolCalls, INTERRUPTED_WORDS, withInterruptibleCalls } from '../src/main/mcp-interrupt.js';
import type { Registration, ToolContext } from '../src/main/mcp-tools.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';
import { ChatQueueBar } from '../src/renderer/components/ChatQueueBar.js';

/**
 * AN INTERRUPT NEVER STOPS THE AGENT AND NEVER DROPS WHAT WAITS (Tynn #702). The owner's moic agent, beta.61, waited in
 * two long `services exec` calls (`php artisan test`); he interrupted it so it would read his six messages. Claude Code did
 * not answer the interrupt inside prism-acp's 30 s, prism ended the CLI ("cancel state uncertain"), and Genie marked every
 * queued message "Not delivered" (his thread, 03:04:34.874Z). Now:
 *  - Genie ends its own MCP calls for that agent at once, so the call returns and the provider can answer in time;
 *  - a cancel that is still not confirmed restarts the agent on the same conversation and sends the queue in order;
 *  - nothing an interrupt leaves waiting is ever marked undelivered;
 *  - the chat has one queue with one "Send all now".
 */
const CANCELLED: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'cancelled' };
const DROPPED: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'dropped by cancel' };
const MISMATCH: TurnOutcomeLike = { stopReason: 'cancelled', isError: false, raw: 'cancel accounting mismatch' };

describe('Genie ends its own tool calls for the agent interrupted', () => {
    const forever: Registration = { definition: { name: 'services', description: 'x', inputSchema: { type: 'object' } } as never, handler: (_a, context) => new Promise((resolve) => { context.signal?.addEventListener('abort', () => resolve({ text: 'the command was ended', isError: true })); }) };
    const deaf: Registration = { definition: { name: 'deaf', description: 'x', inputSchema: { type: 'object' } } as never, handler: () => new Promise(() => {}) };
    const resolve = (session: string) => (session === 'sa' ? { agentId: 'agent_a' } : session === 'sb' ? { agentId: 'agent_b' } : null);
    const call = (r: Registration, session: string) => r.handler({}, { server: 'genie', tool: r.definition.name, headers: { 'genie-session': session } } as ToolContext);

    it('a running call returns at once with the reason, and its command is told to stop', async () => {
        const calls = new AgentToolCalls();
        const [services] = withInterruptibleCalls([forever], resolve, calls);
        const pending = call(services!, 'sa');
        expect(calls.running('agent_a')).toBe(1);
        expect(calls.end('agent_a', 'interrupt')).toBe(1);
        await expect(pending).resolves.toEqual({ text: INTERRUPTED_WORDS.interrupt, isError: true });
        expect(calls.running('agent_a')).toBe(0);
        expect(INTERRUPTED_WORDS.interrupt).toBe('Stopped because you interrupted.');
    });

    it('a tool that ignores the stop still returns at once', async () => {
        const calls = new AgentToolCalls();
        const [d] = withInterruptibleCalls([deaf], resolve, calls);
        const pending = call(d!, 'sa');
        calls.end('agent_a', 'stop');
        await expect(pending).resolves.toEqual({ text: 'Stopped because you stopped the turn.', isError: true });
    });

    it('CONTROL: another agent’s call runs on, and a call nobody stops is not answered', async () => {
        const calls = new AgentToolCalls();
        const [services] = withInterruptibleCalls([forever], resolve, calls);
        let settled = false;
        void Promise.resolve(call(services!, 'sb')).then(() => { settled = true; });
        expect(calls.end('agent_a', 'interrupt')).toBe(0);
        await new Promise((r) => setTimeout(r, 10));
        expect(settled).toBe(false);
        expect(calls.running('agent_b')).toBe(1);
    });

    it('genie-host wraps every tool it serves, and an interrupt reaches them', () => {
        expect(readFileSync('src/main/host-mcp.ts', 'utf8')).toMatch(/withInterruptibleCalls\(/);
        expect(readFileSync('src/main/genie-host.ts', 'utf8')).toMatch(/endToolCalls: \(agentId, intent\) => toolCalls\.end\(agentId, intent\)/);
    });
});

describe('SessionHost: an interrupt keeps the agent and sends the queue', () => {
    const THREAD = '8c2b9a52-3c8e-4f7a-9d61-1e0f2a3b4c5d';
    let dir: string;
    const hosts: SessionHost[] = [];
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-interrupt-queue-')); });
    afterEach(async () => {
        for (const h of hosts.splice(0)) { h.stopAll(); await h.drained(0); await h.settled(); }
        await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    interface Driver { prompts: unknown[]; cancels: number; events: DriverEvents; uncertain: (ends: number) => void }
    function world() {
        const drivers: Driver[] = [];
        const resumedWith: Array<string | null> = [];
        const ended: string[] = [];
        let processes: ProcessInfo[] = [{ pid: process.pid, ppid: 1, started: 1, name: 'genie-test' }];
        const tree: ProcessTree = {
            snapshot: () => [...processes],
            killTree: (targets) => { const ids = new Set(targets.map((p) => p.pid)); processes = processes.filter((p) => !ids.has(p.pid)); return { killed: targets.length, refused: false }; },
        };
        const driverFor: DriverFor = (_agent, _cwd, resume) => {
            resumedWith.push(resume);
            return ({ events }) => {
                const pid = process.pid + 2_000_000 + drivers.length + 1;
                let stopped = false;
                let running = false;
                const d: Driver = {
                    prompts: [], cancels: 0, events,
                    // prism-acp's #cancelMismatch, in its order: the error, each unfinished prompt's end, the CLI's exit.
                    uncertain: (ends) => {
                        stopped = true;
                        events.onProtocolError?.(CANCEL_STATE_UNCERTAIN, { recoverable: false });
                        for (let i = 0; i < ends; i++) events.onTurnEnd?.(MISMATCH);
                        running = false;
                        processes = processes.filter((p) => p.pid !== pid);
                        events.onExit?.(null, 'SIGTERM');
                    },
                };
                drivers.push(d);
                const driver: SessionDriver = {
                    start: () => { running = true; processes.push({ pid, ppid: process.pid, started: 3, name: 'claude-fixture' }); },
                    prompt: (content) => {
                        if (stopped) throw Object.assign(new Error(CANCEL_STATE_UNCERTAIN), { name: 'ClaudeCancelStateError', code: CANCEL_STATE_UNCERTAIN_CODE });
                        d.prompts.push(content);
                    },
                    cancel: () => { d.cancels += 1; return Promise.resolve(); },
                    kill: () => { running = false; processes = processes.filter((p) => p.pid !== pid); },
                    get running() { return running; },
                    get cliSessionId() { return THREAD; },
                };
                return driver;
            };
        };
        const host = new SessionHost({ userData: dir, driverFor, processTree: tree, stopGraceMs: 0, endToolCalls: (agentId, intent) => { ended.push(`${agentId}:${intent}`); return 1; } } as ConstructorParameters<typeof SessionHost>[0]);
        hosts.push(host);
        const record: AgentRecord = { ...agentRecord({ id: mintAgentId(), workspaceId: 'workspace', provider: 'claude', name: 'moic' }), threadId: THREAD };
        const events = () => host.rowsFor(record.id).map((r) => r.event);
        return { host, record, drivers, resumedWith, ended, events };
    }

    it('interrupt during a Genie tool call: the call is ended, the turn cancels, and the queue goes to the SAME agent, no restart', async () => {
        const w = world();
        w.host.start(w.record, dir);
        w.host.prompt(w.record.id, 'run the tests', 'you');
        // His messages while it waits in the tool call: Claude takes them mid-turn.
        w.host.prompt(w.record.id, 'do not run tests as services', 'you');
        w.host.prompt(w.record.id, 'and read this', 'you');
        expect(w.host.cancel(w.record.id, 'you', 'interrupt')).toEqual({ ok: true });
        expect(w.ended).toEqual([`${w.record.id}:interrupt`]);
        // The tool call returned, so Claude answers the interrupt: the turn ends cancelled, and prism drops what it held.
        w.drivers[0]!.events.onTurnEnd?.(CANCELLED);
        w.drivers[0]!.events.onTurnEnd?.(DROPPED);
        w.drivers[0]!.events.onTurnEnd?.(DROPPED);
        await w.host.settled();
        // What waited goes next, in order, as Genie's queue sends it: all of it, one after another.
        await vi.waitFor(() => expect(w.drivers[0]!.prompts.slice(3)).toEqual(['do not run tests as services', 'and read this']));
        expect(w.drivers).toHaveLength(1);
        expect(w.events().filter((e) => e.kind === 'prompt_delivery' && e.status === 'undelivered')).toEqual([]);
    });

    it('an interrupt Claude never confirms: the agent starts again on the same conversation and the queue is sent, in order', async () => {
        const w = world();
        w.host.start(w.record, dir);
        w.host.prompt(w.record.id, 'run the tests', 'you');
        w.host.prompt(w.record.id, 'do not run tests as services', 'you');
        w.host.prompt(w.record.id, 'and read this', 'you');
        expect(w.host.cancel(w.record.id, 'you', 'interrupt')).toEqual({ ok: true });
        w.drivers[0]!.uncertain(3);
        await vi.waitFor(() => expect(w.drivers).toHaveLength(2), { timeout: 3_000 });
        expect(w.resumedWith).toEqual([THREAD, THREAD]);
        await vi.waitFor(() => expect(w.drivers[1]!.prompts).toEqual(['do not run tests as services', 'and read this']), { timeout: 3_000 });
        // The notice is the OLD run's row: `rowsFor` holds only the run now in the map, so it is read from the agent's stored
        // thread, once every run's writes have landed (`settled`).
        await w.host.settled();
        const stored = readFileSync(join(dir, readdirOne(dir)), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as { message?: { kind?: string; message?: string } });
        expect(stored.filter((row) => row.message?.kind === 'notice' && row.message.message === RESTARTED_FOR_QUEUE)).toHaveLength(1);
        expect(RESTARTED_FOR_QUEUE).toBe('The provider did not confirm the interrupt in time, so Genie restarted the agent on the same conversation; your messages are sent now.');
    });

    it('nothing an interrupt leaves waiting is marked undelivered, and no “Stopped” is shown for it', async () => {
        const w = world();
        w.host.start(w.record, dir);
        w.host.prompt(w.record.id, 'run the tests', 'you');
        w.host.prompt(w.record.id, 'one', 'you');
        w.host.prompt(w.record.id, 'two', 'you');
        w.host.cancel(w.record.id, 'you', 'interrupt');
        w.drivers[0]!.uncertain(3);
        await w.host.settled();
        const stored = readFileSync(join(dir, readdirOne(dir)), 'utf8');
        expect(stored).not.toContain('"status":"undelivered"');
        expect(stored).not.toMatch(/"kind":"stopped","n":\d+,"by":null/);
    });

    it('CONTROL: the person’s STOP that is not confirmed keeps today’s rule: no restart of its own', async () => {
        const w = world();
        w.host.start(w.record, dir);
        w.host.prompt(w.record.id, 'work', 'you');
        w.host.cancel(w.record.id);
        w.drivers[0]!.uncertain(1);
        await w.host.settled();
        await new Promise((r) => setTimeout(r, 50));
        expect(w.drivers).toHaveLength(1);
        expect(w.host.needsNewDriver(w.record.id)).toBe(true);
    });
});

/** The one session file this test's host wrote. */
function readdirOne(dir: string): string {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p).map((x) => join(n, x)) : [n]; });
    const files = walk(dir).filter((f) => /sessions[\\/][0-9a-f]+\.jsonl$/.test(f));
    if (files.length !== 1) throw new Error(`expected one session file, found ${files.length}`);
    return files[0]!;
}

describe('the chat: one queue, one action', () => {
    const draw = (p: Partial<Parameters<typeof ChatQueueBar>[0]>) => renderToStaticMarkup(<ChatQueueBar agentName="moic" waiting={0} undelivered={0} {...p} />);

    it('messages waiting behind a turn: one line, one “Send all now (stop the current turn)”', () => {
        const html = draw({ waiting: 6, onInterruptAndSend: () => {} });
        expect(html).toContain('6 waiting');
        expect(html.match(/<button/g) ?? []).toHaveLength(1);
        expect(html).toMatch(/data-action="send-all-now"[^>]*>(?:<[^>]+>)*Send all now \(stop the current turn\)/);
    });

    it('messages not delivered: one line, “Send all now” and “Discard all”', () => {
        const html = draw({ undelivered: 6, onSendAll: () => {}, onDiscardAll: () => {} });
        expect(html).toContain('6 not delivered');
        expect(html).toMatch(/data-action="send-all"[^>]*>(?:<[^>]+>)*Send all now</);
        expect(html).toMatch(/data-action="discard-all"[^>]*>(?:<[^>]+>)*Discard all/);
    });

    it('CONTROL: nothing waiting, no bar', () => {
        expect(draw({})).toBe('');
    });

    it('the chat draws the bar once, and a message’s own row keeps only a small remove', () => {
        const chat = readFileSync('src/renderer/components/ChatFlyout.tsx', 'utf8');
        expect(chat).toMatch(/<ChatQueueBar\b/);
        expect(chat).toMatch(/data-action="remove-draft"[^>]*aria-label="Remove this message"/);
        expect(chat).not.toMatch(/data-action="send-draft"/);
        expect(chat).not.toMatch(/onSendNow=\{onInterruptAndSend\}/);
        expect(chat).not.toMatch(/<ChatWaitingLive [^>]*onInterruptAndSend=/);
    });
});
