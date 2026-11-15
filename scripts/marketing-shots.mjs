#!/usr/bin/env node
/**
 * MARKETING SCREENSHOTS OF THE BUILT APP (Tynn #737, the tynn.ai/genie page): fresh PNGs of Genie 2 as it is now, taken in a
 * real window on a TEST MACHINE, never a desktop.
 *
 *   xvfb-run --server-args='-screen 0 1920x1080x24' node scripts/marketing-shots.mjs [out-dir]     (the Azure queue job does this)
 *
 * It reuses the CI rows' harness and invents no new one: the built Electron app, driven over the Chrome DevTools Protocol
 * (scripts/smoke-cdp.mjs, browser-process-cdp.mjs), with a home folder of its own, the seed written as the app's own state
 * files (the way scripts/smoke-seed.mjs does), `window.genieTest` for actions, and scripts/stub-codex.mjs as the provider
 * binary, so no provider login exists or is needed. What is on screen is the shipping code; only the people, the
 * workspaces and the provider are made up.
 *
 * THE DEMO, all of it neutral (no real person's name anywhere): three workspaces (atlas-web, orbit-api, lumen-docs), each with
 * a hosted site; six agents on the stub provider in the states a person sees on a working day:
 *   meridian, sable   working   (the stub's ticker mode: a turn that streams for ever)
 *   ember             waiting   (a real parked approval: the stub asks a question and nobody answers)
 *   vesper            idle      (a turn that finished a minute ago, with a reply that has a code block, a table and a result card)
 *   quill, cobalt     sleeping  (a turn finished and five minutes of idle passed: core/agent-status.ts SLEEPING_AFTER_IDLE_MS)
 * and one flow running (a Wait step), which is the Deck's "1 flow running" signal.
 *
 * SHOTS, 1600x1000: 01-dashboard-dark, 02-dashboard-light, 03-deck-questions-dark, 04-header-flow-pill-dark (the header and
 * signal strip, cropped), 05-hosting-dark, 06-toolchain-dark, 07-workspace-chat-dark. Written to the out dir, with
 * shots.json: what each view held when it was taken, so a shot of an empty view is said and not mistaken for a good one.
 *
 * Exit 0 when every shot was written; 1 when one could not be; 2 cannot run here. The run takes about nine minutes, five of
 * them the wait that makes two agents sleep.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GENIE_PAGE_PROBE ??= '1';
if (process.env.CI !== 'true' && process.env.GENIE_TEST_MACHINE !== '1') { console.error('refused: this launches Electron, and runs only on CI or a test machine'); process.exit(2); }
if (process.platform !== 'linux') { console.error('Linux only'); process.exit(2); }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'ci-out', 'marketing-shots'));
const PORT = Number(process.env.SHOTS_CDP_PORT ?? 9355);
const WIDTH = 1600;
const HEIGHT = 1000;
// core/agent-status.ts SLEEPING_AFTER_IDLE_MS, and the margin that covers the cooling second and the display's own tick.
const SLEEP_AFTER_MS = 5 * 60_000 + 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
mkdirSync(OUT, { recursive: true });

// ---- the seed: a home of its own, written as the app's own state files ------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'marketing-shots-'));
const home = join(root, 'home');
const data = join(root, 'user-data');
const genieHome = join(home, '.genie');
const runtime = join(genieHome, 'runtime');
mkdirSync(runtime, { recursive: true });
mkdirSync(data, { recursive: true });

const WORKSPACES = [
    { id: 'atlasweb', name: 'atlas-web', site: 'atlas-web.gen', title: 'Atlas', blurb: 'The storefront' },
    { id: 'orbitapi', name: 'orbit-api', site: 'orbit-api.gen', title: 'Orbit API', blurb: 'Orders and inventory' },
    { id: 'lumendocs', name: 'lumen-docs', site: 'lumen-docs.gen', title: 'Lumen Docs', blurb: 'Guides and reference' },
];
const hex = (n) => String(n).padStart(2, '0').repeat(16);
const AGENTS = [
    { key: 'meridian', ws: 'atlasweb', state: 'working', plan: [['Profile the checkout bundle', 'completed'], ['Split the cart route', 'in_progress'], ['Re-run the lighthouse pass', 'pending']] },
    { key: 'quill', ws: 'atlasweb', state: 'sleeping', plan: null },
    { key: 'sable', ws: 'orbitapi', state: 'working', plan: [['Read the rate-limit brief', 'completed'], ['Add the token bucket', 'in_progress'], ['Cover it with tests', 'pending']] },
    { key: 'ember', ws: 'orbitapi', state: 'waiting', plan: null },
    { key: 'vesper', ws: 'lumendocs', state: 'idle', plan: null },
    { key: 'cobalt', ws: 'lumendocs', state: 'sleeping', plan: null },
].map((a, i) => ({ ...a, id: `agent_${hex(0xa1 + i)}` }));
const by = (key) => AGENTS.find((a) => a.key === key);

// One small server per site, so each hosted site points at something that answers.
const siteServers = [];
for (const w of WORKSPACES) {
    const server = createServer((_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><title>${w.title}</title><body style="font-family:system-ui;margin:3rem"><h1>${w.title}</h1><p>${w.blurb}</p>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    server.unref();
    siteServers.push(server);
    w.port = server.address().port;
}

const wsPaths = {};
for (const w of WORKSPACES) {
    const path = join(root, 'work', w.name);
    mkdirSync(path, { recursive: true });
    wsPaths[w.id] = path;
    writeFileSync(join(path, 'project.json'), `${JSON.stringify({
        name: w.name,
        sites: { [`${w.id}site`.padEnd(18, 'a').slice(0, 18)]: { repo: '', runMode: 'host', kind: 'http', enabled: true, name: w.name, genName: w.site, hostPort: w.port } },
    }, null, 2)}\n`);
}
writeFileSync(join(runtime, 'workspaces.json'), JSON.stringify(WORKSPACES.map((w) => ({ id: w.id, path: wsPaths[w.id] })), null, 2));
const now = new Date().toISOString();
writeFileSync(join(runtime, 'agents.json'), JSON.stringify(AGENTS.map((a) => ({
    id: a.id, workspaceId: a.ws, provider: 'codex', name: a.key, instructions: null, threadId: null,
    createdAt: now, lastUsedAt: null, mode: 'manual', accessScope: 'none',
    ...(a.plan ? { plan: a.plan.map(([content, status]) => ({ content, status })) } : {}),
})), null, 2));
// The theme setting is a top-level key of settings.json (main/settings-store.ts); dark first, light is set by the run.
writeFileSync(join(runtime, 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));

// The provider is the stub codex the CI rows use; Genie finds it the way it finds any install (GENIE2_CODEX_BINARY).
const stub = join(ROOT, 'scripts', 'stub-codex.mjs');
chmodSync(stub, 0o755);
// Stub-codex reads these in the temp dir: the ticker marker (a LIVE pid) makes a spawned stub stream for ever, the release file lets
// a held reply finish. Both are named by that script, and not imported (importing it would run it).
const TICKER = join(tmpdir(), 'genie-stub-codex-ticker');
const RELEASE = join(tmpdir(), 'genie-stub-codex-stream-release');
rmSync(TICKER, { force: true });
rmSync(RELEASE, { force: true });

// ---- the app ------------------------------------------------------------------------------------------------------------

class Cdp {
    #socket; #next = 1; #pending = new Map();
    static async connect(url) {
        const cdp = new Cdp();
        cdp.#socket = new WebSocket(url);
        cdp.#socket.addEventListener('message', (event) => { const frame = JSON.parse(event.data); const done = cdp.#pending.get(frame.id); if (typeof done === 'function') { cdp.#pending.delete(frame.id); done(frame); } });
        await new Promise((resolveOpen, reject) => { cdp.#socket.addEventListener('open', resolveOpen, { once: true }); cdp.#socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true }); });
        return cdp;
    }
    send(method, params = {}) { const id = this.#next++; return new Promise((r) => { this.#pending.set(id, r); this.#socket.send(JSON.stringify({ id, method, params })); }); }
    async evaluate(expression) {
        const frame = await Promise.race([this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(30_000).then(() => { throw new Error(`no answer in 30 s: ${expression.slice(0, 80)}`); })]);
        if (frame.error) throw new Error(`CDP error: ${JSON.stringify(frame.error)}`);
        if (frame.result?.exceptionDetails) throw new Error(`page threw: ${frame.result.exceptionDetails.exception?.description ?? 'unknown'}`);
        return frame.result?.result?.value;
    }
    close() { this.#socket.close(); }
}

const nodeDir = dirname(process.execPath);
const env = {
    ...process.env,
    HOME: home, USERPROFILE: home, GENIE_HOME: genieHome,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    GENIE2_CODEX_BINARY: stub, GENIE_PAGE_PROBE: '1',
    // Node first, so the stub's `#!/usr/bin/env node` finds the real binary and not a version manager's shim.
    PATH: `${nodeDir}:${process.env.PATH ?? ''}`,
};
const electron = createRequire(import.meta.url)('electron');
const logFile = join(OUT, 'electron.log');
const logFd = openSync(logFile, 'a');
const app = spawn(electron, ['.', '--no-sandbox', '--password-store=basic', `--remote-debugging-port=${PORT}`, `--user-data-dir=${data}`], { cwd: ROOT, env, stdio: ['ignore', logFd, logFd], detached: true });

const processes = () => (spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(' '); return { pid: Number(l.slice(0, i)), args: l.slice(i + 1) }; });
function endEverything() {
    rmSync(TICKER, { force: true });
    let hostPid = null;
    try { hostPid = JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')).pid; } catch { /* none */ }
    for (const p of processes()) if (p.args.includes(data) || p.args.includes(genieHome) || p.pid === hostPid) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ }
}
const finish = (code) => { endEverything(); process.exit(code); };
setTimeout(() => { say('FAIL the run\'s own deadline, 25 minutes'); finish(1); }, 25 * 60_000).unref?.();

