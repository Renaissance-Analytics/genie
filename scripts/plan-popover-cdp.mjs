#!/usr/bin/env node
/**
 * THE DASHBOARD'S PLAN POPOVER SCROLLS (Tynn #1021), proven in a real window on a TEST MACHINE, never a desktop.
 *
 *   node scripts/plan-popover-cdp.mjs [out-dir]     (the Azure queue job does this; it refuses anywhere else)
 *
 * The owner's report: the per-agent plan popover ("27/77" and its steps) grew past the bottom of the screen, with no scroll.
 * This opens the built app on a seeded workspace with one stub-codex agent (scripts/stub-codex.mjs, PLAN MODE) whose turn
 * reports a 77-step plan, 27 done and step 28 in progress, through Genie's own `plan` MCP tool with the agent's own key:
 * the path an agent's plan takes to the Dashboard. A What's new window,
 * if the fresh home shows one, is closed first, with its own Close button. Then a REAL pointer (CDP Input.dispatchMouseEvent)
 * hovers the Dashboard's plan cell and the popover is measured from the DOM: it is whole on the screen, its list is capped
 * and scrolls (the 77 steps really do not fit: the control that the cap is doing work), the "27/77" header sits outside the
 * scrolling list, and it opened on the step in progress. A real mouse wheel then scrolls the list to its top and to its end,
 * the header staying put and the popover staying open.
 *
 * Out: 01-opened.png (as it opens, on the step in progress), 02-top.png (wheeled to the top), 03-scrolled.png (wheeled to
 * the end), proof.json (what the DOM held). Exit 0 all proven; 1 a check failed; 2 cannot run here.
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
const OUT = resolve(process.argv[2] ?? join(ROOT, 'ci-out', 'plan-popover'));
const PORT = Number(process.env.PLAN_POPOVER_CDP_PORT ?? 9358);
const WIDTH = 1600;
const HEIGHT = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
mkdirSync(OUT, { recursive: true });

const root = mkdtempSync(join(tmpdir(), 'plan-popover-'));
const home = join(root, 'home');
const data = join(root, 'user-data');
const genieHome = join(home, '.genie');
const runtime = join(genieHome, 'runtime');
mkdirSync(runtime, { recursive: true });
mkdirSync(data, { recursive: true });

// THE SEED. Fixture names only (no person).
const WS = { id: 'orbitapi', name: 'orbit-api' };
const AGENT = { key: 'meridian', id: `agent_${'c1'.repeat(16)}` };
const wsPath = join(homedir(), 'projects', WS.name);
mkdirSync(wsPath, { recursive: true });
writeFileSync(join(wsPath, 'project.json'), `${JSON.stringify({ name: WS.name }, null, 2)}\n`);
writeFileSync(join(runtime, 'workspaces.json'), JSON.stringify([{ id: WS.id, path: wsPath }], null, 2));
writeFileSync(join(runtime, 'agents.json'), JSON.stringify([{
    id: AGENT.id, workspaceId: WS.id, provider: 'codex', name: AGENT.key, instructions: null, threadId: null,
    createdAt: new Date().toISOString(), lastUsedAt: null, mode: 'manual', accessScope: 'none',
}], null, 2));
writeFileSync(join(runtime, 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2));

// THE PLAN: 77 steps, 27 done, step 28 in progress (the owner's "27/77"), as the `plan` tool takes them.
const STEPS = Array.from({ length: 77 }, (_, i) => ({ content: `Step ${i + 1}: ${['read the brief', 'write the failing test', 'build it', 'wire it', 'measure it', 'review it', 'ship it'][i % 7]}`, status: i < 27 ? 'completed' : i === 27 ? 'in_progress' : 'pending' }));
const CURRENT = STEPS[27].content;
const LAST = STEPS[76].content;
const stub = join(ROOT, 'scripts', 'stub-codex.mjs');
chmodSync(stub, 0o755);
const PLAN_MARKER = join(tmpdir(), 'genie-stub-codex-plan');
const PLAN_RESULT = `${PLAN_MARKER}.result`;
rmSync(PLAN_MARKER, { force: true });
rmSync(PLAN_RESULT, { force: true });
rmSync(join(tmpdir(), 'genie-stub-codex-ticker'), { force: true });

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
    /** Every call is bounded: measured on the Azure VM, a mouseWheel dispatch went unanswered and held the run to its deadline. */
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
    rmSync(PLAN_MARKER, { force: true });
    let hostPid = null;
    try { hostPid = JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')).pid; } catch { /* none */ }
    for (const p of processes()) if (p.args.includes(data) || p.args.includes(genieHome) || p.pid === hostPid) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ }
    try { rmSync(root, { recursive: true, force: true }); } catch { /* the VM is deleted anyway */ }
}
const finish = (code) => { endEverything(); process.exit(code); };
setTimeout(() => { say('FAIL the run\'s own deadline, 12 minutes'); finish(1); }, 12 * 60_000).unref?.();

