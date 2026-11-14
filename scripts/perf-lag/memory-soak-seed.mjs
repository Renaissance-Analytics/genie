/**
 * THE OWNER'S ESTATE, SEEDED FOR THE MEMORY SOAK (Tynn #662). What his machine held on 2026-11-12 (read-only counts):
 * 9,573 AgentInbox mails in one 14 MB mail.json (p50 1.1 KB, max 13.7 KB); attention-history.json 4.2 MB (770 finished
 * handoffs, 413 decided questions); thread logs of 11-1,081 MB; 32 agents. Synthetic text of the same sizes and the same
 * character class: Genie's words carry curly quotes (’), so its JSON is TWO-BYTE in V8, as here.
 *
 * Writes only into `home` (a temp root the soak made): `<home>/.genie/runtime/...` and a workspace folder. Nothing real.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let seed = 7;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const LOREM = 'The suite’s output is read against the plan before the next step; each failure gets its own note. ';
const text = (n) => LOREM.repeat(Math.ceil(n / LOREM.length)).slice(0, n);
const idOf = (name) => `agent_${createHash('md5').update(name).digest('hex')}`;
const threadFile = (sessions, agentId) => join(sessions, `${createHash('sha256').update(`genie:agent:${agentId}:thread`).digest('hex').slice(0, 32)}.jsonl`);
const outputSize = () => { const r = rand(); return r < 0.001 ? 200_000 + Math.floor(rand() * 300_000) : r < 0.02 ? 2_000 + Math.floor(rand() * 10_000) : 100 + Math.floor(rand() * 600); };

/** One thread's rows, the owner's mix (scripts/perf-lag/seed.mjs, measured 2026-10-29). */
function* rowsFor(count, runId) {
    let turn = 0, call = 0;
    for (let i = 0; i < count; i += 1) {
        const k = i % 120;
        if (k === 0) { turn += 1; yield { kind: 'turn', n: turn, by: 'you', writtenByRun: runId }; continue; }
        if (k === 1) { yield { kind: 'message', speaker: 'you', peerName: null, text: text(200 + Math.floor(rand() * 800)), writtenByRun: runId }; continue; }
        if (k === 119) { yield { kind: 'finished', n: turn, writtenByRun: runId }; continue; }
        const r = rand();
        if (r < 0.30) yield { kind: 'notice', level: 'debug', message: `unmapped Codex notification: item/${i}`, headroom: null, model: null, estimate: null, writtenByRun: runId };
        else if (r < 0.50) { call += 1; yield { kind: 'tool', toolCallId: `exec-${call}`, name: null, title: `npm test -- file${call}`, status: 'in_progress', toolKind: 'execute', rawInput: { command: `npm test -- file${call}`, cwd: '/work' }, writtenByRun: runId }; }
        else if (r < 0.75) yield { kind: 'tool', toolCallId: `exec-${call}`, name: null, title: `npm test -- file${call}`, status: 'completed', toolKind: 'execute', rawInput: { command: `npm test -- file${call}`, cwd: '/work' }, output: text(outputSize()), writtenByRun: runId };
        else if (r < 0.82) yield { kind: 'usage', used: 300_000, size: 475_000, cost: null, inTokens: 1_000_000 + i, outTokens: 6_000 + i, writtenByRun: runId };
        else if (r < 0.97) yield { kind: 'message', speaker: 'agent', peerName: null, text: text(300 + Math.floor(rand() * 2700)), writtenByRun: runId };
        else yield { kind: 'plan', entries: [{ content: 'Read the brief', status: 'completed' }, { content: 'Do the work', status: 'in_progress' }], writtenByRun: runId };
    }
}

async function writeThread(sessions, agentId, count) {
    const out = createWriteStream(threadFile(sessions, agentId));
    const t0 = Date.now() - count * 1000;
    let position = 0, bytes = 0, chunk = '';
    for (const message of rowsFor(count, `run-old-${agentId.slice(-6)}`)) {
        position += 1;
        chunk += `${JSON.stringify({ position, message, run_id: null, recorded_at: new Date(t0 + position * 1000).toISOString() })}\n`;
        if (chunk.length > 1 << 20) { bytes += Buffer.byteLength(chunk); if (!out.write(chunk)) await new Promise((r) => out.once('drain', r)); chunk = ''; }
    }
    bytes += Buffer.byteLength(chunk);
    out.write(chunk);
    await new Promise((r) => out.end(r));
    return bytes;
}

/**
 * @param {{ home: string, workspace: string, threadAgents?: number, rosterAgents?: number, rowsPerThread?: number, mails?: number, pending?: number, busy?: number }} o
 * @returns {Promise<{ agents: {id: string, name: string}[], busy: string[], bytes: Record<string, number> }>}
 */
