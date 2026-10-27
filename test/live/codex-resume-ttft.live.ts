/**
 * A RESUMED CODEX AGENT: HOW LONG UNTIL ITS FIRST TURN, AND DOES IT STILL KNOW ITS CONVERSATION?
 *
 * prism-acp 0.31.0 lets Genie resume Codex without paging the thread's history (`replayHistory: false`). This measures
 * both claims against the REAL `codex app-server`, through the REAL CodexDriver, with Genie's own options
 * (`codexOptionsFor`), before and after:
 *
 *   1. TIME TO FIRST TURN. A thread with TTFT_TURNS turns is resumed with replay on (prism-acp's default, what Genie
 *      did before) and off (what Genie does now), alternately, TTFT_ROUNDS times each. Measured: start -> `ready`, and
 *      start -> the end of the first turn.
 *   2. CONTEXT. The thread's FIRST prompt holds a random code word. After a resume with replay off, the first model
 *      request Codex sends must hold it (the conversation is in the request, not merely in Genie's ledger). NEGATIVE
 *      CONTROL: a fresh thread's first request must NOT — otherwise "it is in the request" proves nothing.
 *
 * The model is a local stand-in for the Responses API (no account, no tokens): Codex is pointed at it through its
 * documented `model_providers` config, under a throwaway CODEX_HOME. Every request body it receives is kept, which is how
 * (2) is seen from the client's side rather than inferred.
 *
 * Run ONLY in a test VM: `npx tsx test/live/codex-resume-ttft.live.ts` (needs `codex` on PATH, or GENIE2_CODEX_BINARY).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexDriver, META_REPLAY } from '@particle-academy/prism-acp';
import type { AgentRecord } from '../../src/core/identity.js';
import { codexOptionsFor } from '../../src/main/session-host.js';

const CODEX = process.env['GENIE2_CODEX_BINARY'] ?? 'codex';
const TURNS = Number(process.env['TTFT_TURNS'] ?? 150);
const ROUNDS = Number(process.env['TTFT_ROUNDS'] ?? 3);

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

// ---- the stand-in model: the Responses API's streaming shape, one assistant message per request ----
const bodies: string[] = [];
let served = 0;
function sse(res: ServerResponse, text: string): void {
    served += 1;
    const id = `resp_${served}`;
    const event = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    event('response.created', { response: { id } });
    // A reasoning item as well as the reply: a real thread's turns hold several items each, and the replay pages items.
    event('response.output_item.done', { item: { type: 'reasoning', id: `rs_${served}`, summary: [{ type: 'summary_text', text: `thinking about turn ${served}` }] } });
    event('response.output_item.done', { item: { type: 'message', role: 'assistant', id: `msg_${served}`, content: [{ type: 'output_text', text }] } });
    event('response.completed', { response: { id, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 } } });
    res.end();
}
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
        if (req.method === 'POST' && (req.url ?? '').includes('/responses')) { bodies.push(body); sse(res, `ok ${served + 1}`); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [], models: [] }));
    });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

const home = mkdtempSync(join(tmpdir(), 'genie-ttft-home-'));
const project = mkdtempSync(join(tmpdir(), 'genie-ttft-proj-'));
writeFileSync(join(home, 'config.toml'), [
    'model = "stand-in"',
    'model_provider = "standin"',
    '[model_providers.standin]',
    'name = "stand-in"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
].join('\n'));
const launch = { binary: CODEX, parentEnv: { ...process.env, CODEX_HOME: home } };
const record = { id: 'ag_ttft', name: 'ttft', provider: 'codex', workspaceId: 'w', permissions: 'all', model: null } as unknown as AgentRecord;

interface Run { driver: CodexDriver; replayed: number; turnEnds: number; problems: string[] }
function open(options: ConstructorParameters<typeof CodexDriver>[0]): Run {
    const run: Run = { driver: null as unknown as CodexDriver, replayed: 0, turnEnds: 0, problems: [] };
    run.driver = new CodexDriver(options, {
        onUpdate: (u) => {
            const meta = (u as { _meta?: Record<string, unknown> })._meta;
            if (meta && meta[META_REPLAY] === true) run.replayed += 1;
        },
        onTurnEnd: () => { run.turnEnds += 1; },
        onProtocolError: (p) => { run.problems.push(p); },
    });
    return run;
}
async function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
}
async function turn(run: Run, text: string): Promise<void> {
    const before = run.turnEnds;
    run.driver.prompt(text);
    await until(() => run.turnEnds > before, 60_000, `the end of turn "${text.slice(0, 30)}"`);
}

try {
    // ---- the thread: TURNS turns, the first one holding the code word ----
    const word = `kestrel-${randomUUID().slice(0, 8)}`;
    const seed = open({ ...launch, cwd: project });
    seed.driver.start();
    await seed.driver.ready;
    await turn(seed, `Remember this code word: ${word}.`);
    for (let i = 2; i <= TURNS; i += 1) await turn(seed, `Turn ${i}: carry on.`);
    const threadId = seed.driver.cliSessionId;
    seed.driver.kill();
    check(typeof threadId === 'string' && threadId.length > 0, `a ${TURNS}-turn thread exists`, String(threadId));
    if (!threadId) throw new Error('no thread id');
    await new Promise((r) => setTimeout(r, 500));

    // ---- time to first turn: replay ON (before) vs OFF (Genie now), alternating ----
    const modes = {
        before: () => ({ ...codexOptionsFor(record, project, threadId, []), replayHistory: true, ...launch }),
        now: () => ({ ...codexOptionsFor(record, project, threadId, []), ...launch }),
    } as const;
    const times: Record<keyof typeof modes, { ready: number[]; firstTurn: number[]; replayed: number[] }> = {
        before: { ready: [], firstTurn: [], replayed: [] }, now: { ready: [], firstTurn: [], replayed: [] },
    };
    let contextKept = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
        for (const mode of ['before', 'now'] as const) {
            const run = open(modes[mode]());
            const t0 = performance.now();
            run.driver.start();
            await run.driver.ready;
            const tReady = performance.now();
            const sent = bodies.length;
            await turn(run, 'What was the code word?');
            const tTurn = performance.now();
            run.driver.kill();
            await new Promise((r) => setTimeout(r, 300));
            times[mode].ready.push(tReady - t0);
            times[mode].firstTurn.push(tTurn - t0);
            times[mode].replayed.push(run.replayed);
            const first = bodies[sent] ?? '';
            if (mode === 'now' && first.includes(word)) contextKept += 1;
            if (run.problems.length > 0) console.log(`  (${mode} round ${round + 1} protocol: ${run.problems.join(' | ')})`);
            console.log(`  ${mode.padEnd(6)} round ${round + 1}: ready ${Math.round(tReady - t0)} ms, first turn done ${Math.round(tTurn - t0)} ms, replayed updates ${run.replayed}, code word in its first request: ${first.includes(word)}`);
        }
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    console.log(`\n  MEDIAN replay on  (before): ready ${Math.round(median(times.before.ready))} ms, first turn ${Math.round(median(times.before.firstTurn))} ms`);
    console.log(`  MEDIAN replay off (now):    ready ${Math.round(median(times.now.ready))} ms, first turn ${Math.round(median(times.now.firstTurn))} ms\n`);

    check(times.before.replayed.every((n) => n > 0), 'CONTROL: replay on DOES replay this thread (the gauge can see a replay)', times.before.replayed.join(','));
    check(times.now.replayed.every((n) => n === 0), 'replay off: no replayed update reaches Genie', times.now.replayed.join(','));
    check(contextKept === ROUNDS, 'replay off: the code word from turn 1 is in the first model request after every resume', `${contextKept}/${ROUNDS}`);
    check(median(times.now.ready) < median(times.before.ready), 'replay off reaches ready sooner than replay on');

    // ---- NEGATIVE CONTROL: a fresh thread does not carry the code word ----
    const fresh = open({ ...codexOptionsFor(record, project, null, []), ...launch });
    fresh.driver.start();
    await fresh.driver.ready;
    const sent = bodies.length;
    await turn(fresh, 'What was the code word?');
    fresh.driver.kill();
    check(bodies[sent] !== undefined && !bodies[sent]!.includes(word), 'CONTROL: a FRESH thread’s first request does not hold the code word');
} catch (error) {
    failures.push(String(error));
    console.log(`  FAIL  ${String(error)}`);
} finally {
    server.close();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    try { rmSync(project, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
