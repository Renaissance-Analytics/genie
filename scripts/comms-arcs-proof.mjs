#!/usr/bin/env node
/**
 * VISUAL PROOF OF THE COMMS FLIGHT PATHS (Tynn #750, option D), taken in a real window on a TEST MACHINE, never a desktop.
 *
 *   node scripts/comms-arcs-proof.mjs [out-dir]     (the Azure queue job does this; it refuses anywhere else)
 *
 * The mockup's arcs did not show for the owner, so this proves them where it counts: the built app, real AgentInbox mail between
 * seeded stub-provider agents, a REAL pointer moved over a Comms cell with CDP's Input.dispatchMouseEvent, and the overlay then
 * measured from the DOM (paths, their bounding boxes, stroke width, opacity). It FAILS when there is no arc, when an arc is
 * 0-sized, when anything is drawn at rest, or when the arcs do not follow a pointer move.
 *
 * Out: 01-rest.png (no arcs), 02-hover.png (arcs), 03-follow.png (pointer moved inside the icon), hover.gif (about 3 s of the
 * hover, Page.startScreencast frames), proof.json (what the DOM held). Exit 0 all proven; 1 a check failed; 2 cannot run here.
 *
 * THE MAIL: `since` for an agent's comms is its session start, and the app reads the mail file when it opens, so the seed is dated
 * AFTER the sessions will have started (launch + MAIL_FROM_S) and the run waits until every message is in the past. Ages are
 * therefore seconds to a couple of minutes; the 24 h fade is covered by test/flight-arcs.test.ts.
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
const OUT = resolve(process.argv[2] ?? join(ROOT, 'ci-out', 'comms-arcs'));
const PORT = Number(process.env.ARCS_CDP_PORT ?? 9356);
const WIDTH = 1600;
const HEIGHT = 1000;
const MAIL_FROM_S = 330;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
mkdirSync(OUT, { recursive: true });
const launchedAt = Date.now();

const root = mkdtempSync(join(tmpdir(), 'comms-arcs-'));
const home = join(root, 'home');
const data = join(root, 'user-data');
const genieHome = join(home, '.genie');
const runtime = join(genieHome, 'runtime');
mkdirSync(join(runtime, 'inbox'), { recursive: true });
mkdirSync(data, { recursive: true });

const WORKSPACES = [{ id: 'atlasweb', name: 'atlas-web' }, { id: 'orbitapi', name: 'orbit-api' }, { id: 'lumendocs', name: 'lumen-docs' }];
const hex = (n) => n.toString(16).padStart(2, '0').repeat(16);
const AGENTS = [
    ['meridian', 'atlasweb'], ['quill', 'atlasweb'], ['sable', 'orbitapi'], ['ember', 'orbitapi'],
    ['vesper', 'lumendocs'], ['cobalt', 'lumendocs'], ['atlas', 'lumendocs'], ['orbit', 'orbitapi'],
].map(([key, ws], i) => ({ key, ws, id: `agent_${hex(0xb1 + i)}` }));
const by = (key) => AGENTS.find((a) => a.key === key);

const wsPaths = {};
for (const w of WORKSPACES) {
    const path = join(homedir(), 'projects', w.name);
    mkdirSync(path, { recursive: true });
    wsPaths[w.id] = path;
    writeFileSync(join(path, 'project.json'), `${JSON.stringify({ name: w.name }, null, 2)}\n`);
}
writeFileSync(join(runtime, 'workspaces.json'), JSON.stringify(WORKSPACES.map((w) => ({ id: w.id, path: wsPaths[w.id] })), null, 2));
const nowIso = new Date().toISOString();
writeFileSync(join(runtime, 'agents.json'), JSON.stringify(AGENTS.map((a) => ({
    id: a.id, workspaceId: a.ws, provider: 'codex', name: a.key, instructions: null, threadId: null,
    createdAt: nowIso, lastUsedAt: null, mode: 'manual', accessScope: 'none',
})), null, 2));
writeFileSync(join(runtime, 'settings.json'), JSON.stringify({ theme: 'dark', whats_new_seen_version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version }, null, 2));

// THE MAIL: [from, to, seconds after MAIL_FROM_S, read?]. meridian is the hovered agent: it sent to sable (read, unanswered),
// ember (unread), cobalt (read, unanswered) and atlas (unread); vesper wrote to it (read, unanswered), quill (unread).
const MAIL = [
    ['meridian', 'sable', 0, true], ['meridian', 'cobalt', 10, true], ['vesper', 'meridian', 20, true], ['meridian', 'ember', 60, false],
    ['quill', 'meridian', 90, false], ['meridian', 'atlas', 100, false], ['orbit', 'sable', 30, true], ['atlas', 'cobalt', 50, false],
];
const lastMailAt = launchedAt + (MAIL_FROM_S + Math.max(...MAIL.map((m) => m[2]))) * 1000;
writeFileSync(join(runtime, 'inbox', 'mail.json'), JSON.stringify({
    cursors: {},
    messages: MAIL.map(([from, to, after, read], i) => {
        const sentAt = new Date(launchedAt + (MAIL_FROM_S + after) * 1000).toISOString();
        return { seq: i + 1, id: `msg_00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, from: by(from).id, to: by(to).id, text: `${from} to ${to}`, attachments: [], sentAt, readAt: read ? new Date(Date.parse(sentAt) + 2000).toISOString() : null };
    }),
}, null, 2));

const stub = join(ROOT, 'scripts', 'stub-codex.mjs');
chmodSync(stub, 0o755);
const TICKER = join(tmpdir(), 'genie-stub-codex-ticker');
rmSync(TICKER, { force: true });

class Cdp {
    #socket; #next = 1; #pending = new Map(); #listeners = [];
    static async connect(url) {
        const cdp = new Cdp();
        cdp.#socket = new WebSocket(url);
        cdp.#socket.addEventListener('message', (event) => {
            const frame = JSON.parse(event.data);
            const done = cdp.#pending.get(frame.id);
            if (typeof done === 'function') { cdp.#pending.delete(frame.id); done(frame); } else if (frame.method) for (const l of cdp.#listeners) l(frame);
        });
        await new Promise((resolveOpen, reject) => { cdp.#socket.addEventListener('open', resolveOpen, { once: true }); cdp.#socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true }); });
        return cdp;
    }
    on(listener) { this.#listeners.push(listener); }
    send(method, params = {}) { const id = this.#next++; return new Promise((r) => { this.#pending.set(id, r); this.#socket.send(JSON.stringify({ id, method, params })); }); }
    async evaluate(expression) {
        return Cdp.#value(await this.#answer(this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), expression));
    }
    /**
     * Runs `fn` in the page with `args` passed as real CDP arguments (Runtime.callFunctionOn), never spliced into code: the page
     * receives the values, not text to evaluate (CodeQL #118/#119). `fn` is a constant function of this script; it sees only
     * the page's globals and its own arguments. The result comes back by value.
     */
    async call(fn, ...args) {
        const global = Cdp.#value(await this.#answer(this.send('Runtime.evaluate', { expression: 'globalThis' }), 'globalThis'), 'objectId');
        return Cdp.#value(await this.#answer(this.send('Runtime.callFunctionOn', { objectId: global, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true }), fn.name || 'a function'));
    }
    #answer(request, what) {
        return Promise.race([request, sleep(30_000).then(() => { throw new Error(`no answer in 30 s: ${what.slice(0, 80)}`); })]);
    }
    static #value(frame, key = 'value') {
        if (frame.error) throw new Error(`CDP error: ${JSON.stringify(frame.error)}`);
        if (frame.result?.exceptionDetails) throw new Error(`page threw: ${frame.result.exceptionDetails.exception?.description ?? 'unknown'}`);
        return frame.result?.result?.[key];
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
setTimeout(() => { say('FAIL the run\'s own deadline, 25 minutes'); finish(1); }, 25 * 60_000).unref?.();