const report = { width: WIDTH, height: HEIGHT, shots: [], notes: [] };
const note = (text) => { say(`NOTE ${text}`); report.notes.push(text); };

let cdp;
const ev = (expression) => cdp.evaluate(expression);
async function waitFor(label, expression, ms = 30_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        try { if (await ev(expression)) return true; } catch { /* the page may have no document yet */ }
        await sleep(300);
    }
    note(`timed out waiting for ${label}`);
    return false;
}
const go = (route) => ev(`window.location.hash = ${JSON.stringify(`#${route}`)}; true`);
const act = (action) => ev(`(window.genieTest ?? window.genie).features.act(${JSON.stringify(action)}).then((r) => JSON.stringify(r ?? null))`);
const detail = async (id) => JSON.parse(await ev(`window.genieTest.agentDetail(${JSON.stringify(id)}).then((d) => JSON.stringify({ running: d?.session?.running ?? null, turnState: d?.session?.turnState ?? null, approval: Boolean(d?.session?.pendingApproval), failure: d?.session?.failure ?? null }))`));

// The window: 1600x1000 of page, as asked. The window itself first; where this display cannot give that, the page's own metrics.
async function sizeWindow() {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = mainWindow(t);
    const browser = await Cdp.connect((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
    const w = await browser.send('Browser.getWindowForTarget', { targetId: page.id });
    if (w.result?.windowId) await browser.send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'normal', left: 0, top: 0, width: WIDTH, height: HEIGHT } });
    browser.close();
    await sleep(1500);
    const inner = JSON.parse(await ev('JSON.stringify({ w: window.innerWidth, h: window.innerHeight })'));
    if (inner.w !== WIDTH || inner.h !== HEIGHT) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
        note(`the window's page was ${inner.w}x${inner.h}; the page's metrics were set to ${WIDTH}x${HEIGHT}`);
    }
}

