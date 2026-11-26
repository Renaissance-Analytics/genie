#!/usr/bin/env node
/**
 * THE ACCOUNTS POPOVER, AS A PERSON SEES IT, in the real app (Tynn #988; the owner: "the accounts popover should be wider
 * with the active account being the main view on the left with active stats and account info. additional account are to
 * the right of that stacking in a column, sorted by the account I should switch to next").
 *
 *   node scripts/accounts-popover-cdp.mjs            (Linux: under xvfb-run)
 *
 * It starts the app itself, with a home folder and a debugger port of its own, and SEEDS that home before the launch: the
 * account book (`.genie/runtime/accounts.json`) with five Claude accounts, and each one's last readings
 * (`.genie/headroom-board.json`), as the host itself saves them. Run on CI and the test VMs, never on a desktop.
 *
 *   the title bar's Claude chip → a click opens the popover → it is wide, two panes side by side → the left is the signed-in
 *   account with its email, plan and a bar per window → the right lists the others in switch-next order (a close call goes
 *   to the earliest reset; a spent one last) → an account with no plan has no "unknown" chip → Use another account is there.
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

let PORT = Number(process.env.ACCOUNTS_POPOVER_CDP_PORT ?? 9351);
const failures = [];
/** When this row began: nothing older is ever taken for one of its own processes (end-own-tree.mjs). */
const RUN_BEGAN = Date.now();
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A home of its own for one launch: a fresh folder, What's new seen, and an environment that points only at it. */
function freshHome() {
    const r = mkdtempSync(join(tmpdir(), 'accounts-popover-'));
    const h = join(r, 'home');
    mkdirSync(join(h, 'AppData', 'Roaming'), { recursive: true });
    mkdirSync(join(h, 'AppData', 'Local'), { recursive: true });
    // What's new for this version already seen: a fresh home would open it late, over the chip (Tynn #1009).
    seedWhatsNewSeen(join(h, '.genie'));
    const e = {
        ...process.env,
        HOME: h,
        USERPROFILE: h,
        APPDATA: join(h, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(h, 'AppData', 'Local'),
        XDG_CONFIG_HOME: join(h, '.config'),
        XDG_DATA_HOME: join(h, '.local', 'share'),
    };
    // Nobody is signed in to Claude here: the host's identity read at boot must not move the seeded active account.
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'GENIE_HOME']) delete e[key];
    return { root: r, home: h, log: join(r, 'electron.log'), env: e };
}
let { root, home, log, env } = freshHome();
const electron = createRequire(import.meta.url)('electron');

