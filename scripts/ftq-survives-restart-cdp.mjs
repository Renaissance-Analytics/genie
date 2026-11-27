#!/usr/bin/env node
/**
 * AN OPEN FORCETHEQUESTION WINDOW SURVIVES ITS AGENT'S RESTART (Tynn #1085), proven in a real window on a TEST MACHINE,
 * never a desktop.
 *
 *   node scripts/ftq-survives-restart-cdp.mjs [out-dir]   (the `ftq-survives-restart` row of linux.sh and windows.ps1; it refuses
 *                                                         anywhere but CI or a test machine)
 *
 * The owner, 2026-11-27: "I will have an FTQ window open and then suddenly it closes. I see it as 'stale' in the
 * dashboard." On his data every such close was a restart of the asking agent's session. This opens the built app on a
 * seeded workspace with one stub-codex agent (scripts/stub-codex.mjs, ASK MODE) whose turn asks a question through Genie's
 * own `ForceTheQuestion` MCP tool with the agent's own key — the path an agent's question takes — and ends. The question
 * window opens; a person starts answering (a real click on an option, a note typed). Then the agent is RESTARTED (the one
 * Restart): its old run ends and a new run starts after the ask. The window is still open, on the same question, unmarked,
 * with the option and the note as they were; and lifecycle.log has one more `agent run … why=restart` line for it.
 * Then the agent is REMOVED: the window still stays, now saying so, with "Answer anyway"; a click on it sends the answer
 * and the window closes.
 *
 * Out: 01-answering.png, 02-after-restart.png, 03-agent-removed.png (the question window each time), proof.json.
 * Exit 0 all proven; 1 a check failed; 2 cannot run here.
 */
import { isGeniePage, mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew } from './cdp-whats-new.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { endOwnRun } from './end-own-tree.mjs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GENIE_PAGE_PROBE ??= '1';
if (process.env.CI !== 'true' && process.env.GENIE_TEST_MACHINE !== '1') { console.error('refused: this launches Electron, and runs only on CI or a test machine'); process.exit(2); }
const WIN = process.platform === 'win32';
const RUN_BEGAN = Date.now();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'ci-out', 'ftq-survives-restart'));
const PORT = Number(process.env.FTQ_RESTART_CDP_PORT ?? 9371);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
mkdirSync(OUT, { recursive: true });

const root = mkdtempSync(join(tmpdir(), 'ftq-restart-'));
const home = join(root, 'home');
const data = join(root, 'user-data');
const genieHome = join(home, '.genie');
const runtime = join(genieHome, 'runtime');
mkdirSync(runtime, { recursive: true });
mkdirSync(data, { recursive: true });
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });

// THE SEED. Fixture names only (no person).
const WS = { id: 'orbitapi', name: 'orbit-api' };
const AGENT = { key: 'meridian', id: `agent_${'d2'.repeat(16)}` };
const wsPath = join(homedir(), 'projects', WS.name);
mkdirSync(wsPath, { recursive: true });
writeFileSync(join(wsPath, 'project.json'), `${JSON.stringify({ name: WS.name }, null, 2)}\n`);
writeFileSync(join(runtime, 'workspaces.json'), JSON.stringify([{ id: WS.id, path: wsPath }], null, 2));
writeFileSync(join(runtime, 'agents.json'), JSON.stringify([{
    id: AGENT.id, workspaceId: WS.id, provider: 'codex', name: AGENT.key, instructions: null, threadId: null,
    createdAt: new Date().toISOString(), lastUsedAt: null, mode: 'manual', accessScope: 'none',
}], null, 2));
writeFileSync(join(runtime, 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));

const QUESTIONS = [{
    header: 'Dev API',
    question: '## Which API should the dev build talk to?\n\nThe staging API has the new auth; the local mock is faster to iterate on.',
    options: [{ label: 'Staging', description: 'The shared staging API, new auth' }, { label: 'Local mock', description: 'The mock server in this repo' }],
}];
const NOTE = 'mock until Monday, then staging';
const stub = join(ROOT, 'scripts', 'stub-codex.mjs');
chmodSync(stub, 0o755);
const ASK_MARKER = join(tmpdir(), 'genie-stub-codex-ask');
for (const f of [ASK_MARKER, `${ASK_MARKER}.asked`, `${ASK_MARKER}.result`, join(tmpdir(), 'genie-stub-codex-plan'), join(tmpdir(), 'genie-stub-codex-ticker')]) rmSync(f, { force: true });