const proof = { checks: [], notes: [], seen: {} };
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
    await sleep(700);
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
/** The middle of what the selector finds, in window coordinates, or null. */
const centre = (selector) => ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
async function mouse(type, at, extra = {}) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' || type === 'mouseWheel' ? 'none' : 'left', clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0, ...extra });
}
async function click(selector) {
    const at = await centre(selector);
    if (!at) return false;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await mouse(type, at);
    return true;
}

/** THE POPOVER, measured: where it is, its list's cap and scroll, the header against the list, the current step against the list. */
const MEASURE = `(() => {
  const list = document.querySelector('[data-plan-full]');
  if (!list) return JSON.stringify({ open: false });
  const pop = list.closest('[data-react-fancy-popover]');
  const head = list.querySelector('[data-plan-head]');
  const scroll = list.querySelector('[data-plan-scroll]');
  const current = scroll?.querySelector('[data-current="true"]');
  const items = scroll ? [...scroll.querySelectorAll('li')] : [];
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; };
  const inside = (el) => { if (!el || !scroll) return false; const a = el.getBoundingClientRect(), b = scroll.getBoundingClientRect(); return a.top >= b.top - 1 && a.bottom <= b.bottom + 1; };
  return JSON.stringify({
    open: true, viewport: innerHeight, pop: box(pop), list: box(list), head: box(head), scrollBox: box(scroll),
    headText: head?.textContent ?? null, headInScroll: Boolean(scroll && head && scroll.contains(head)),
    maxHeight: list.style.maxHeight, overflowY: scroll ? getComputedStyle(scroll).overflowY : null,
    scrollTop: scroll ? Math.round(scroll.scrollTop) : null, scrollHeight: scroll?.scrollHeight ?? null, clientHeight: scroll?.clientHeight ?? null,
    items: items.length, currentText: current?.textContent ?? null, currentInView: inside(current),
    firstInView: inside(items[0]), lastInView: inside(items.at(-1)),
  });
})()`;
const measure = async () => JSON.parse(await ev(MEASURE));

