#!/usr/bin/env node
/**
 * VISUAL PROOF OF THE ONE BAR (Tynn #842), taken in a real window on a TEST MACHINE, never a desktop.
 *
 *   node scripts/one-bar-proof.mjs [out-dir]     (the Azure queue job does this; it refuses anywhere else)
 *
 * The owner on beta.64: "you still have two different workspace views happening. agents should not have a different header
 * UX than workspaces, the only difference is the main content. I prefer the tabs along the top layout." This opens the built
 * app on a seeded workspace with three stub agents, one of them mid-turn (the stub's ticker mode), and frames the workspace's
 * Dashboard and that agent's Stream at 1600px and at 1024px. It measures, from the DOM, where each view's content starts
 * (the chrome above it), the bar's height, how many bars there are, and whether anything of the old rows is left.
 *
 * Out: 01-workspace-1600.png, 02-agent-1600.png, 03-workspace-1024.png, 04-agent-1024.png, proof.json. The same script run
 * over the code before the change frames the old layout, for the before/after; its checks fail there, by design.
 * Exit 0 all proven; 1 a check failed; 2 cannot run here.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { waitForPageProbe } from './page-probe-cdp.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.GENIE_PAGE_PROBE ??= '1';
if (process.env.CI !== 'true' && process.env.GENIE_TEST_MACHINE !== '1') { console.error('refused: this launches Electron, and runs only on CI or a test machine'); process.exit(2); }
if (process.platform !== 'linux') { console.error('Linux only'); process.exit(2); }

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] ?? join(ROOT, 'ci-out', 'one-bar'));
const PORT = Number(process.env.ONE_BAR_CDP_PORT ?? 9357);
const WIDTH = 1600;
const HEIGHT = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
mkdirSync(OUT, { recursive: true });

const root = mkdtempSync(join(tmpdir(), 'one-bar-'));
const home = join(root, 'home');
const data = join(root, 'user-data');
const genieHome = join(home, '.genie');
const runtime = join(genieHome, 'runtime');
mkdirSync(runtime, { recursive: true });
mkdirSync(data, { recursive: true });

const WS = { id: 'orbitapi', name: 'orbit-api' };
const hex = (n) => n.toString(16).padStart(2, '0').repeat(16);
const AGENTS = ['meridian', 'quill', 'sable'].map((key, i) => ({ key, id: `agent_${hex(0xc1 + i)}` }));
const wsPath = join(homedir(), 'projects', WS.name);
mkdirSync(wsPath, { recursive: true });
writeFileSync(join(wsPath, 'project.json'), `${JSON.stringify({ name: WS.name }, null, 2)}\n`);
writeFileSync(join(runtime, 'workspaces.json'), JSON.stringify([{ id: WS.id, path: wsPath }], null, 2));
const nowIso = new Date().toISOString();
writeFileSync(join(runtime, 'agents.json'), JSON.stringify(AGENTS.map((a) => ({
    id: a.id, workspaceId: WS.id, provider: 'codex', name: a.key, instructions: null, threadId: null,
    createdAt: nowIso, lastUsedAt: null, mode: 'manual', accessScope: 'none',
})), null, 2));
writeFileSync(join(runtime, 'settings.json'), JSON.stringify({ theme: 'dark', whats_new_seen_version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version }, null, 2));

const stub = join(ROOT, 'scripts', 'stub-codex.mjs');
chmodSync(stub, 0o755);
const TICKER = join(tmpdir(), 'genie-stub-codex-ticker');
rmSync(TICKER, { force: true });

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
    PATH: `${nodeDir}:${process.env.PATH ?? ''}`,
};
const electron = createRequire(import.meta.url)('electron');
const logFd = openSync(join(OUT, 'electron.log'), 'a');
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
setTimeout(() => { say('FAIL the run\'s own deadline, 15 minutes'); finish(1); }, 15 * 60_000).unref?.();

const proof = { checks: [], notes: [], views: {} };
const check = (name, ok, detail) => { proof.checks.push({ name, ok: Boolean(ok), detail }); say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); return Boolean(ok); };

let cdp;
const ev = (expression) => cdp.evaluate(expression);
async function waitFor(label, expression, ms = 30_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        try { if (await ev(expression)) return true; } catch { /* no document yet */ }
        await sleep(300);
    }
    proof.notes.push(`timed out waiting for ${label}`);
    say(`NOTE timed out waiting for ${label}`);
    return false;
}
async function shot(name) {
    await sleep(900);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!r.result?.data) throw new Error(`${name}: no image came back`);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'));
    say(`shot ${name}`);
}
async function sizeWindow(width) {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = mainWindow(t);
    const browser = await Cdp.connect((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
    const w = await browser.send('Browser.getWindowForTarget', { targetId: page.id });
    if (w.result?.windowId) await browser.send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'normal', left: 0, top: 0, width, height: HEIGHT } });
    browser.close();
    const hypr = (...args) => spawnSync('hyprctl', args, { encoding: 'utf8', env: process.env });
    const active = hypr('activewindow', '-j');
    if (active.status === 0) {
        try { if (JSON.parse(active.stdout).floating === false) hypr('dispatch', 'togglefloating'); } catch { /* not json */ }
        hypr('dispatch', 'resizeactive', 'exact', String(width), String(HEIGHT));
        hypr('dispatch', 'moveactive', 'exact', '0', '0');
    }
    await sleep(2000);
    const inner = JSON.parse(await ev('JSON.stringify({ w: window.innerWidth, h: window.innerHeight })'));
    if (inner.w !== width || inner.h !== HEIGHT) await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
}