// THE SEED. Names are fixtures (no person). The expected order on the right, by the rule (core/switch-next.ts):
//   Soon (82 %, back in 30 min) before Lab (88 %, back in 2 h): a close call, the earliest reset first;
//   then Spare (30 %); then Old (spent), last.
const HOUR = 3_600_000;
const NOW = Date.now();
const hex = (c) => `account_${c.repeat(32)}`;
const ACTIVE = 'account_legacy_claude';
const LAB = hex('c'), SPARE = hex('b'), OLD = hex('d'), SOON = hex('e');
const EXPECTED_RIGHT = [SOON, LAB, SPARE, OLD];
const created = new Date(NOW - 86_400_000).toISOString();
const account = (id, label, email, plan, legacy = false, provider = 'claude') => ({
    id, provider, legacy, label, labelEdited: true, home: join(home, legacy ? `.${provider}` : join('.genie', 'accounts', provider, id)),
    identity: { name: null, email, plan }, createdAt: created,
});
const book = {
    version: 1,
    active: { claude: ACTIVE },
    accounts: [
        account(ACTIVE, 'Work', 'work@example.invalid', 'max 20x', true),
        account('account_legacy_codex', 'Account 1', null, null, true, 'codex'),
        account(LAB, 'Lab', 'lab@example.invalid', 'pro'),
        account(SPARE, 'Spare', 'spare@example.invalid', null),
        account(OLD, 'Old', 'old@example.invalid', 'pro'),
        account(SOON, 'Soon', 'soon@example.invalid', 'max'),
    ],
};
const win = (window, leftPct, resetsInMs, over = false) => ({ window, usedPct: 100 - leftPct, leftPct, resetsAtMs: NOW + resetsInMs, over });
const reading = (accountId, windows) => ({ source: { provider: 'claude', accountId }, runId: 'seed', room: { plan: null, window: windows[0].window, leftPct: windows[0].leftPct, resetsAtMs: windows[0].resetsAtMs, over: windows[0].over, windows } });
const board = [
    reading(ACTIVE, [win('5h', 20, HOUR), win('7d', 55, 40 * HOUR)]),
    reading(LAB, [win('5h', 90, 2 * HOUR), win('7d', 88, 60 * HOUR)]),
    reading(SPARE, [win('5h', 30, 3 * HOUR)]),
    reading(OLD, [win('5h', 0, HOUR, true)]),
    reading(SOON, [win('5h', 82, 30 * 60_000), win('7d', 95, 80 * HOUR)]),
];
mkdirSync(join(home, '.genie', 'runtime'), { recursive: true });
writeFileSync(join(home, '.genie', 'runtime', 'accounts.json'), JSON.stringify(book, null, 2));
// The board as the host saves it since Tynn #1070 (a bare list is from before and is not brought back).
writeFileSync(join(home, '.genie', 'headroom-board.json'), JSON.stringify({ format: 2, readings: board }));

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
/** genie-host is detached and outlives the window: this run's host is stopped by the pid in its own record, never a pattern. */
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
        // Tynn #1031: the app's tree, this run's genie-host and what they started (its updater helper is under neither the
        // app nor a tree kill of the host's pid), ended, waited for and said by one helper (end-own-tree.mjs).
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
/** A real click, as a person's: the mouse pressed and released at the middle of what the selector finds. */
async function click(cdp, selector) {
    await closeWhatsNew((expression) => cdp.evaluate(expression));
    const at = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!at) return false;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return true;
}