class Cdp {
    #socket; #next = 1; #pending = new Map();
    static async connect(url) {
        const cdp = new Cdp();
        cdp.#socket = new WebSocket(url);
        cdp.#socket.addEventListener('message', (event) => {
            const frame = JSON.parse(event.data);
            const done = cdp.#pending.get(frame.id);
            if (typeof done === 'function') { cdp.#pending.delete(frame.id); done(frame); }
        });
        await new Promise((resolveOpen, reject) => { cdp.#socket.addEventListener('open', resolveOpen, { once: true }); cdp.#socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true }); });
        return cdp;
    }
    send(method, params = {}, ms = 15_000) {
        const id = this.#next++;
        return new Promise((r, reject) => {
            const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`no answer to ${method} within ${ms} ms`)); }, ms);
            this.#pending.set(id, (frame) => { clearTimeout(timer); r(frame); });
            this.#socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const frame = await Promise.race([this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(30_000).then(() => { throw new Error(`no answer in 30 s: ${expression.slice(0, 80)}`); })]);
        if (frame.error) throw new Error(`CDP error: ${JSON.stringify(frame.error)}`);
        if (frame.result?.exceptionDetails) throw new Error(`page threw: ${frame.result.exceptionDetails.exception?.description ?? 'unknown'}`);
        return frame.result?.result?.value;
    }
    close() { try { this.#socket.close(); } catch { /* closed */ } }
}

const nodeDir = dirname(process.execPath);
const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, GENIE_HOME: genieHome,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    GENIE2_CODEX_BINARY: stub, GENIE_PAGE_PROBE: '1',
    PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ''}`,
};
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
const electron = createRequire(import.meta.url)('electron');
const logFd = openSync(join(OUT, 'electron.log'), 'a');
const app = spawn(electron, ['.', ...(WIN ? [] : ['--no-sandbox', '--password-store=basic']), `--remote-debugging-port=${PORT}`, `--user-data-dir=${data}`], { cwd: ROOT, env, stdio: ['ignore', logFd, logFd], detached: !WIN, windowsHide: false });

const processes = () => (WIN ? '' : spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(' '); return { pid: Number(l.slice(0, i)), args: l.slice(i + 1) }; });
async function endEverything() {
    let left = false;
    rmSync(ASK_MARKER, { force: true });
    let hostPid = null;
    try { hostPid = JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')).pid; } catch { /* none */ }
    for (const p of processes()) if (p.args.includes(data) || p.args.includes(genieHome) || p.pid === hostPid) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (WIN) {
        const ended = await endOwnRun({ app, hostPid, since: RUN_BEGAN, log: say });
        if (!ended.ok) { left = true; say(`FAIL LEFT RUNNING by this row's own cleanup: ${ended.words}`); }
    } else {
        try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* the VM is deleted anyway */ }
    return left;
}
const finish = async (code) => { const left = await endEverything(); process.exit(left ? 1 : code); };
setTimeout(() => { say('FAIL the run\'s own deadline, 10 minutes'); finish(1); }, 10 * 60_000).unref?.();

const proof = { checks: [], notes: [], seen: {} };
const check = (name, ok, detail) => { proof.checks.push({ name, ok: Boolean(ok), detail }); say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); return Boolean(ok); };