async function shot(name, what, clip) {
    await sleep(2500); // a render and its transitions settle; a fixed wait is a guess, so each shot also records what it held
    const held = await ev(`JSON.stringify({ route: document.querySelector('[data-route]')?.textContent ?? null, dark: document.documentElement.classList.contains('dark'),
        agentRows: document.querySelectorAll('[data-agent]').length, states: [...document.querySelectorAll('[data-agent][data-state]')].map((r) => (r.querySelector('span.font-medium')?.textContent ?? r.getAttribute('data-agent')).trim() + ':' + r.getAttribute('data-state')),
        signals: [...document.querySelectorAll('[data-signal]')].map((s) => s.textContent.trim()), deckItems: document.querySelectorAll('[data-deck-item]').length })`);
    const params = { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) };
    const r = await cdp.send('Page.captureScreenshot', params);
    if (!r.result?.data) { note(`${name}: no image came back: ${JSON.stringify(r.error ?? r)}`); report.shots.push({ name, ok: false, what, held: JSON.parse(held) }); return; }
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    report.shots.push({ name, ok: true, what, held: JSON.parse(held) });
    say(`shot ${name}: ${held}`);
}

async function setTheme(theme) {
    await act({ kind: 'settings.set', key: 'theme', value: theme });
    await waitFor(`the ${theme} theme`, `document.documentElement.classList.contains('dark') === ${theme === 'dark'}`, 15_000);
}