console.log('\nTHE ACCOUNTS POPOVER — what a person sees, in the real app\n');
const CHIP = '[data-title-bar] [data-account-chip="claude"]';
const POP = '[data-account-popover="claude"]';
let app = launch();
let cdp = null;
try {
    cdp = await Cdp.connect();
    check(await waitFor(cdp, `Boolean(document.querySelector('[data-route]'))`, 60_000), '0. the app is up, on a seeded home of its own');
    check(await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(CHIP)}))`, 30_000), '1. the title bar has the Claude account chip');
    const chipText = await cdp.evaluate(`document.querySelector(${JSON.stringify(CHIP)})?.textContent ?? ''`);
    check(chipText.includes('Work'), '2. the chip names the signed-in (seeded active) account', chipText);

    // What is under the mouse, and which element a click reaches: if the popover does not open, this says why.
    await cdp.evaluate(`(() => { window.__clicks = []; window.addEventListener('click', (e) => { window.__clicks.push((e.target.closest?.('[data-account-chip]') ? 'chip: ' : 'other: ') + (e.target.outerHTML ?? '').slice(0, 120)); }, true); return true; })()`);
    // A fresh home can open with a modal over the window (measured: a backdrop took the first real click). A person closes
    // it first; so does this run, with Escape, saying what it was. The click below is then a real one on the chip.
    const hitChip = `(() => { const el = document.querySelector(${JSON.stringify(CHIP)}); if (!el) return false; const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(at && at.closest('[data-account-chip]')); })()`;
    for (let i = 0; i < 3 && !(await cdp.evaluate(hitChip)); i++) {
        const modal = await cdp.evaluate(`(() => { const d = document.querySelector('[role="dialog"], [aria-modal="true"]'); return d ? d.innerText.replace(/\\s+/g, ' ').slice(0, 200) : '(no dialog element)'; })()`);
        console.log(`  a modal covers the window: ${modal}; pressing Escape`);
        for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await waitFor(cdp, hitChip, 3_000);
    }
    check(await cdp.evaluate(hitChip), '2b. nothing covers the chip: the mouse reaches it');
    const under = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(CHIP)}); const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return JSON.stringify({ rect: [r.left, r.top, r.width, r.height].map(Math.round), viewport: [innerWidth, innerHeight], under: at ? (at.closest('[data-account-chip]') ? 'the chip' : at.outerHTML.slice(0, 160)) : null }); })()`);
    console.log(`  under the mouse: ${under}`);
    check(await click(cdp, CHIP), '3. the chip takes a mouse click');
    let opened = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(POP)}))`, 5_000);
    console.log(`  clicks the page saw: ${await cdp.evaluate('JSON.stringify(window.__clicks)')}`);
    check(opened, '4. a mouse click on the chip opens the popover');
    if (!opened) {
        // CONTROL: the chip's own click handler, so the layout below is still measured and the failure above stays named.
        await cdp.evaluate(`document.querySelector(${JSON.stringify(CHIP)}).click(); true`);
        opened = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(POP)}))`, 5_000);
        console.log(`  control (element.click()): ${opened ? 'the popover opened' : 'it did not open either'}`);
    }
    if (!opened) throw new Error('the popover never opened');
    // The popover is drawn off screen (-9999) until it is positioned under its chip: measure it there, not before.
    check(await waitFor(cdp, `(() => { const r = document.querySelector(${JSON.stringify(POP)})?.getBoundingClientRect(); return Boolean(r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1); })()`, 5_000), '4b. it is positioned on screen, under the chip');
    const seen = JSON.parse(await cdp.evaluate(`JSON.stringify((() => {
        const pop = document.querySelector(${JSON.stringify(POP)});
        const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const left = pop.querySelector('[data-accounts-pane="active"]');
        const right = pop.querySelector('[data-accounts-pane="others"]');
        const another = pop.querySelector('[data-action="account-use-another"]');
        return {
            layout: pop.getAttribute('data-layout'),
            pop: box(pop), left: box(left), right: box(right), viewport: window.innerWidth,
            leftIds: left ? [...left.querySelectorAll('[data-account]')].map((s) => s.getAttribute('data-account')) : [],
            leftText: left?.textContent ?? '',
            leftPlan: left?.querySelector('[data-account-plan]')?.textContent ?? null,
            leftBars: left ? left.querySelectorAll('[data-account-window] [role="progressbar"]').length : 0,
            leftSignedIn: Boolean(left?.querySelector('[data-account-active]')),
            rightIds: right ? [...right.querySelectorAll('[data-account]')].map((s) => s.getAttribute('data-account')) : [],
            rightRanks: right ? [...right.querySelectorAll('[data-account]')].map((s) => s.getAttribute('data-switch-rank')) : [],
            rightTops: right ? [...right.querySelectorAll('[data-account]')].map((s) => s.getBoundingClientRect().top) : [],
            switches: right ? [...right.querySelectorAll('[data-account]')].filter((s) => s.querySelectorAll('[data-action="account-switch"], [data-action="account-sign-in"]').length === 1).length : 0,
            plans: [...pop.querySelectorAll('[data-account-plan]')].map((p) => p.textContent),
            sparePlan: Boolean(pop.querySelector('[data-account="${SPARE}"] [data-account-plan]')),
            another: box(another),
            design: Boolean(pop.querySelector('[data-design-auth]')),
        };
    })())`));
    console.log(`  seen: ${JSON.stringify({ ...seen, leftText: seen.leftText.slice(0, 120) })}`);
    check(seen.layout === 'two-pane', '5. the popover is the two-pane layout', String(seen.layout));
    check(seen.pop && seen.pop.width >= Math.min(560, seen.viewport - 32), '6. it is wide (>= 560 px, or the window allows less)', `${seen.pop?.width} of ${seen.viewport}`);
    check(seen.left && seen.right && seen.right.left >= seen.left.right - 1 && Math.abs(seen.right.top - seen.left.top) < 4,
        '7. the panes sit side by side: the others to the RIGHT of the active one, tops aligned', `left ${JSON.stringify(seen.left)} right ${JSON.stringify(seen.right)}`);
    check(seen.left && seen.right && seen.left.width > seen.right.width, '8. the active pane is the main (wider) view', `${seen.left?.width} vs ${seen.right?.width}`);
    check(JSON.stringify(seen.leftIds) === JSON.stringify([ACTIVE]), '9. the left pane is the signed-in account only', JSON.stringify(seen.leftIds));
    check(seen.leftText.includes('work@example.invalid') && seen.leftPlan === 'max 20x' && seen.leftSignedIn, '10. with its email, plan and signed-in state', `${seen.leftPlan}, signed in ${seen.leftSignedIn}`);
    check(seen.leftBars === 2, '11. and a bar per window (5h, 7d)', String(seen.leftBars));
    check(JSON.stringify(seen.rightIds) === JSON.stringify(EXPECTED_RIGHT), '12. the right column is in switch-next order: Soon, Lab, Spare, Old', JSON.stringify(seen.rightIds));
    check(JSON.stringify(seen.rightRanks) === JSON.stringify(['1', '2', '3', '4']), '13. ranked 1..4', JSON.stringify(seen.rightRanks));
    check(seen.rightTops.every((t, i) => i === 0 || t > seen.rightTops[i - 1]), '14. stacked in a column, top to bottom', JSON.stringify(seen.rightTops.map(Math.round)));
    check(seen.switches === 4, '15. each other account has its ONE action: Switch, or (not signed in now) Sign in in the browser (Tynn #1011)', String(seen.switches));
    check(!seen.sparePlan && !seen.plans.includes('unknown'), '16. no "unknown" plan chip: an account with no plan has none', JSON.stringify(seen.plans));
    check(seen.plans.includes('pro'), '17. CONTROL: a known plan does draw its chip', JSON.stringify(seen.plans));
    check(Boolean(seen.another && seen.another.width > 0 && seen.another.bottom <= seen.pop.bottom + 1), '18. Use another account is there, inside the popover', JSON.stringify(seen.another));
    console.log(`  Claude Design section: ${seen.design ? 'shown' : 'not shown (the host reports no Design state)'}`);
    // A picture for the person: what this run saw.
    try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (shot.result?.data) { mkdirSync('ci-out', { recursive: true }); writeFileSync(join('ci-out', 'accounts-popover-988.png'), Buffer.from(shot.result.data, 'base64')); console.log('  screenshot: ci-out/accounts-popover-988.png'); }
    } catch (error) { console.log(`  screenshot: none (${String(error)})`); }
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
    if (failures.length > 0) {
        const hostLog = join(home, '.genie', 'logs', 'genie-host.log');
        if (existsSync(hostLog)) console.log(`  genie-host.log (accounts):\n    ${readFileSync(hostLog, 'utf8').split(/\r?\n/).filter((l) => /account|identity|headroom/i.test(l)).slice(-20).join('\n    ')}`);
    }
}

