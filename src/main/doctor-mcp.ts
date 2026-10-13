import { ToolDefinition, type McpToolResult } from '@particle-academy/prism-mcp';
import type { OsaFacts } from '../core/osa-home.js';
import type { AgentId } from '../core/identity.js';
import type { LiveSession } from '../core/roster.js';
import type { TimedEvent } from '../core/stream-view.js';
import type { Registration } from './mcp-tools.js';

/**
 * THE DOCTOR CHANNEL (the owner, 2026-10-12): in doctor mode Genie serves an MCP that Claude Code connects to, to talk
 * to genie directly and help diagnose and repair the install at the code level. Four tools — `connect` (the facts),
 * `ask` (a message to genie, and its reply when its turn ends), `transcript` (what genie has said and done), `status`.
 *
 * THE OSA DOES NOT KNOW THIS CHANNEL EXISTS UNTIL IT IS USED. Its baked-in instructions never mention it
 * (core/osa-home.ts); it is told once, on the first call of any tool, in the words below — so it never goes looking for
 * whoever might be on the other end, in doctor mode or any other time. This server only runs in doctor mode.
 */
export const DOCTOR_ANNOUNCEMENT =
    'Claude Code has just connected to Genie’s doctor channel to help diagnose and repair this install. Its messages will reach you here, marked as coming from it; answer them plainly, as you would the person. You do not need to do anything else about the channel.';

export interface DoctorOsa {
    /** Put a line in front of the OSA without waiting for an answer. */
    tell(text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    /** A message to the OSA, answered when its turn ends. */
    ask(text: string, timeoutMs: number): Promise<{ ok: true; reply: string } | { ok: false; reason: string }>;
    transcript(limit: number): ReadonlyArray<{ at: number | null; kind: string; text: string }>;
    status(): Record<string, unknown>;
}

const ASK_TIMEOUT_MS = 10 * 60_000;

function ok(payload: Record<string, unknown>): McpToolResult {
    return { text: JSON.stringify({ ok: true, ...payload }), isError: false };
}
function err(reason: string): McpToolResult {
    return { text: JSON.stringify({ ok: false, error: reason }), isError: true };
}

export function doctorTools(osa: DoctorOsa, facts: OsaFacts): Registration[] {
    let announced: Promise<unknown> | null = null;
    // The first call of ANY tool tells the OSA, once; every call waits for that to have landed.
    const announce = (): Promise<unknown> => (announced ??= osa.tell(DOCTOR_ANNOUNCEMENT));
    const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[], title: string, run: (args: Record<string, unknown>) => Promise<McpToolResult> | McpToolResult): Registration => ({
        definition: new ToolDefinition(name, description, { type: 'object', properties, required } as never, title),
        handler: async (args) => { await announce(); return run(args as Record<string, unknown>); },
    });
    return [
        tool('connect', 'Connect to Genie in doctor mode: the install’s facts (version, folders) and whether genie is running. Call this first.', {}, [], 'Connect', () => ok({ facts, status: osa.status() })),
        tool('ask', 'Send genie (the workstation agent) a message and wait for its reply. Genie has not opened its configuration or database in doctor mode.', { message: { type: 'string' } }, ['message'], 'Ask genie', async (args) => {
            const message = typeof args.message === 'string' ? args.message.trim() : '';
            if (!message) return err('ask needs a message');
            const r = await osa.ask(`[from Claude Code, over the doctor channel] ${message}`, ASK_TIMEOUT_MS);
            return r.ok ? ok({ reply: r.reply }) : err(r.reason);
        }),
        tool('transcript', 'What genie has said and done in this doctor session, oldest first (messages, tool calls, thoughts).', { limit: { type: 'number' } }, [], 'Transcript', (args) => ok({ rows: osa.transcript(typeof args.limit === 'number' ? Math.max(1, Math.min(500, args.limit)) : 100) })),
        tool('status', 'Whether genie is running, its turn state, and anything it is waiting on.', {}, [], 'Status', () => ok({ status: osa.status() })),
    ];
}

/** The slice of the session host `ask` needs. */
export interface OsaHostLike {
    prompt(agentId: AgentId, text: string, by?: string | null): boolean;
    rowsFor(agentId: AgentId): readonly TimedEvent[];
    probe(agentId: AgentId): LiveSession | null;
    subscribe(listener: (agentId: AgentId) => void): () => void;
}

/** Prompt the OSA and resolve with ITS words from that turn once the turn ends (or the reason it could not). */
export function askAndWait(host: OsaHostLike, agentId: AgentId | string, text: string, timeoutMs: number): Promise<{ ok: true; reply: string } | { ok: false; reason: string }> {
    const id = agentId as AgentId;
    const before = host.rowsFor(id).length;
    if (!host.prompt(id, text, 'doctor')) return Promise.resolve({ ok: false, reason: 'genie is not running' });
    return new Promise((resolve) => {
        let done = false;
        const finish = (r: { ok: true; reply: string } | { ok: false; reason: string }) => { if (done) return; done = true; clearTimeout(timer); off(); resolve(r); };
        const check = () => {
            const s = host.probe(id);
            if (!s || !s.running) return finish({ ok: false, reason: 'genie stopped before it answered' });
            if (s.turnState !== 'idle') return;
            const reply = host.rowsFor(id).slice(before).flatMap((r) => (r.event.kind === 'message' && r.event.speaker === 'agent' ? [r.event.text] : [])).join('\n\n');
            finish({ ok: true, reply });
        };
        const off = host.subscribe((changed) => { if (changed === id) check(); });
        const timer = setTimeout(() => finish({ ok: false, reason: `genie had not finished after ${Math.round(timeoutMs / 1000)} s; read the transcript` }), timeoutMs);
    });
}