/** Start an agent's session on the stub and send it a prompt; false (and a note) when it did not come up. */
async function startAndPrompt(agent, text) {
    await ev(`window.genieTest.agents.restart(${JSON.stringify(agent.id)}, 'graceful').then((r) => JSON.stringify(r))`);
    const up = await waitFor(`${agent.key}'s session`, `window.genieTest.agentDetail(${JSON.stringify(agent.id)}).then((d) => d?.session?.running === true)`, 60_000);
    if (!up) { note(`${agent.key}: ${JSON.stringify(await detail(agent.id))}`); return false; }
    const sent = await ev(`window.genieTest.prompt(${JSON.stringify(agent.id)}, ${JSON.stringify(text)}).then((r) => JSON.stringify(r))`);
    say(`${agent.key} prompted: ${sent}`);
    return true;
}

/** Answer the stub's parked approval with the allow option, as a person would on the agent's page, then let its reply finish. */
async function approveAndFinish(agent) {
    await go(`genie://agent/${agent.id}?tab=stream`);
    if (!await waitFor(`${agent.key}'s approval card`, `Boolean(document.querySelector('[data-approval-option][data-tone="ok"]'))`, 60_000)) { note(`${agent.key}: ${JSON.stringify(await detail(agent.id))}`); return false; }
    await ev(`document.querySelector('[data-approval-option][data-tone="ok"]').click(); true`);
    await sleep(2500);
    writeFileSync(RELEASE, '');
    const idle = await waitFor(`${agent.key} to finish its turn`, `window.genieTest.agentDetail(${JSON.stringify(agent.id)}).then((d) => d?.session?.turnState === 'idle')`, 90_000);
    rmSync(RELEASE, { force: true });
    if (!idle) note(`${agent.key}: ${JSON.stringify(await detail(agent.id))}`);
    return idle;
}