/**
 * THE CHROME ABOVE A VIEW'S CONTENT, measured: the surface's top, where its content starts (the first element under all its
 * bars and rows, i.e. its body), every horizontal band between them, the one bar's height, and what of the old rows is left.
 */
const MEASURE = (surface) => `(() => {
  const s = document.querySelector('[data-surface="${surface}"]');
  if (!s) return JSON.stringify({ surface: false });
  const top = s.getBoundingClientRect().top;
  const body = s.querySelector(':scope > [data-view-body]') ?? [...s.children].at(-1);
  // The bands of chrome: every child of the surface (and, for the old agent page, of its wrapper) that sits above the body.
  const wrapper = s.closest('[data-agent-in-workspace]');
  const above = [...(wrapper ? [...wrapper.children].filter((c) => !c.contains(s)) : []), ...s.children].filter((c) => c !== body && c.getBoundingClientRect().bottom <= (body?.getBoundingClientRect().top ?? 0) + 1 && c.getBoundingClientRect().height > 0);
  const bar = s.querySelector('[data-top-bar]');
  return JSON.stringify({
    surface: true,
    chrome: Math.round((body?.getBoundingClientRect().top ?? 0) - (wrapper ? wrapper.getBoundingClientRect().top : top)),
    bands: above.map((c) => ({ what: [...c.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name).join(' ') || c.tagName.toLowerCase(), h: Math.round(c.getBoundingClientRect().height) })),
    bars: document.querySelectorAll('[data-top-bar]').length,
    barFirst: s.firstElementChild?.hasAttribute('data-top-bar') ?? false,
    barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : null,
    crumbs: document.querySelectorAll('[data-crumb], [data-react-fancy-breadcrumbs], [data-header-path]').length,
    subviewsInBar: Boolean(bar?.querySelector('[data-agent-subviews] [data-tab="stream"]')),
    stopInBar: Boolean(bar?.querySelector('[data-action="stop-turn"]')),
    pill: bar?.querySelector('[data-pill]')?.getAttribute('data-pill') ?? document.querySelector('[data-pill]')?.getAttribute('data-pill') ?? null,
    wide: bar ? bar.scrollWidth - bar.clientWidth : null,
  });
})()`;

