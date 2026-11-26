#!/usr/bin/env node
/**
 * EVERY SOUND HAS A SIGHT, AS A PERSON SEES IT (Tynn #1057; the owner, 2026-11-26: "I still have genie events that emit
 * sounds but with no visual cues in the dashboard or sidebar like I asked for. The folder icon in the sidebar items is
 * useless").
 *
 *   node scripts/sound-cues-cdp.mjs                 (Linux: under xvfb-run)
 *   SOUND_CUES_BASE=1 node scripts/sound-cues-cdp.mjs   (a tree from before #1057: only the "before" pictures)
 *
 * It starts the app itself, on a home of its own with three workspaces and four agents, and a debugger port of its own.
 * Run on CI and the test VMs, never on a desktop.
 *
 *   The sidebar before anything sounds (on a tree from before #1057, its folder icons) → the sounds OFF (the master switch:
 *   the person may have them off) → eleven events of nine kinds, raised through the window's own handlers (the alerts'
 *   path, main's `genie:action` path; GENIE_PAGE_PROBE's door) → each workspace row's slot is the icon of its newest
 *   unseen event, no folder; each agent row has its own; the Dashboard row has the machine's → the Dashboard's activity
 *   lists every one → a workspace dashboard lists its own and the machine's, seen ones dimmed and a new one not → "All
 *   seen" clears the strip and the slots. Pictures at 1280x800: ci-out/sound-cues-1057-*-<platform>.png.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew, seedWhatsNewSeen } from './cdp-whats-new.mjs';
import { spawn } from 'node:child_process';
import { endOwnRun } from './end-own-tree.mjs';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.GENIE_PAGE_PROBE ??= '1';

const PORT = Number(process.env.SOUND_CUES_CDP_PORT ?? 9355);
const BASE = process.env.SOUND_CUES_BASE === '1';
const PLATFORM = process.platform === 'win32' ? 'windows' : process.platform;
const LABEL = BASE ? 'base' : 'after';
const failures = [];
const RUN_BEGAN = Date.now();
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// THE HOME: three workspaces (each a folder of its own) and four agents, none started (manual).
const root = mkdtempSync(join(tmpdir(), 'sound-cues-'));
const home = join(root, 'home');
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
const runtime = join(home, '.genie', 'runtime');
mkdirSync(runtime, { recursive: true });
seedWhatsNewSeen(join(home, '.genie'));
const WORKSPACES = ['tynn', 'fancy', 'aionima'];
for (const w of WORKSPACES) mkdirSync(join(root, 'work', w), { recursive: true });
writeFileSync(join(runtime, 'workspaces.json'), JSON.stringify(WORKSPACES.map((id) => ({ id, path: join(root, 'work', id) })), null, 2));
const agentId = (hex) => `agent_${hex.repeat(4)}`;
const AGENTS = [
    { id: agentId('a1b2c3d4'), name: 'atlas', workspaceId: 'tynn', provider: 'claude' },
    { id: agentId('b2c3d4e5'), name: 'wren', workspaceId: 'tynn', provider: 'codex' },
    { id: agentId('c3d4e5f6'), name: 'kai', workspaceId: 'fancy', provider: 'claude' },
    { id: agentId('d4e5f6a7'), name: 'mira', workspaceId: 'aionima', provider: 'codex' },
];
const created = new Date().toISOString();
writeFileSync(join(runtime, 'agents.json'), JSON.stringify(AGENTS.map((a) => ({ ...a, instructions: null, threadId: null, createdAt: created, lastUsedAt: null, mode: 'manual', accessScope: 'none' })), null, 2));
const [ATLAS, WREN, KAI, MIRA] = AGENTS;

const log = join(root, 'electron.log');
const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
};
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'GENIE_HOME']) delete env[key];
const electron = createRequire(import.meta.url)('electron');

function launch() {
    const out = openSync(log, 'a');
    const args = ['.', `--remote-debugging-port=${PORT}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
    return spawn(electron, args, { env, stdio: ['ignore', out, out], detached: process.platform !== 'win32', windowsHide: false });
}
function hostPid() {
    try {
        const raw = JSON.parse(readFileSync(join(home, '.genie', 'runtime', 'host.json'), 'utf8'));
        return typeof raw.pid === 'number' ? raw.pid : null;
    } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
async function stopHost(pid) {
    if (pid === null || !alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* it has gone */ }
    for (const end = Date.now() + 15_000; alive(pid) && Date.now() < end;) await sleep(100);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* it has gone */ } }
}
async function stop(app) {
    const host = hostPid();
    const gone = new Promise((r) => { if (app.exitCode !== null) r(); else app.once('exit', r); });
    if (process.platform === 'win32') {
        const ended = await endOwnRun({ app, hostPid: host, since: RUN_BEGAN });
        check(ended.ok, 'nothing of this run is left running by its own cleanup', ended.ok ? '' : `LEFT RUNNING by this row's own cleanup: ${ended.words}`);
    } else {
        try { process.kill(-app.pid, 'SIGTERM'); } catch { /* it has gone */ }
    }
    await Promise.race([gone, sleep(20_000)]);
    if (app.exitCode === null && process.platform !== 'win32') { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* it has gone */ } }
    await stopHost(host);
}

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect() {
        const until = Date.now() + 90_000;
        let page = null;
        let last = 'no attempt';
        while (Date.now() < until && !page) {
            try {
                const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();
                page = mainWindow(targets);
                last = `no page yet (${targets.length})`;
            } catch (error) { last = String(error); }
            if (!page) await sleep(500);
        }
        if (!page) throw new Error(`no window on the debugger port: ${last}`);
        const c = new Cdp();
        c.#ws = new WebSocket(page.webSocketDebuggerUrl);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('the page\'s debugger socket did not open within 15 s')), 15_000);
            c.#ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
            c.#ws.addEventListener('error', () => { clearTimeout(timer); rej(new Error('CDP socket error')); }, { once: true });
        });
        return c;
    }
    send(method, params = {}) {
        const id = this.#id++;
        return new Promise((r, rej) => {
            const timer = setTimeout(() => { this.#pending.delete(id); rej(new Error(`no answer to ${method} within 120 s`)); }, 120_000);
            this.#pending.set(id, (f) => { clearTimeout(timer); r(f); });
            this.#ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (f.error) throw new Error(`CDP: ${JSON.stringify(f.error)}`);
        if (f.result.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result.result.value;
    }
    close() { this.#ws.close(); }
}
async function waitFor(cdp, expression, ms = 30_000) {
    for (const until = Date.now() + ms; Date.now() < until;) {
        if (await cdp.evaluate(expression)) return true;
        await sleep(200);
    }
    return false;
}
/** A real click: the mouse pressed and released at the middle of what the selector finds, refused unless it reaches it. */
async function click(cdp, selector) {
    await closeWhatsNew((expression) => cdp.evaluate(expression));
    const at = await cdp.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        // Nearest, never centred: centring scrolled the narrow board sideways and cut its first column off the picture.
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, reaches: Boolean(hit && (hit === el || el.contains(hit))), under: hit ? hit.outerHTML.slice(0, 120) : null };
    })()`);
    if (!at) return false;
    if (!at.reaches) { console.log(`  the mouse at ${selector} would reach: ${at.under}`); return false; }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return true;
}
/** A picture of the window, or of what `selector` draws (`scale` 2 for a row, so its icon can be read). */
async function shot(cdp, name, selector = null, scale = 1) {
    const file = `sound-cues-1057-${name}-${LABEL}-${PLATFORM}.png`;
    try {
        // Every board back at its left edge, as a person who has not scrolled sees it.
        await cdp.evaluate(`(() => { for (const el of document.querySelectorAll('*')) if (el.scrollLeft) el.scrollLeft = 0; return true; })()`);
        await sleep(150);
        let clip;
        if (selector) {
            const r = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const b = el.getBoundingClientRect(); return [b.left, b.top, b.width, b.height]; })()`);
            if (!r) { console.log(`  screenshot ${file}: nothing at ${selector}`); return; }
            clip = { x: Math.max(0, r[0] - 4), y: Math.max(0, r[1] - 4), width: r[2] + 8, height: r[3] + 8, scale };
        }
        const s = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) });
        if (s.result?.data) { mkdirSync('ci-out', { recursive: true }); writeFileSync(join('ci-out', file), Buffer.from(s.result.data, 'base64')); console.log(`  screenshot: ci-out/${file}`); }
    } catch (error) { console.log(`  screenshot ${file}: none (${String(error)})`); }
}
const bridge = '(window.genieTest ?? window.genie)';
const go = async (cdp, route) => { await cdp.evaluate(`window.location.hash = ${JSON.stringify(`#${route}`)}; true`); await sleep(800); };
const alert = (cdp, a) => cdp.evaluate(`window.genieAlertProbe(${JSON.stringify(a)}); true`);
const action = (cdp, a) => cdp.evaluate(`window.genieSoundProbe(${JSON.stringify(a)}); true`);
/** What each workspace row's icon slot shows, and whether any row still draws a folder. */
const ROWS = `JSON.stringify((() => {
    const rows = [...document.querySelectorAll('[data-rail="expanded"] [data-workspace]')];
    return { n: rows.length, folders: rows.filter((r) => r.querySelector('svg.lucide-folder')).length, slots: Object.fromEntries(rows.map((r) => [r.getAttribute('data-workspace'), r.querySelector('[data-cue-slot]')?.getAttribute('data-cue-slot') ?? null])) };
})())`;

let app = launch();
let cdp = null;
try {
    cdp = await Cdp.connect();
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    check(await waitFor(cdp, `Boolean(document.querySelector('[data-route]'))`, 60_000), '0. the app is up, on a home of its own');
    for (let i = 0; i < 3 && (await cdp.evaluate(`Boolean(document.querySelector('[aria-modal="true"]'))`)); i++) {
        for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await sleep(500);
    }
    await closeWhatsNew((expression) => cdp.evaluate(expression));
    await go(cdp, 'genie://dashboard');
    check(await waitFor(cdp, `document.querySelectorAll('[data-rail="expanded"] [data-workspace]').length === 3`, 60_000), '1. the sidebar lists the three workspaces (the positive control for every row check below)', await cdp.evaluate(ROWS));
    // A fresh home's agents are stopped, and Stopped is hidden by default (on the Dashboard and the sidebar's Agents view alike).
    if (!(await cdp.evaluate(`document.querySelector('[data-dashboard-filter="stopped"]')?.getAttribute('aria-pressed') === 'true'`))) await click(cdp, '[data-dashboard-filter="stopped"]');
    const LISTED = `JSON.stringify([...document.querySelectorAll('[data-dashboard-list] [data-agent]')].map((e) => e.getAttribute('data-agent')))`;
    check(await waitFor(cdp, `(() => { const ids = JSON.parse(${LISTED}); return ${JSON.stringify(AGENTS.map((a) => a.id))}.every((id) => ids.includes(id)); })()`, 30_000), '2. the Dashboard lists the four agents (and Genie’s own)', await cdp.evaluate(LISTED));
    await sleep(1000);
    const before = JSON.parse(await cdp.evaluate(ROWS));
    console.log(`  before: ${JSON.stringify(before)}`);
    await shot(cdp, 'sidebar-before', '[data-rail]');
    await shot(cdp, 'row-before', '[data-rail="expanded"] [data-workspace="tynn"]', 3);
    await shot(cdp, 'dashboard-before');

    if (BASE) {
        // A tree from before #1057: what the owner sees today. Its rows draw a folder; there is no probe's door to raise events.
        check(before.folders === 3, 'B1. (before #1057) every workspace row draws a folder icon', JSON.stringify(before));
    } else {
        check(before.folders === 0, '3. no workspace row draws a folder icon', JSON.stringify(before));
        check(Object.values(before.slots).every((s) => s === ''), '4. nothing sounded yet: every row’s slot is empty (the slot is there, holding nothing)', JSON.stringify(before.slots));
        check(await waitFor(cdp, `typeof window.genieSoundProbe === 'function' && typeof window.genieAlertProbe === 'function'`, 20_000), '5. the probe’s doors are open (GENIE_PAGE_PROBE)');

        // THE SOUNDS OFF (the master switch), and a sound chosen for the kinds that are None by default.
        for (const [key, value] of [['notification_sounds', false], ['sound_thumbsup', 'synth'], ['sound_edits', 'synth'], ['sound_exits', 'synth'], ['sound_sitedown', 'synth'], ['sound_flowdone', 'synth'], ['sound_ghpr', 'synth'], ['sound_ghsecurity', 'synth']]) {
            await cdp.evaluate(`${bridge}.features.act({ kind: 'settings.set', key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)} }).then(() => true)`);
        }
        check(await waitFor(cdp, `${bridge}.features.snapshot().then((f) => f.settings?.values?.notification_sounds === false && f.settings?.values?.sound_exits === 'synth')`, 15_000), '6. the sounds are OFF, and a sound is chosen for the kinds that are None by default');
        await sleep(1500);

        // ELEVEN EVENTS, NINE KINDS: on agents of all three workspaces, on workspaces with no agent, and on no workspace.
        await alert(cdp, { kind: 'finished', workspace: 'tynn', agent: WREN.name, agentId: WREN.id, detail: 'wren finished: PR #2210 is up' });
        await action(cdp, { agentId: KAI.id, kind: 'edits' });
        await action(cdp, { agentId: KAI.id, kind: 'thumbsup', reason: 'tests pass' });
        await action(cdp, { agentId: null, kind: 'exits', workspaceId: 'aionima' });
        await action(cdp, { agentId: null, kind: 'ghpr' });
        await action(cdp, { agentId: null, kind: 'sitedown', workspaceId: 'fancy' });
        await action(cdp, { agentId: null, kind: 'limit-alert', sound: 'synth', title: 'Claude: 9% of the 5-hour limit left', body: 'Resets at 16:00' });
        await alert(cdp, { kind: 'ghsecurity', workspace: '—', agent: 'Toolchain', detail: 'git 2.45.1 needs a security update' });
        await alert(cdp, { kind: 'broken', workspace: 'aionima', agent: MIRA.name, agentId: MIRA.id, detail: 'exited with code 1' });
        await alert(cdp, { kind: 'question', workspace: 'tynn', agent: ATLAS.name, agentId: ATLAS.id, detail: 'Ship beta.67 now?' });
        await alert(cdp, { kind: 'mail', workspace: 'aionima', agent: MIRA.name, agentId: MIRA.id, detail: 'mira: the migration plan is ready' });
        await sleep(1500);

        const rows = JSON.parse(await cdp.evaluate(ROWS));
        console.log(`  after: ${JSON.stringify(rows)}`);
        check(rows.n === 3 && rows.folders === 0, '7. still no folder on any row', JSON.stringify(rows));
        check(rows.slots.tynn === 'question' && rows.slots.fancy === 'sitedown' && rows.slots.aionima === 'mail', '8. each workspace row’s slot is the icon of ITS newest unseen event: tynn a question, fancy a site down, aionima mail', JSON.stringify(rows.slots));
        const nav = await cdp.evaluate(`document.querySelector('[data-rail="expanded"] [data-nav="genie://dashboard"] [data-sound-cue]')?.getAttribute('data-sound-cue') ?? null`);
        check(nav === 'ghsecurity', '9. the Dashboard row carries what belongs to no workspace: the newest, the toolchain’s security alert', String(nav));
        // The toasts the alerts raised fade; the pictures are of what STAYS.
        await sleep(9000);
        await shot(cdp, 'sidebar', '[data-rail]');
        await shot(cdp, 'row', '[data-rail="expanded"] [data-workspace="tynn"]', 3);
        const strip = JSON.parse(await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('[data-sound-activity="dashboard"] [data-cue-kind]')].map((e) => [e.getAttribute('data-cue-kind'), e.getAttribute('data-cue-seen')]))`));
        check(strip.length === 11 && strip.every(([, seen]) => seen === 'false'), '10. the Dashboard’s activity lists all eleven, unseen', JSON.stringify(strip));
        check(['finished', 'edits', 'thumbsup', 'exits', 'ghpr', 'sitedown', 'ratelimit', 'ghsecurity', 'broken', 'question', 'mail'].every((k) => strip.some(([kind]) => kind === k)), '11. every kind raised is in it', JSON.stringify(strip.map(([k]) => k)));
        await shot(cdp, 'dashboard');

        // THE AGENTS VIEW: each agent's row has its own.
        check(await click(cdp, '[data-rail-view="agents"]'), '12. the sidebar’s Agents view takes a click');
        await sleep(800);
        const agentCues = JSON.parse(await cdp.evaluate(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('[data-rail-agent]')].map((r) => [r.getAttribute('data-rail-agent'), r.querySelector('[data-sound-cue]')?.getAttribute('data-sound-cue') ?? null])))`));
        check(agentCues[ATLAS.id] === 'question' && agentCues[WREN.id] === 'finished' && agentCues[KAI.id] === 'thumbsup' && agentCues[MIRA.id] === 'mail', '13. each agent row shows its own newest: atlas a question, wren finished, kai a thumbs-up, mira mail', JSON.stringify(agentCues));
        await shot(cdp, 'sidebar-agents', '[data-rail]');
        check(await click(cdp, '[data-rail-view="workspaces"]'), '14. back to the Workspaces view');
        await sleep(500);

        // A WORKSPACE DASHBOARD: arriving sees what happened there (dimmed, still listed); a new event there stands out.
        await go(cdp, 'genie://workspace/fancy');
        check(await waitFor(cdp, `Boolean(document.querySelector('[data-sound-activity="fancy"]'))`, 20_000), '15. the workspace dashboard has its activity');
        await action(cdp, { agentId: null, kind: 'flowdone', workspaceId: 'fancy' });
        await sleep(1200);
        const wsList = JSON.parse(await cdp.evaluate(`JSON.stringify([...document.querySelectorAll('[data-sound-activity="fancy"] [data-cue-kind]')].map((e) => [e.getAttribute('data-cue-kind'), e.getAttribute('data-cue-seen')]))`));
        const has = (k, seen) => wsList.some(([kind, s]) => kind === k && s === seen);
        check(has('flowdone', 'false') && has('sitedown', 'true') && has('thumbsup', 'true') && has('ratelimit', 'false') && !wsList.some(([k]) => k === 'question'), '16. it lists fancy’s own (seen by arriving, dimmed) and the new flow run (unseen), the machine’s, and nothing of tynn’s', JSON.stringify(wsList));
        await sleep(8000);
        await shot(cdp, 'workspace-dashboard');

        // ALL SEEN: one click on the Dashboard, and the strip and every slot are clear.
        await go(cdp, 'genie://dashboard');
        check(await click(cdp, '[data-cue-see-all]'), '17. "All seen" takes a click');
        await sleep(800);
        const cleared = JSON.parse(await cdp.evaluate(ROWS));
        check(!(await cdp.evaluate(`Boolean(document.querySelector('[data-sound-activity="dashboard"]'))`)) && Object.values(cleared.slots).every((s) => s === ''), '18. seen: the Dashboard’s strip is gone and every slot is empty again', JSON.stringify(cleared.slots));
        await shot(cdp, 'all-seen');
    }
} catch (error) {
    check(false, 'the run did not finish', error instanceof Error ? error.message : String(error));
} finally {
    if (cdp) {
        try {
            if (failures.length > 0) console.log(`  on screen: ${String(await cdp.evaluate(`document.body?.innerText?.slice(0, 600) ?? ''`)).replace(/\s+/g, ' ')}`);
        } catch { /* the page has gone */ }
        cdp.close();
    }
    await stop(app);
    if (failures.length > 0 && existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-2000));
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}

if (failures.length > 0) {
    console.log(`\nSOUND CUES FAILED — ${failures.length} check(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
console.log('\nSOUND CUES OK');
process.exit(0);