let main;
let ask;
async function waitOn(cdp, label, expression, ms = 30_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        try { if (await cdp.evaluate(expression)) return true; } catch { /* no document yet */ }
        await sleep(300);
    }
    proof.notes.push(`timed out waiting for ${label}`);
    say(`NOTE timed out waiting for ${label}`);
    return false;
}
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
const questionTarget = async () => (await targets()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && isGeniePage(t.url, 'question')) ?? null;
async function shot(cdp, name) {
    await sleep(700);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) throw new Error(`${name}: no image came back`);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    say(`shot ${name}`);
}
async function click(cdp, selector) {
    const at = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return { x, y, reaches: Boolean(hit && (hit === el || el.contains(hit))) }; })()`);
    if (!at || !at.reaches) return false;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    return true;
}
/** What the question window shows now: which question, whether it says stale, the chosen option, the note, the answer button's words. */
const SEEN = `JSON.stringify({
  id: document.querySelector('[data-question-window]')?.getAttribute('data-question-window') ?? null,
  stale: document.querySelector('[data-question-stale]')?.getAttribute('data-question-stale') ?? null,
  notice: document.querySelector('[data-question-stale]')?.textContent ?? null,
  chosen: [...document.querySelectorAll('[data-question-option]')].filter((o) => o.querySelector('[data-on="true"]') || o.getAttribute('aria-checked') === 'true' || o.getAttribute('aria-pressed') === 'true').map((o) => o.getAttribute('data-question-option')),
  note: document.querySelector('[data-question-note="0"]')?.value ?? null,
  submit: document.querySelector('[data-action="deck-submit"]')?.textContent?.trim() ?? null,
})`;
/** This agent's run lines in lifecycle.log (core/start-why.ts `agentRunLine`). */
const runLines = () => { try { return readFileSync(join(runtime, 'lifecycle.log'), 'utf8').split('\n').filter((l) => l.includes(`agent run owner=${AGENT.id} `)); } catch { return []; } };
const detail = (expr) => main.evaluate(`window.genieTest.agentDetail(${JSON.stringify(AGENT.id)}).then((d) => ${expr})`);

let failed = false;
try {
    const page = await (async () => { const until = Date.now() + 90_000; while (Date.now() < until) { try { const p = mainWindow(await targets()); if (p) return p; } catch { /* not up */ } await sleep(500); } return null; })();
    if (!page) throw new Error('the Electron window never appeared on its debugger port');
    main = await Cdp.connect(page.webSocketDebuggerUrl);
    await main.send('Runtime.enable');
    await main.send('Page.enable');
    await waitForPageProbe(main);
    check('0. the app is up, on a seeded home of its own', await waitOn(main, 'the Dashboard', `Boolean(document.querySelector('[data-surface="dashboard"]'))`, 60_000));
    if (await waitOn(main, "the What's new window (if it shows)", `Boolean(document.querySelector('[data-action="whats-new-close"]'))`, 15_000)) {
        const closed = await closeWhatsNew((e) => main.evaluate(e));
        check("0b. the What's new window is closed with its Close button", closed.closed);
    }

    // THE ASK: the agent's turn calls ForceTheQuestion with its own key, and ends.
    writeFileSync(ASK_MARKER, JSON.stringify({ owner: process.pid, questions: QUESTIONS }));
    await main.evaluate(`window.genieTest.agents.restart(${JSON.stringify(AGENT.id)}, 'graceful').then((r) => JSON.stringify(r))`);
    await waitOn(main, `${AGENT.key}'s session`, `window.genieTest.agentDetail(${JSON.stringify(AGENT.id)}).then((d) => d?.session?.running === true)`, 60_000);
    await main.evaluate(`window.genieTest.prompt(${JSON.stringify(AGENT.id)}, 'ask me which API to use').then((r) => JSON.stringify(r))`);

    let qt = null;
    for (const until = Date.now() + 60_000; !qt && Date.now() < until;) { try { qt = await questionTarget(); } catch { /* not up */ } if (!qt) await sleep(500); }
    let result = '(the stub wrote nothing)';
    try { result = readFileSync(`${ASK_MARKER}.result`, 'utf8').trim(); } catch { /* none */ }
    proof.notes.push(`what Genie answered the stub's ForceTheQuestion: ${result}`);
    if (!check('1. the agent asked through ForceTheQuestion and the question window opened', qt !== null, result.slice(-300))) throw new Error('no question window');
    ask = await Cdp.connect(qt.webSocketDebuggerUrl);
    await ask.send('Runtime.enable');
    await ask.send('Page.enable');
    await ask.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    check('2. it shows the agent\'s question', await waitOn(ask, 'the question', `Boolean(document.querySelector('[data-question-option="Local mock"]'))`, 20_000));
    const questionId = JSON.parse(await ask.evaluate(SEEN)).id;

    // THE PERSON STARTS ANSWERING: a real click on an option, then a note typed into the first question's note.
    check('3. a click picks "Local mock"', await click(ask, '[data-question-option="Local mock"]'));
    check('4. a click goes into the note', await click(ask, '[data-question-note="0"]'));
    await ask.send('Input.insertText', { text: NOTE });
    await sleep(500);
    const before = JSON.parse(await ask.evaluate(SEEN));
    proof.seen.before = before;
    check('5. CONTROL: mid-answer — the option chosen and the note written, live (no stale notice), the button says Answer', before.chosen.includes('Local mock') && before.note === NOTE && before.stale === null && before.submit === 'Answer', before);
    const startedBefore = await detail('d?.session?.startedAt ?? null');
    const linesBefore = runLines();
    proof.seen.runLinesBefore = linesBefore;
    check('6. CONTROL: lifecycle.log already has a run line for its first start, with its reason', linesBefore.length >= 1 && /why=restart$/.test(linesBefore.at(-1) ?? ''), linesBefore);
    await shot(ask, '01-answering');

    // THE RESTART: the one Restart, as the Agent view's button calls it. A new run starts after the ask.
    const restarted = await main.evaluate(`window.genieTest.agents.restart(${JSON.stringify(AGENT.id)}, 'graceful').then((r) => JSON.stringify(r))`);
    const newRun = await waitOn(main, 'the new run', `window.genieTest.agentDetail(${JSON.stringify(AGENT.id)}).then((d) => d?.session?.running === true && (d?.session?.startedAt ?? 0) > ${Number(startedBefore ?? 0)})`, 60_000);
    const startedAfter = await detail('d?.session?.startedAt ?? null');
    check('7. the agent restarted: a new run, started after the question was asked', newRun && startedAfter > startedBefore, { restarted, startedBefore, startedAfter });
    await sleep(3_000);
    const stillThere = await questionTarget();
    const after = stillThere ? JSON.parse(await ask.evaluate(SEEN)) : null;
    proof.seen.after = after;
    check('8. the question window is STILL OPEN after the restart', stillThere !== null && stillThere.id === qt.id);
    check('9. on the same question, NOT marked stale, the button still Answer', after?.id === questionId && after?.stale === null && after?.submit === 'Answer', after);
    check('10. what the person had started is as it was: the option and the note', after?.chosen.includes('Local mock') && after?.note === NOTE, after);
    const linesAfter = runLines();
    proof.seen.runLinesAfter = linesAfter;
    check('11. lifecycle.log has ONE more run line for the agent, naming why: restart', linesAfter.length === linesBefore.length + 1 && /run=\d+ why=restart$/.test(linesAfter.at(-1) ?? ''), linesAfter.slice(-2));
    await shot(ask, '02-after-restart');

    // THE AGENT REMOVED: the one real stale. The window stays on it, says so, and offers Answer anyway.
    const removed = await main.evaluate(`window.genieTest.agents.delete(${JSON.stringify(AGENT.id)}, 'delete', []).then((r) => JSON.stringify(r))`);
    proof.notes.push(`delete: ${removed}`);
    const marked = await waitOn(ask, 'the stale notice', `document.querySelector('[data-question-stale]')?.getAttribute('data-question-stale') === 'agent-gone'`, 30_000);
    const gone = JSON.parse(await ask.evaluate(SEEN));
    proof.seen.removed = gone;
    check('12. its agent removed: the window is still open on the question, saying the agent is gone', marked && (await questionTarget()) !== null && gone.id === questionId && /no longer in this workspace/.test(gone.notice ?? ''), gone);
    check('13. the draft is still there, and the button says Answer anyway', gone.chosen.includes('Local mock') && gone.note === NOTE && gone.submit === 'Answer anyway', gone);
    await shot(ask, '03-agent-removed');
    check('14. Answer anyway takes a click', await click(ask, '[data-action="deck-submit"]'));
    let closed = false;
    for (const until = Date.now() + 20_000; !closed && Date.now() < until;) { closed = (await questionTarget()) === null; if (!closed) await sleep(300); }
    check('15. the answer was sent and, with none left, the window closed', closed);
} catch (error) {
    failed = true;
    say(`FAIL ${error?.stack ?? error}`);
    proof.error = String(error?.message ?? error);
    for (const [c, n] of [[ask, '99-failed-question'], [main, '99-failed-main']]) { try { if (c) await shot(c, n); } catch { /* no window */ } }
    try { if (existsSync(`${ASK_MARKER}.result`)) proof.notes.push(readFileSync(`${ASK_MARKER}.result`, 'utf8')); } catch { /* none */ }
}
for (const c of [ask, main]) c?.close();
proof.ok = !failed && proof.checks.every((c) => c.ok);
writeFileSync(join(OUT, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
say(proof.ok ? 'ALL PROVEN' : `NOT PROVEN: ${proof.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || proof.error}`);
await finish(proof.ok ? 0 : 1);