/*
 * EVERY ACCOUNT'S OWN WINDOWS (Tynn #1070; the owner: "ALL FUCKING ACCOUNTS ARE SHARING THE SAME FUCKING 5 HR RATE counter").
 * The home seeded again, then the app started again, twice: Main active (5 h spent, its week at 64 %, a switch offer standing),
 * then Weekly active (an account with NO 5 h window, its week at 95 % and a per-model weekly cap at half). A third account was
 * never read. Each phase draws the popover and Settings → Providers and takes their pictures for the owner's review.
 */
// Main is the default home's account, as the first seed's active one is: a book with no default-home Claude account showed no window.
const MAIN = 'account_legacy_claude', WEEKLY = hex('2'), NEVER = hex('3');
const book1070 = (active) => ({
    version: 1,
    active: { claude: active },
    accounts: [
        account(MAIN, 'Main', 'main@example.invalid', 'max 20x', true),
        account(WEEKLY, 'Weekly', 'weekly@example.invalid', 'max 5x'),
        account(NEVER, 'Never read', 'never@example.invalid', 'pro'),
        account('account_legacy_codex', 'Account 1', null, null, true, 'codex'),
    ],
});
const main5h = win('5h', 0, 72 * 60_000);
const board1070 = { format: 2, readings: [
    reading(MAIN, [main5h, win('7d', 64, 116 * HOUR)]),
    reading(WEEKLY, [win('7d', 95, 140 * HOUR), win('7d fable', 50, 140 * HOUR)]),
] };
// A standing offer made when Main had 4 % left: it must say the bar's figure now (0 %), not the one it was made with.
const offer1070 = { offered: { [`${MAIN}|5h`]: main5h.resetsAtMs }, pending: [{ id: `switch-offer:${MAIN}:5h:${main5h.resetsAtMs}`, provider: 'claude', accountId: MAIN, label: 'Main', window: '5h', leftPct: 4, over: false, resetsAtMs: main5h.resetsAtMs }] };
function seed1070(active) {
    writeFileSync(join(home, '.genie', 'runtime', 'accounts.json'), JSON.stringify(book1070(active), null, 2));
    writeFileSync(join(home, '.genie', 'headroom-board.json'), JSON.stringify(board1070));
    writeFileSync(join(home, '.genie', 'switch-offers.json'), JSON.stringify(offer1070));
}
async function shoot(c, name) {
    try {
        const shot = await c.send('Page.captureScreenshot', { format: 'png' });
        if (shot.result?.data) { mkdirSync('ci-out', { recursive: true }); writeFileSync(join('ci-out', name), Buffer.from(shot.result.data, 'base64')); console.log(`  screenshot: ci-out/${name}`); }
    } catch (error) { console.log(`  screenshot ${name}: none (${String(error)})`); }
}
const windowsIn = async (c, id) => JSON.parse(await c.evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(`${POP} [data-account="${id}"] [data-account-window]`)})].map((w) => w.getAttribute('data-account-window')))`));
const escape = async (c) => { for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
async function phase1070(active, tag) {
    console.log(`\n#1070 — ${tag}\n`);
    // A home and a debugger port of its own, as the first launch had: nothing of an earlier launch is inherited.
    ({ root, home, log, env } = freshHome());
    PORT += 1;
    mkdirSync(join(home, '.genie', 'runtime'), { recursive: true });
    seed1070(active);
    const app2 = launch();
    let c = null;
    try {
        c = await Cdp.connect();
        check(await waitFor(c, `Boolean(document.querySelector(${JSON.stringify(CHIP)}))`, 60_000), `${tag} 1. the app is up, with the Claude chip`);
        const reach = `(() => { const el = document.querySelector(${JSON.stringify(CHIP)}); if (!el) return false; const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(at && at.closest('[data-account-chip]')); })()`;
        for (let i = 0; i < 3 && !(await c.evaluate(reach)); i++) { await escape(c); await sleep(500); }
        check(await click(c, CHIP), `${tag} 2. a click on the chip`);
        check(await waitFor(c, `(() => { const r = document.querySelector(${JSON.stringify(POP)})?.getBoundingClientRect(); return Boolean(r && r.left >= 0 && r.top >= 0); })()`, 8_000), `${tag} 3. opens the popover, on screen`);
        const main = await windowsIn(c, MAIN), weekly = await windowsIn(c, WEEKLY), never = await windowsIn(c, NEVER);
        check(JSON.stringify(main) === JSON.stringify(['5h', '7d']), `${tag} 4. Main shows ITS windows: 5h and 7d`, JSON.stringify(main));
        check(JSON.stringify(weekly) === JSON.stringify(['7d', '7d fable']), `${tag} 5. Weekly shows its week and its per-model weekly cap, and NO 5h bar`, JSON.stringify(weekly));
        const pct = JSON.parse(await c.evaluate(`JSON.stringify(Object.fromEntries([...document.querySelectorAll(${JSON.stringify(`${POP} [data-account] [data-account-window]`)})].map((w) => [w.closest('[data-account]').getAttribute('data-account') + ' ' + w.getAttribute('data-account-window'), ((w.textContent || '').match(/\\d+%|over/) || [''])[0]])))`));
        check(pct[`${MAIN} 5h`] === '0%' && pct[`${MAIN} 7d`] === '64%' && pct[`${WEEKLY} 7d`] === '95%' && pct[`${WEEKLY} 7d fable`] === '50%', `${tag} 6. different accounts, different figures`, JSON.stringify(pct));
        const unknown = await c.evaluate(`document.querySelector(${JSON.stringify(`${POP} [data-account="${NEVER}"] [data-account-usage-unknown]`)})?.textContent ?? null`);
        check(never.length === 0 && /unknown/.test(String(unknown)), `${tag} 7. the account never read says unknown, with no bars`, `${JSON.stringify(never)} ${unknown}`);
        const callout = await c.evaluate(`document.querySelector(${JSON.stringify(`${POP} [data-switch-offer]`)})?.textContent ?? null`);
        if (active === MAIN) {
            check(String(callout).includes('Main: 0% left in the 5-hour window.') && !/window window|of its/.test(String(callout)), `${tag} 8. the switch offer says the bar's figure, in words that read`, String(callout));
            check(String(callout).includes('Weekly (50% left in the 7d fable window)') && String(callout).includes('Never read (room not known yet)'), `${tag} 9. its suggestions name each account's own tightest window`, String(callout));
        } else {
            check(callout === null, `${tag} 8. no offer stands for Weekly, whose windows have room`, String(callout));
        }
        await shoot(c, `accounts-1070-popover-${tag}.png`);
        // Settings → Providers → Accounts: the same accounts, each with its own windows.
        await escape(c);
        await c.evaluate(`window.location.hash = '#genie://settings'; true`);
        if (await waitFor(c, `Boolean(document.querySelector('[data-settings-nav="providers"]'))`, 15_000)) await click(c, '[data-settings-nav="providers"]');
        const listed = await waitFor(c, `Boolean(document.querySelector('[data-settings-account="${WEEKLY}"]'))`, 15_000);
        check(listed, `${tag} 10. Settings → Providers lists the accounts`);
        if (listed) {
            await c.evaluate(`document.querySelector('[data-settings-account="${MAIN}"]').scrollIntoView({ block: 'start' }); true`);
            await sleep(300);
            const rows = await c.evaluate(`JSON.stringify(Object.fromEntries([${JSON.stringify(MAIN)}, ${JSON.stringify(WEEKLY)}, ${JSON.stringify(NEVER)}].map((id) => { const r = document.querySelector('[data-settings-account="' + id + '"]'); return [id, r ?[...r.querySelectorAll('[data-account-usage]')].map((u) => u.getAttribute('data-account-usage')).concat(r.querySelector('[data-account-usage-unknown]') ? ['unknown'] : []) : null]; })))`);
            check(rows === JSON.stringify({ [MAIN]: ['5h', '7d'], [WEEKLY]: ['7d', '7d fable'], [NEVER]: ['unknown'] }), `${tag} 11. there too: Main 5h+7d, Weekly 7d+7d fable, Never read unknown`, rows);
            await shoot(c, `accounts-1070-settings-${tag}.png`);
        }
    } catch (error) {
        check(false, `${tag}: the phase did not finish`, error instanceof Error ? error.message : String(error));
        if (existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-2000));
        const phaseHostLog = join(home, '.genie', 'logs', 'genie-host.log');
        if (existsSync(phaseHostLog)) console.log(`  genie-host.log:\n    ${readFileSync(phaseHostLog, 'utf8').split(/\r?\n/).slice(-30).join('\n    ')}`);
    } finally {
        if (c) c.close();
        await stop(app2);
        try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
    }
}
try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
await phase1070(MAIN, 'main-active');
await phase1070(WEEKLY, 'weekly-active');

if (failures.length > 0) {
    console.log(`\nACCOUNTS POPOVER FAILED — ${failures.length} check(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
console.log('\nACCOUNTS POPOVER OK');
process.exit(0);