let failed = false;
try {
    const page = await (async () => { const until = Date.now() + 90_000; while (Date.now() < until) { try { const p = mainWindow(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()); if (p) return p; } catch { /* not up */ } await sleep(500); } return null; })();
    if (!page) throw new Error('the Electron window never appeared on its debugger port');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitForPageProbe(cdp);
    await waitFor('the Dashboard', `Boolean(document.querySelector('[data-surface="dashboard"]'))`, 60_000);
    await sizeWindow(WIDTH);
    const seen = JSON.parse(await ev(`window.genieTest.snapshot().then((s) => JSON.stringify({ agents: (s.agents ?? []).filter((a) => a.name !== 'genie').length }))`));
    if (seen.agents < AGENTS.length) throw new Error(`the seed was not read: ${JSON.stringify(seen)}`);

    // One agent mid-turn (the ticker streams for ever), so its bar shows a running pill and Stop.
    writeFileSync(TICKER, String(process.pid));
    const busy = AGENTS[0];
    await ev(`window.genieTest.agents.restart(${JSON.stringify(busy.id)}, 'graceful').then((r) => JSON.stringify(r))`);
    await waitFor(`${busy.key}'s session`, `window.genieTest.agentDetail(${JSON.stringify(busy.id)}).then((d) => d?.session?.running === true)`, 60_000);
    await ev(`window.genieTest.prompt(${JSON.stringify(busy.id)}, 'keep going with the plan').then((r) => JSON.stringify(r))`);
    await waitFor(`${busy.key} working`, `window.genieTest.agentDetail(${JSON.stringify(busy.id)}).then((d) => d?.session?.turnState === 'working')`, 60_000);

    for (const [n, width] of [[1, WIDTH], [3, 1024]]) {
        await sizeWindow(width);
        await ev(`window.location.hash = '#genie://workspace/${WS.id}'; true`);
        await waitFor('the workspace', `Boolean(document.querySelector('[data-surface="workspace"]'))`);
        await sleep(800);
        const w = JSON.parse(await ev(MEASURE('workspace')));
        await shot(`0${n}-workspace-${width}`);
        await ev(`window.location.hash = '#genie://agent/${busy.id}?tab=stream'; true`);
        await waitFor('the agent page', `Boolean(document.querySelector('[data-surface="agent"]'))`);
        await sleep(1200);
        const a = JSON.parse(await ev(MEASURE('agent')));
        await shot(`0${n + 1}-agent-${width}`);
        proof.views[width] = { workspace: w, agent: a };
        check(`${width}px: one bar in each view, the surface's first child`, w.bars === 1 && a.bars === 1 && w.barFirst && a.barFirst, { workspace: w.bands, agent: a.bands });
        check(`${width}px: the same chrome above the content in both views (the bar only)`, w.chrome === a.chrome && w.bands.length === 1 && a.bands.length === 1, { workspace: w.chrome, agent: a.chrome });
        check(`${width}px: the bar is 32px in both`, w.barHeight === 32 && a.barHeight === 32, { workspace: w.barHeight, agent: a.barHeight });
        check(`${width}px: no crumbs and no path column`, w.crumbs === 0 && a.crumbs === 0, { workspace: w.crumbs, agent: a.crumbs });
        check(`${width}px: the agent's views, its running pill and Stop are in the bar`, a.subviewsInBar && a.stopInBar && /running/.test(a.pill ?? ''), { pill: a.pill });
        check(`${width}px: neither bar spills`, (w.wide ?? 99) <= 1 && (a.wide ?? 99) <= 1, { workspace: w.wide, agent: a.wide });
    }
} catch (error) {
    failed = true;
    say(`FAIL ${error?.stack ?? error}`);
    proof.error = String(error?.message ?? error);
}

proof.ok = !failed && proof.checks.every((c) => c.ok);
writeFileSync(join(OUT, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
say(proof.ok ? 'ALL PROVEN' : `NOT PROVEN: ${proof.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || proof.error}`);
finish(proof.ok ? 0 : 1);
