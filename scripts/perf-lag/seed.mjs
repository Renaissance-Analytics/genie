#!/usr/bin/env node
/**
 * THE OWNER'S RESTART, SEEDED (genie#1340) — eleven Codex agents with threads the size of the owner's, every one cut
 * off mid-turn, so the next launch resumes them all three seconds apart and prompts each to carry on.
 *
 *   node scripts/perf-lag/seed.mjs [scale]      scale 1 = the owner's sizes (≈660 MB of thread logs); 0.1 = a tenth
 *
 * Writes only what a real machine already has: ~/.genie/runtime/{workspaces,agents,interrupted-at-quit}.json and one
 * thread log per agent, in the store's own format (prism-harness FileSessionStore: `<sha256(key)[0..32]>.jsonl`, one
 * `{position, message, run_id, recorded_at}` per line). Row kinds and sizes follow the owner's largest thread
 * (measured 2026-10-29: p50 409 B, p99 12.8 KB, max 499 KB; notices 41%, tool frames 47%, usage 9%, messages 2%).
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const scale = Number(process.argv[2] ?? 1);
const runtime = join(homedir(), '.genie', 'runtime');
const sessions = join(runtime, 'sessions');
mkdirSync(sessions, { recursive: true });
const workspacePath = join(homedir(), 'lagws');
mkdirSync(workspacePath, { recursive: true });

// The owner's thread logs, largest first (rows): 166 MB, 117, 114, 83, 73, 62, 24, 21, 6.5, 2.1, 1.9.
const ROWS = [266_000, 303_000, 171_000, 123_000, 184_000, 79_000, 43_000, 31_000, 8_300, 3_000, 3_500];
const NAMES = ['moic', 'tynn', 'prism', 'fancy', 'genie', 'miapa', 'atlas', 'wren', 'pike', 'lark', 'tern'];

let seed = 1;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const LOREM = 'The quick brown fox jumps over the lazy dog while the build runs its suite again and again. ';
const text = (n) => LOREM.repeat(Math.ceil(n / LOREM.length)).slice(0, n);
const outputSize = () => { const r = rand(); return r < 0.001 ? 200_000 + Math.floor(rand() * 300_000) : r < 0.02 ? 2_000 + Math.floor(rand() * 10_000) : 100 + Math.floor(rand() * 600); };

function* rowsFor(count, runId) {
    let turn = 0;
    let call = 0;
    for (let i = 0; i < count; i += 1) {
        const k = i % 570;
        if (k === 0) { turn += 1; yield { kind: 'turn', n: turn, by: 'you', writtenByRun: runId }; continue; }
        if (k === 1) { yield { kind: 'message', speaker: 'you', peerName: null, text: text(200), writtenByRun: runId }; continue; }
        if (k === 569) { yield { kind: 'finished', n: turn, writtenByRun: runId }; continue; }
        const r = rand();
        if (r < 0.41) yield { kind: 'notice', level: 'debug', message: `unmapped Codex notification: item/${i}`, headroom: null, model: null, estimate: null, writtenByRun: runId };
        else if (r < 0.64) { call += 1; yield { kind: 'tool', toolCallId: `exec-${call}`, name: null, title: `npm test -- file${call}`, status: 'in_progress', toolKind: 'execute', rawInput: { command: `npm test -- file${call}`, cwd: '/work' }, writtenByRun: runId }; }
        else if (r < 0.87) yield { kind: 'tool', toolCallId: `exec-${call}`, name: null, title: `npm test -- file${call}`, status: 'completed', toolKind: 'execute', rawInput: { command: `npm test -- file${call}`, cwd: '/work' }, output: text(outputSize()), writtenByRun: runId };
        else if (r < 0.96) yield { kind: 'usage', used: 300_000, size: 475_000, cost: null, inTokens: 1_000_000 + i, outTokens: 6_000 + i, writtenByRun: runId };
        else if (r < 0.98) yield { kind: 'message', speaker: 'agent', peerName: null, text: text(300 + Math.floor(rand() * 1700)), writtenByRun: runId };
        else if (r < 0.985) yield { kind: 'plan', entries: [{ content: 'Read the brief', status: 'completed' }, { content: 'Do the work', status: 'in_progress' }], writtenByRun: runId };
        else yield { kind: 'notice', level: 'info', message: 'Codex rate limit: 24% used', headroom: null, model: null, estimate: null, writtenByRun: runId };
    }
}

async function writeThread(agentId, count) {
    const file = join(sessions, `${createHash('sha256').update(`genie:agent:${agentId}:thread`).digest('hex').slice(0, 32)}.jsonl`);
    const out = createWriteStream(file);
    const t0 = Date.parse('2026-10-20T00:00:00Z');
    let position = 0;
    let bytes = 0;
    let chunk = '';
    for (const message of rowsFor(count, `run-${agentId.slice(-6)}`)) {
        position += 1;
        chunk += `${JSON.stringify({ position, message, run_id: null, recorded_at: new Date(t0 + position * 1000).toISOString() })}\n`;
        if (chunk.length > 1 << 20) { bytes += chunk.length; if (!out.write(chunk)) await new Promise((r) => out.once('drain', r)); chunk = ''; }
    }
    bytes += chunk.length;
    out.write(chunk);
    await new Promise((r) => out.end(r));
    return { file, rows: position, bytes };
}

const now = new Date().toISOString();
const agents = NAMES.map((name, i) => ({
    id: `agent_${createHash('md5').update(name).digest('hex')}`,
    workspaceId: 'lag', provider: 'codex', name, instructions: null, threadId: 'stub_thread_0001',
    createdAt: now, lastUsedAt: now, mode: 'manual', accessScope: 'none', order: i,
}));
writeFileSync(join(runtime, 'workspaces.json'), JSON.stringify([{ id: 'lag', path: workspacePath }], null, 2));
writeFileSync(join(runtime, 'agents.json'), JSON.stringify(agents.map(({ order: _o, ...a }) => a), null, 2));
// Cut off mid-turn at the last quit: resumed whatever the setting, three seconds apart, and told to continue.
writeFileSync(join(runtime, 'interrupted-at-quit.json'), JSON.stringify(agents.map((a) => a.id)));
writeFileSync(join(runtime, 'running-at-quit.json'), JSON.stringify(agents.map((a) => a.id)));
let total = 0;
for (const [i, a] of agents.entries()) {
    const w = await writeThread(a.id, Math.max(100, Math.round(ROWS[i] * scale)));
    total += w.bytes;
    console.log(`${a.name} ${a.id}: ${w.rows} rows, ${(w.bytes / 1e6).toFixed(1)} MB`);
}
writeFileSync(join(homedir(), 'lag-agents.json'), JSON.stringify(agents.map((a) => ({ id: a.id, name: a.name }))));
console.log(`seeded ${agents.length} agents, ${(total / 1e6).toFixed(0)} MB of threads`);