export async function seedSoak(o) {
    const runtime = join(o.home, '.genie', 'runtime');
    const sessions = join(runtime, 'sessions');
    mkdirSync(sessions, { recursive: true });
    mkdirSync(join(runtime, 'inbox'), { recursive: true });
    mkdirSync(o.workspace, { recursive: true });
    const threadAgents = o.threadAgents ?? 10, roster = o.rosterAgents ?? 32, rows = o.rowsPerThread ?? 6000;
    const now = Date.now();
    const iso = (ms) => new Date(ms).toISOString();
    const names = Array.from({ length: roster }, (_, i) => `soak${String(i).padStart(2, '0')}`);
    const agents = names.map((name) => ({ id: idOf(name), workspaceId: 'soak', provider: 'codex', name, instructions: null, threadId: 'stub_thread_0001', createdAt: iso(now - 864e5), lastUsedAt: iso(now - 6e4), mode: 'manual', accessScope: 'all' }));
    writeFileSync(join(runtime, 'workspaces.json'), JSON.stringify([{ id: 'soak', path: o.workspace }], null, 2));
    writeFileSync(join(runtime, 'agents.json'), JSON.stringify(agents, null, 2));
    const busy = agents.slice(0, o.busy ?? 4).map((a) => a.id);
    // Cut off mid-turn at the last quit: resumed at launch and told to carry on (the busy stub works for the whole soak).
    writeFileSync(join(runtime, 'interrupted-at-quit.json'), JSON.stringify(busy));
    writeFileSync(join(runtime, 'running-at-quit.json'), JSON.stringify(busy));
    const bytes = { threads: 0 };
    for (const a of agents.slice(0, threadAgents)) bytes.threads += await writeThread(sessions, a.id, rows);

    // THE INBOX: one file, as the store keeps it. Between agents, and agents and the person.
    const people = ['human', ...agents.map((a) => a.id)];
    const messages = [];
    const mails = o.mails ?? 9500;
    for (let i = 0; i < mails; i += 1) {
        const from = people[Math.floor(rand() * people.length)];
        let to = people[Math.floor(rand() * people.length)];
        if (to === from) to = from === 'human' ? agents[0].id : 'human';
        const size = rand() < 0.02 ? 6000 + Math.floor(rand() * 7000) : 400 + Math.floor(rand() * 1600);
        const at = iso(now - (mails - i) * 60_000);
        messages.push({ seq: i + 1, id: `msg_${createHash('md5').update(`m${i}`).digest('hex')}`, from, to, text: text(size), attachments: [], sentAt: at, readAt: at });
    }
    const mailJson = JSON.stringify({ messages, cursors: Object.fromEntries(people.map((p) => [p, mails])), lastSeq: mails, v1Import: { at: iso(now - 864e5), sawV1: false, imported: 0, kept: 0, notes: [] } });
    writeFileSync(join(runtime, 'inbox', 'mail.json'), mailJson);
    bytes.mail = Buffer.byteLength(mailJson);

    // ATTENTION: the open questions (each dismissal in the soak changes them), and the history of handoffs and decided ones.
    const question = (i) => ({ header: `Q${i}`, question: text(400 + Math.floor(rand() * 800)), options: [{ label: 'Yes', description: text(80) }, { label: 'No', description: text(80) }, { label: 'Later', description: text(60) }] });
    const pending = Array.from({ length: o.pending ?? 240 }, (_, i) => {
        const a = agents[i % agents.length];
        return { id: `q_${createHash('md5').update(`q${i}`).digest('hex').slice(0, 12)}`, key: `k${i}`, agentId: a.id, agentName: a.name, workspaceId: 'soak', questions: [question(i), question(i + 1)], priority: 'normal', askedAt: iso(now - (i + 1) * 30_000) };
    });
    const finished = [];
    for (const a of agents) for (let j = 0; j < 20; j += 1) finished.push({ id: `f_${a.name}_${j}`, agentId: a.id, agentName: a.name, handoff: text(2000 + Math.floor(rand() * 6000)), at: iso(now - j * 600_000 - Math.floor(rand() * 60_000)) });
    const asked = Array.from({ length: 413 }, (_, i) => {
        const a = agents[i % agents.length];
        return { id: `qa_${i}`, agentId: a.id, agentName: a.name, askedAt: iso(now - i * 900_000), at: iso(now - i * 900_000 + 60_000), outcome: 'answered', questions: [question(i)], selections: [['Yes']], notes: [''], note: '' };
    });
    const attentionJson = JSON.stringify({ lists: [], questions: pending });
    const historyJson = JSON.stringify({ finished, asked });
    writeFileSync(join(runtime, 'attention.json'), attentionJson);
    writeFileSync(join(runtime, 'attention-history.json'), historyJson);
    bytes.attention = Buffer.byteLength(attentionJson);
    bytes.attentionHistory = Buffer.byteLength(historyJson);
    writeFileSync(join(runtime, 'interrupted-at-quit.json'), JSON.stringify(busy));
    return { agents: agents.slice(0, threadAgents).map((a) => ({ id: a.id, name: a.name })), busy, bytes };
}