let failed = false;
try {
    const page = await (async () => { const until = Date.now() + 90_000; while (Date.now() < until) { try { const p = mainWindow(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()); if (p) return p; } catch { /* not up */ } await sleep(500); } return null; })();
    if (!page) throw new Error('the Electron window never appeared on its debugger port');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitForPageProbe(cdp);
    await waitFor('the Dashboard', `Boolean(document.querySelector('[data-surface="dashboard"]'))`, 60_000);
    await sizeWindow();
    say(`the app is up; ${WORKSPACES.length} workspaces and ${AGENTS.length} agents seeded under ${root}`);

    // 1. THE WORKING AGENTS FIRST, while the ticker marker names this live pid: a stub spawned now streams for ever.
    writeFileSync(TICKER, String(process.pid));
    for (const key of ['meridian', 'sable']) await startAndPrompt(by(key), 'keep going with the plan');
    await waitFor('both working agents to stream', `Promise.all([${['meridian', 'sable'].map((k) => `window.genieTest.agentDetail(${JSON.stringify(by(k).id)}).then((d) => d?.session?.turnState !== 'idle' && d?.session?.running === true)`).join(', ')}]).then((a) => a.every(Boolean))`, 60_000);
    rmSync(TICKER, { force: true }); // every stub from here on is an ordinary one

    // 2. THE QUESTION: the stub asks, and nobody answers.
    await startAndPrompt(by('ember'), 'run the migration');
    await waitFor('ember\'s approval to park', `window.genieTest.snapshot().then((s) => (s.deckItems ?? []).some((i) => i.agentId === ${JSON.stringify(by('ember').id)} && i.source === 'agent-question'))`, 60_000);

    // 3. THE SLEEPERS: a turn, answered, finished. Five minutes of idle makes them sleep.
    for (const key of ['quill', 'cobalt']) {
        if (await startAndPrompt(by(key), 'run the migration')) await approveAndFinish(by(key));
    }
    const sleepFrom = Date.now();

    // 4. THE FLOW: a Wait step, run now, running until the end. Its name and steps are plain.
    const saved = JSON.parse(await act({
        kind: 'flows.saveGraph', workspaceId: 'orbitapi', name: 'Weekly digest',
        document: { $schema: 'https://particle.academy/schemas/workflow/v1.json', version: 1, graph: {
            nodes: [
                { id: 'trigger', kind: '@particle-academy/manual_trigger', position: { x: 0, y: 0 }, config: {} },
                { id: 'pause', kind: '@particle-academy/wait', position: { x: 240, y: 0 }, config: { mode: 'duration', duration: '2h' } },
                { id: 'say', kind: '@particle-academy/log', position: { x: 480, y: 0 }, config: { level: 'info', message: 'digest sent' } },
            ],
            edges: [{ id: 'trigger-pause', source: 'trigger', target: 'pause' }, { id: 'pause-say', source: 'pause', target: 'say' }],
        } },
    }) ?? 'null');
    const flowId = saved?.flows?.saved?.flowId ?? null;
    if (flowId) { await act({ kind: 'flows.runNow', flowId }); say(`flow ${flowId} running`); }
    else note(`the flow was not saved: ${JSON.stringify(saved).slice(0, 300)}`);

    // 5. THE SITES: started, as a person presses Start.
    const sites = JSON.parse(await ev(`(window.genieTest ?? window.genie).features.snapshot().then((d) => JSON.stringify((d.hosting?.sites ?? []).map((s) => ({ id: s.id, host: s.host }))))`) ?? '[]');
    for (const s of sites) await act({ kind: 'hosting.startSite', siteId: s.id }).catch((e) => note(`start ${s.host}: ${e}`));
    say(`sites: ${JSON.stringify(sites)}`);

    // 6. THE WAIT that makes two agents sleep. The idle agent's turn comes after it, so it is idle and not asleep.
    const left = SLEEP_AFTER_MS - (Date.now() - sleepFrom);
    say(`waiting ${Math.round(left / 1000)} s for quill and cobalt to sleep`);
    if (left > 0) await sleep(left);
    if (await startAndPrompt(by('vesper'), 'run the migration')) await approveAndFinish(by('vesper'));
    await sleep(20_000); // past the 15 s "cooling" after a clean turn: Idle, not Cooling

    // ---- the shots ----------------------------------------------------------------------------------------------------
    await go('genie://dashboard');
    await waitFor('the Dashboard', `document.querySelectorAll('[data-surface="dashboard"] [data-agent]').length >= 4`, 30_000);
    await shot('01-dashboard-dark', 'The Genie Dashboard: three workspaces, six agents working, waiting, idle and sleeping');

    await setTheme('light');
    await shot('02-dashboard-light', 'The same Dashboard in the light theme');
    await setTheme('dark');

    await go('genie://deck');
    await waitFor('the Deck', `Boolean(document.querySelector('[data-surface="deck"]'))`, 30_000);
    await shot('03-deck-questions-dark', 'The Deck: the agent\'s pending question to answer, and the running-flow signal');
    await shot('04-header-flow-pill-dark', 'The header and signal strip with the running-flow pill (cropped to the top)', { x: 0, y: 0, width: WIDTH, height: 180 });

    await go('genie://hosting');
    await waitFor('Hosting', `Boolean(document.querySelector('[data-surface="hosting"]'))`, 30_000);
    await sleep(3000);
    await shot('05-hosting-dark', 'Hosting: the three workspaces\' sites');

    await go('genie://settings/toolchain');
    await waitFor('Toolchain settings', `Boolean(document.querySelector('[data-surface="settings"]'))`, 30_000);
    await sleep(4000);
    await shot('06-toolchain-dark', 'Settings, Toolchain: the language toolchains');

    // The chat last: a row click pins the agent's chat beside the page and it stays (genie#1209, #639).
    await go('genie://dashboard');
    await waitFor('the Dashboard', `Boolean(document.querySelector('[data-surface="dashboard"] [data-agent="${by('vesper').id}"]'))`, 30_000);
    await ev(`document.querySelector('[data-surface="dashboard"] [data-agent="${by('vesper').id}"]').click(); true`);
    await waitFor('vesper\'s chat', `Boolean(document.querySelector('[data-chat="pinned"][data-chat-subject="${by('vesper').id}"]'))`, 30_000);
    await go('genie://workspace/lumendocs');
    await waitFor('the workspace dashboard', `Boolean(document.querySelector('[data-surface="workspace"], [data-surface="dashboard"]')) && Boolean(document.querySelector('[data-chat-subject="${by('vesper').id}"]'))`, 30_000);
    await shot('07-workspace-chat-dark', 'A workspace dashboard (lumen-docs) with its agent\'s chat: a reply with a code block, a table and a result card');
} catch (error) {
    failed = true;
    say(`FAIL ${error?.stack ?? error}`);
    report.error = String(error?.message ?? error);
}

writeFileSync(join(OUT, 'shots.json'), `${JSON.stringify(report, null, 2)}\n`);
const written = report.shots.filter((s) => s.ok).length;
say(`${written} of 7 shots written to ${OUT}`);
finish(failed || written < 7 ? 1 : 0);