const proof = { checks: [], notes: [] };
const check = (name, ok, detail) => { proof.checks.push({ name, ok: Boolean(ok), detail }); say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); return Boolean(ok); };

let cdp;
const ev = (expression) => cdp.evaluate(expression);
/** `probe` is an expression for the page, or a function that asks it (cdp.call) and resolves to the answer. */
async function waitFor(label, probe, ms = 30_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        try { if (await (typeof probe === 'function' ? probe() : ev(probe))) return true; } catch { /* no document yet */ }
        await sleep(300);
    }
    proof.notes.push(`timed out waiting for ${label}`);
    say(`NOTE timed out waiting for ${label}`);
    return false;
}
const mouse = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
// A CDP pointer is not the compositor's, and a window can report it gone while it stands still; a held position is re-sent so a
// shot is of the hover, and the stationary case is measured on its own (proof.idle) with whether the browser itself still said :hover.
let hold = null;
const holdAt = (x, y) => { clearInterval(hold); hold = setInterval(() => { void mouse(x, y); }, 80); };
const release = () => { clearInterval(hold); hold = null; };
// Stills come from the screencast's latest frame (what the compositor shows, dots in flight), and also from Page.captureScreenshot
// as `<name>-capture.png`: on the first run the capture came back without the overlay though the DOM, the dimming and the
// screencast all had it, so the two are kept side by side and the difference stays visible.
const frames = [];
let castOn = false;
function onFrame(f) {
    if (f.method !== 'Page.screencastFrame') return;
    frames.push({ data: f.params.data, at: f.params.metadata?.timestamp ?? Date.now() / 1000 });
    if (frames.length > 400) frames.shift();
    void cdp.send('Page.screencastFrameAck', { sessionId: f.params.sessionId });
}
async function startCast(maxWidth, maxHeight) {
    if (!castOn) { cdp.on(onFrame); castOn = true; }
    frames.length = 0;
    await cdp.send('Page.startScreencast', { format: 'png', maxWidth, maxHeight, everyNthFrame: 1 });
}
async function shot(name) {
    await sleep(900); // a frame, and the dots in flight
    const latest = frames.at(-1);
    if (latest) writeFileSync(join(OUT, `${name}.png`), Buffer.from(latest.data, 'base64'));
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (r.result?.data) writeFileSync(join(OUT, `${name}-capture.png`), Buffer.from(r.result.data, 'base64'));
    if (!latest && !r.result?.data) throw new Error(`${name}: no image came back`);
    say(`shot ${name} (${latest ? 'screencast frame' : 'no screencast frame'}, ${r.result?.data ? 'capture' : 'no capture'})`);
}