let failed = false;
try {
    const page = await (async () => { const until = Date.now() + 90_000; while (Date.now() < until) { try { const p = mainWindow(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()); if (p) return p; } catch { /* not up */ } await sleep(500); } return null; })();
    if (!page) throw new Error('the Electron window never appeared on its debugger port');
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await waitForPageProbe(cdp);
    check('0. the app is up, on a seeded home of its own', await waitFor('the Dashboard', `Boolean(document.querySelector('[data-surface="dashboard"]'))`, 60_000));
    await sizeWindow(WIDTH);

    // WHAT'S NEW FIRST: a fresh home may open with it over the window. Closed the way a person closes it.
    const whatsNew = await waitFor("the What's new window (if it shows)", `Boolean(document.querySelector('[data-action="whats-new-close"]'))`, 15_000);
    if (whatsNew) {
        await click('[data-action="whats-new-close"]');
        check("0b. the What's new window was shown and is closed with its Close button", await waitFor("What's new gone", `!document.querySelector('[data-whats-new]')`, 10_000));
    } else proof.notes.push("no What's new window was shown on this home");

    const seen = JSON.parse(await ev(`window.genieTest.snapshot().then((s) => JSON.stringify({ agents: (s.agents ?? []).filter((a) => a.name !== 'genie').length }))`));
    if (seen.agents < 1) throw new Error(`the seed was not read: ${JSON.stringify(seen)}`);

    // The agent's turn publishes the 77-step plan (the stub's PLAN MODE) and keeps streaming: mid-turn, the plan on its row.
    writeFileSync(PLAN_MARKER, JSON.stringify({ owner: process.pid, steps: STEPS }));
    await ev(`window.genieTest.agents.restart(${JSON.stringify(AGENT.id)}, 'graceful').then((r) => JSON.stringify(r))`);
    await waitFor(`${AGENT.key}'s session`, `window.genieTest.agentDetail(${JSON.stringify(AGENT.id)}).then((d) => d?.session?.running === true)`, 60_000);
    await ev(`window.genieTest.prompt(${JSON.stringify(AGENT.id)}, 'keep going with the plan').then((r) => JSON.stringify(r))`);
    await waitFor(`${AGENT.key} working`, `window.genieTest.agentDetail(${JSON.stringify(AGENT.id)}).then((d) => d?.session?.turnState === 'working')`, 60_000);

    await ev(`window.location.hash = '#genie://dashboard'; true`);
    const CELL = '[data-surface="dashboard"] [data-plan-hover]';
    const cellUp = await waitFor('the plan cell', `Boolean(document.querySelector(${JSON.stringify(CELL)}))`, 60_000);
    const cellText = cellUp ? await ev(`document.querySelector(${JSON.stringify(CELL)}).textContent`) : null;
    check('1. CONTROL: the agent\'s Dashboard row shows the plan, 27/77 and the step in progress', cellUp && /27\/77/.test(cellText ?? '') && (cellText ?? '').includes(CURRENT), cellText);
    let answered = '(the stub wrote nothing)';
    try { answered = readFileSync(PLAN_RESULT, 'utf8').trim(); } catch { /* none */ }
    proof.notes.push(`what Genie answered the stub's plan call: ${answered}`);
    say(`the stub's plan call: ${answered}`);
    if (!cellUp) {
        proof.notes.push(`the agent's last rows: ${await ev(`window.genieTest.agentDetail(${JSON.stringify(AGENT.id)}).then((d) => JSON.stringify((d?.rows ?? []).slice(-8).map((r) => r.event?.kind ?? r.kind)))`)}`);
        throw new Error('no plan cell on the Dashboard');
    }

    // A REAL HOVER: the pointer moved onto the cell. The popover opens after its hover delay.
    await mouse('mouseMoved', await centre(CELL));
    check('2. hovering the plan cell opens the popover', await waitFor('the popover', `(() => { const p = document.querySelector('[data-plan-full]')?.closest('[data-react-fancy-popover]'); if (!p) return false; const r = p.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && !p.classList.contains('invisible'); })()`, 10_000));
    await sleep(600);
    const opened = await measure();
    proof.seen.opened = opened;
    check('3. the popover is whole on the screen: its bottom is inside the window', opened.open && opened.pop.top >= 0 && opened.pop.bottom <= opened.viewport, { pop: opened.pop, viewport: opened.viewport });
    check('4. its list is capped and scrolls: overflow-y auto, and the 77 steps really do not fit (the cap is doing work)', opened.overflowY === 'auto' && opened.items === 77 && opened.scrollHeight > opened.clientHeight + 40, { maxHeight: opened.maxHeight, overflowY: opened.overflowY, scrollHeight: opened.scrollHeight, clientHeight: opened.clientHeight });
    check('5. the 27/77 header is outside the scrolling list, above it', opened.headText === '27/77' && !opened.headInScroll && opened.head.bottom <= opened.scrollBox.top + 1, { head: opened.head, scrollBox: opened.scrollBox });
    check('6. it opened on the step in progress: scrolled down, step 28 in view', opened.scrollTop > 0 && opened.currentInView && (opened.currentText ?? '').includes(CURRENT), { scrollTop: opened.scrollTop, current: opened.currentText });
    await shot('01-opened');

    // A REAL WHEEL over the list: to its top, then to its end. The popover stays open and the header stays where it is.
    const over = { x: Math.round((opened.scrollBox.left + opened.scrollBox.right) / 2), y: Math.round((opened.scrollBox.top + opened.scrollBox.bottom) / 2) };
    await mouse('mouseMoved', over);
    await sleep(400);
    // The wheel first, as a person scrolls. If the page does not answer a wheel dispatch (measured once on the Azure VM:
    // it never answered), the list is scrolled by its scrollTop instead, and the checks below say which it was.
    let by = 'the mouse wheel';
    const wheel = async (deltaY, to) => {
        if (by === 'the mouse wheel') {
            try { for (let i = 0; i < 8; i++) { await mouse('mouseWheel', over, { deltaX: 0, deltaY }); await sleep(120); } return; } catch (error) {
                by = 'scrollTop (the wheel dispatch was not answered)';
                proof.notes.push(`the wheel: ${String(error?.message ?? error)}; the list is scrolled by its scrollTop instead`);
            }
        }
        await ev(`(() => { const s = document.querySelector('[data-plan-scroll]'); s.scrollTop = ${to}; return true; })()`);
    };
    await wheel(-1000, 0);
    await sleep(600);
    const top = await measure();
    proof.seen.top = top;
    check(`7. scrolled up by ${by}: the list is at its top, step 1 in view, the popover still open`, top.open && top.scrollTop === 0 && top.firstInView, { scrollTop: top.scrollTop });
    check('8. and the header did not move', top.open && top.head.top === opened.head.top && top.pop.top === opened.pop.top, { head: top.head, pop: top.pop });
    await shot('02-top');

    await wheel(1000, 's.scrollHeight');
    await sleep(600);
    const end = await measure();
    proof.seen.scrolled = end;
    check(`9. scrolled down by ${by}: the list is at its end, the last step in view, the popover still open`, end.open && Math.abs(end.scrollTop - (end.scrollHeight - end.clientHeight)) <= 2 && end.lastInView && end.scrollTop > opened.scrollTop, { scrollTop: end.scrollTop, last: LAST });
    check('10. and the header is still in place, the popover still whole on the screen', end.open && end.head.top === opened.head.top && end.pop.bottom <= end.viewport, { head: end.head, pop: end.pop });
    await shot('03-scrolled');
} catch (error) {
    failed = true;
    say(`FAIL ${error?.stack ?? error}`);
    proof.error = String(error?.message ?? error);
    try { await shot('99-failed'); } catch { /* no window */ }
}

proof.ok = !failed && proof.checks.every((c) => c.ok);
writeFileSync(join(OUT, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
say(proof.ok ? 'ALL PROVEN' : `NOT PROVEN: ${proof.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || proof.error}`);
finish(proof.ok ? 0 : 1);