async function sizeWindow() {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = mainWindow(t);
    const browser = await Cdp.connect((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl);
    const w = await browser.send('Browser.getWindowForTarget', { targetId: page.id });
    if (w.result?.windowId) await browser.send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: 'normal', left: 0, top: 0, width: WIDTH, height: HEIGHT } });
    browser.close();
    const hypr = (...args) => spawnSync('hyprctl', args, { encoding: 'utf8', env: process.env });
    const active = hypr('activewindow', '-j');
    if (active.status === 0) {
        try { if (JSON.parse(active.stdout).floating === false) hypr('dispatch', 'togglefloating'); } catch { /* not json */ }
        hypr('dispatch', 'resizeactive', 'exact', String(WIDTH), String(HEIGHT));
        hypr('dispatch', 'moveactive', 'exact', '0', '0');
    }
    await sleep(2500);
    const inner = JSON.parse(await ev('JSON.stringify({ w: window.innerWidth, h: window.innerHeight })'));
    if (inner.w !== WIDTH || inner.h !== HEIGHT) await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
}

/** What the overlay holds, measured from the DOM: each arc's path, its box, its stroke, its opacity, and where it sits in the stack. */
const MEASURE = `(() => {
  const svg = document.querySelector('[data-flight-paths]');
  if (!svg) return JSON.stringify({ overlay: false, arcs: [] });
  const box = svg.getBoundingClientRect();
  const arcs = [...svg.querySelectorAll('[data-flight-arc]')].map((g) => {
    const p = g.querySelector('path[data-arc-main]');
    const b = p.getBBox();
    const r = p.getBoundingClientRect();
    return { peer: g.getAttribute('data-peer'), tone: g.getAttribute('data-tone'), direction: g.getAttribute('data-direction'), d: p.getAttribute('d'), strokeWidth: Number(getComputedStyle(p).strokeWidth.replace('px', '')), opacity: Number(g.getAttribute('opacity')), bbox: { w: b.width, h: b.height }, onScreen: { w: r.width, h: r.height },
      dots: g.querySelectorAll('[data-arc-dot]').length, pulse: Boolean(g.querySelector('[data-arc-pulse]')), label: g.querySelector('[data-arc-label]')?.textContent ?? null,
      color: g.getAttribute('data-arc-color'), drawn: getComputedStyle(g).getPropertyValue('--arc').trim(), shadowEnds: (() => {
        const sh = g.querySelector('path[data-arc-shadow]');
        if (!sh) return null;
        const n = sh.getTotalLength();
        const a = sh.getPointAtLength(0), z = sh.getPointAtLength(n), pa = p.getPointAtLength(0), pz = p.getPointAtLength(p.getTotalLength());
        return { start: Math.hypot(a.x - pa.x, a.y - pa.y), end: Math.hypot(z.x - pz.x, z.y - pz.y), width: Number(getComputedStyle(sh).strokeWidth.replace('px', '')), filter: sh.getAttribute('filter'), transform: sh.getAttribute('transform') };
      })() };
  });
  const at = svg.getBoundingClientRect();
  const top = document.elementFromPoint(at.left + 5, at.top + 5);
  return JSON.stringify({ overlay: true, size: { w: box.width, h: box.height }, z: getComputedStyle(svg).zIndex, pointerEvents: getComputedStyle(svg).pointerEvents, arcs, dimmed: document.querySelectorAll('[data-reveal="dim"]').length, peers: document.querySelectorAll('[data-reveal="peer"]').length });
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
    await sizeWindow();
    await ev(`window.location.hash = '#genie://dashboard'; true`);
    const seen = JSON.parse(await ev(`window.genieTest.snapshot().then((s) => JSON.stringify({ agents: (s.agents ?? []).filter((a) => a.name !== 'genie').length }))`));
    if (seen.agents < AGENTS.length) throw new Error(`the seed was not read: ${JSON.stringify(seen)}`);

    // Every agent's session up on the stub (the ticker keeps a turn streaming, so no agent sleeps while the mail ages).
    writeFileSync(TICKER, String(process.pid));
    for (const a of AGENTS) {
        await ev(`window.genieTest.agents.restart(${JSON.stringify(a.id)}, 'graceful').then((r) => JSON.stringify(r))`);
        await waitFor(`${a.key}'s session`, `window.genieTest.agentDetail(${JSON.stringify(a.id)}).then((d) => d?.session?.running === true)`, 60_000);
        // A turn that streams for ever (the ticker): the agent reads Working, not Sleeping, and so is on the board for the whole run.
        await ev(`window.genieTest.prompt(${JSON.stringify(a.id)}, 'keep going with the plan').then((r) => JSON.stringify(r))`);
    }
    const sessionsUp = Date.now();
    check('every session was up before the seeded mail starts', sessionsUp < launchedAt + MAIL_FROM_S * 1000, { upAfterS: Math.round((sessionsUp - launchedAt) / 1000), mailFromS: MAIL_FROM_S });
    // The mail is dated after the sessions started; wait until all of it is in the past and the cell shows its collaborators.
    const wait = lastMailAt + 12_000 - Date.now();
    say(`waiting ${Math.round(wait / 1000)} s for the seeded mail to be in the past`);
    if (wait > 0) await sleep(wait);
    const meridian = by('meridian');
    const cellSel = `[data-surface="dashboard"] [data-agent="${meridian.id}"] [data-comms-cell]`;
    await waitFor('meridian\'s Comms cell to count its collaborators', () => cdp.call((sel) => (document.querySelector(sel)?.textContent ?? '').match(/[1-9]/) !== null, cellSel), 60_000);

    await startCast(WIDTH, HEIGHT);
    // 1. AT REST: pointer away, nothing drawn.
    await mouse(WIDTH - 40, HEIGHT - 40);
    await sleep(500);
    const rest = JSON.parse(await ev(MEASURE));
    check('nothing is drawn at rest', rest.overlay === false && JSON.parse(await ev(`JSON.stringify(document.querySelectorAll('[data-reveal]').length)`)) === 0);
    await shot('01-rest');

    // 2. HOVER: a real pointer on the Comms icon.
    const cell = await cdp.call((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); const i = document.querySelector(`${sel} svg`)?.getBoundingClientRect() ?? r; return { x: i.x + i.width / 2, y: i.y + i.height / 2, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }, cellSel);
    await mouse(cell.x - 2, cell.y);
    await mouse(cell.x, cell.y);
    await sleep(400);
    const hover = JSON.parse(await ev(MEASURE));
    proof.hover = hover;
    check('hovering the Comms icon draws the overlay', hover.overlay === true);
    // The same hover left STILL for 1.5 s, with nothing re-sent: does the overlay stay, and does the browser still say :hover?
    await sleep(1500);
    proof.idle = await cdp.call((sel) => ({ overlay: Boolean(document.querySelector('[data-flight-paths]')), hovered: document.querySelector(sel).matches(':hover') }), cellSel);
    say(`idle after 1.5 s still: ${JSON.stringify(proof.idle)}`);
    await mouse(cell.x, cell.y);
    await sleep(300);
    check('one arc per partner (six conversations)', hover.arcs.length === 6, hover.arcs.map((a) => a.peer));
    check('every arc has a real path, a visible stroke and a non-zero size', hover.arcs.length > 0 && hover.arcs.every((a) => a.d.length > 20 && a.strokeWidth > 0 && a.opacity > 0 && a.bbox.w > 5 && a.bbox.h > 5 && a.onScreen.w > 5 && a.onScreen.h > 5), hover.arcs.map((a) => ({ peer: a.peer, bbox: a.bbox, onScreen: a.onScreen, strokeWidth: a.strokeWidth, opacity: a.opacity })));
    check('the overlay never takes a click and sits above the table', hover.pointerEvents === 'none' && Number(hover.z) >= 10, { z: hover.z, pointerEvents: hover.pointerEvents });
    check('the arcs start at the pointer', hover.arcs.every((a) => { const m = /^M([-\d.]+),([-\d.]+)/.exec(a.d); return m !== null; }));
    check('a waiting thread is marked, dots on every arc', hover.arcs.some((a) => a.tone === 'waiting') && hover.arcs.every((a) => a.dots > 0), hover.arcs.map((a) => ({ peer: a.peer, tone: a.tone, direction: a.direction, pulse: a.pulse, label: a.label })));
    // The shadow (owner 2026-11-17): it meets the arc at both contact points, is unblurred and unshifted, never wider than the arc.
    check('every shadow meets its arc at both contact points (0.5 px), unblurred, never wider than the arc', hover.arcs.every((a) => a.shadowEnds && a.shadowEnds.start < 0.5 && a.shadowEnds.end < 0.5 && !a.shadowEnds.filter && !a.shadowEnds.transform && a.shadowEnds.width <= a.strokeWidth), hover.arcs.map((a) => ({ peer: a.peer, shadow: a.shadowEnds, strokeWidth: a.strokeWidth })));
    // The sender's colour (owner 2026-11-17): each arc in its sender's workspace colour; meridian's and vesper's workspaces differ.
    check('arcs are drawn in the sending workspace colour: two workspaces, two colours', hover.arcs.every((a) => /^#[0-9a-f]{6}$/.test(a.color ?? '') && a.drawn !== '') && new Set(hover.arcs.map((a) => a.drawn)).size >= 2, hover.arcs.map((a) => ({ peer: a.peer, direction: a.direction, color: a.color, drawn: a.drawn })));
    check('the other rows dim and the partners are tinted', hover.dimmed > 0 && hover.peers === 6, { dimmed: hover.dimmed, peers: hover.peers });
    holdAt(cell.x, cell.y);
    // No label covers row text or another label, measured in the real layout (getBoundingClientRect of each label and each text leaf).
    const overlaps = JSON.parse(await ev(`(() => {
      const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const labels = [...document.querySelectorAll('[data-arc-label]')].map((t) => ({ text: t.textContent, r: t.getBoundingClientRect() }));
      const leaves = [...document.querySelectorAll('[data-surface="dashboard"] *')].filter((e) => !e.closest('[data-flight-paths]') && e.childElementCount === 0 && (e.textContent ?? '').trim() !== '').map((e) => ({ text: e.textContent.trim().slice(0, 24), r: e.getBoundingClientRect() })).filter((l) => l.r.width > 0);
      const onText = [], onLabel = [];
      labels.forEach((l, i) => {
        leaves.forEach((t) => { if (hit(l.r, t.r)) onText.push(l.text + ' over ' + t.text); });
        labels.slice(i + 1).forEach((o) => { if (hit(l.r, o.r)) onLabel.push(l.text + ' over ' + o.text); });
      });
      return JSON.stringify({ labels: labels.length, onText, onLabel });
    })()`));
    proof.labels = overlaps;
    check('arcs carry labels, and none covers any text on the board (rows, headers) or another label', overlaps.labels > 0 && overlaps.onText.length === 0 && overlaps.onLabel.length === 0, overlaps);
    await shot('02-hover');
    release();

    // 3. THE POINTER MOVES INSIDE THE ICON: the arcs' origin follows.
    const startOf = (arcs) => arcs.map((a) => /^M([-\d.]+),([-\d.]+)/.exec(a.d).slice(1, 3).map(Number));
    const before = startOf(hover.arcs)[0];
    await mouse(cell.x + 5, cell.y + 3);
    holdAt(cell.x + 5, cell.y + 3);
    await sleep(300);
    const moved = JSON.parse(await ev(MEASURE));
    const after = startOf(moved.arcs)[0];
    check('the arcs follow the pointer while it moves within the icon', moved.arcs.length === hover.arcs.length && Math.abs(after[0] - before[0] - 5) < 1.5 && Math.abs(after[1] - before[1] - 3) < 1.5, { before, after });
    await shot('03-follow');
    release();

    // 4. THE CLIP: about three seconds of the hover, as Page.startScreencast frames, assembled into hover.gif.
    await startCast(960, 600);
    const t0 = Date.now();
    for (let n = 0; Date.now() - t0 < 3200; n += 1) {
        await mouse(cell.x + Math.sin(n / 5) * 6, cell.y + Math.cos(n / 7) * 3);
        await sleep(60);
    }
    await cdp.send('Page.stopScreencast');
    say(`${frames.length} screencast frames`);
    check('the screencast delivered frames', frames.length >= 8, frames.length);
    if (frames.length >= 2) {
        const dir = join(root, 'gifdeps');
        mkdirSync(dir, { recursive: true });
        const npm = spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', dir, 'gifenc', 'pngjs'], { encoding: 'utf8' });
        if (npm.status !== 0) { check('gif encoder installed', false, npm.stderr?.slice(-300)); } else {
            const req = createRequire(join(dir, 'x.js'));
            const { PNG } = req('pngjs');
            const { GIFEncoder, quantize, applyPalette } = req('gifenc');
            const gif = GIFEncoder();
            for (let i = 0; i < frames.length; i += 1) {
                const png = PNG.sync.read(Buffer.from(frames[i].data, 'base64'));
                const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
                const palette = quantize(rgba, 128, { format: 'rgb565' });
                const index = applyPalette(rgba, palette, 'rgb565');
                const next = frames[i + 1]?.at ?? frames[i].at + 0.06;
                gif.writeFrame(index, png.width, png.height, { palette, delay: Math.max(30, Math.min(200, Math.round((next - frames[i].at) * 1000))) });
            }
            gif.finish();
            writeFileSync(join(OUT, 'hover.gif'), Buffer.from(gif.bytes()));
            check('hover.gif written', true, { frames: frames.length });
        }
    }

    // 5. LEAVING clears it.
    await mouse(WIDTH - 40, HEIGHT - 40);
    await sleep(500);
    check('leaving the icon removes the overlay', (JSON.parse(await ev(MEASURE))).overlay === false);
} catch (error) {
    failed = true;
    say(`FAIL ${error?.stack ?? error}`);
    proof.error = String(error?.message ?? error);
}

proof.ok = !failed && proof.checks.every((c) => c.ok);
writeFileSync(join(OUT, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
say(proof.ok ? 'ALL PROVEN' : `NOT PROVEN: ${proof.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || proof.error}`);
finish(proof.ok ? 0 : 1);
