#!/usr/bin/env node
/**
 * CLAUDE ACCOUNTS OF THEIR OWN, AS A PERSON SEES AND USES THEM, in the real app (Tynn #1011).
 *
 *   node scripts/claude-accounts-cdp.mjs            (Linux: under xvfb-run; CI and test VMs only, never a desktop)
 *
 * It starts the app with a home and a debugger port of its own, SEEDS the account book with Claude accounts that each have
 * their own configuration directory, and points Genie at a STAND-IN `claude` (GENIE2_CLAUDE_BINARY) whose `auth status
 * --json` answers per CLAUDE_CONFIG_DIR, as the real CLI does. No real account, key or token exists here. So the live state
 * the popover shows went through Genie's real path: prism-acp `describe` in each directory, `compare`, the host's book, the
 * protocol, the chip.
 *
 *   the chip names the active account → the popover shows its live state (Signed in, Subscription, its org) → an account
 *   signed in with a Console key where a subscription was chosen shows a typed Mismatch → an account not signed in offers
 *   Sign in, not Switch → Switch on another account makes it active with one click (the chip and the book follow; no login
 *   window opens) → Add Console (API) adds an account waiting for its sign-in → Sign in is shown DISABLED until
 *   prism-acp's hidden login ships (the owner: "I should not see any terminals"): a click opens no window, runs no login.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.GENIE_PAGE_PROBE ??= '1';

const PORT = Number(process.env.CLAUDE_ACCOUNTS_CDP_PORT ?? 9353);
const OUT = process.env.CLAUDE_ACCOUNTS_CDP_OUT ?? 'ci-out';
const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = mkdtempSync(join(tmpdir(), 'claude-accounts-'));
const home = join(root, 'home');
mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true });
mkdirSync(join(home, 'AppData', 'Local'), { recursive: true });
const log = join(root, 'electron.log');

// THE ACCOUNTS. Names are fixtures (no person).
const hex = (c) => `account_${c.repeat(32)}`;
const WORK = hex('a'), LAB = hex('c'), TEAM = hex('b');
const dirOf = (id) => join(home, '.genie', 'accounts', 'claude', id);
const created = new Date(Date.now() - 86_400_000).toISOString();
const account = (id, label, email, method) => ({ id, provider: 'claude', legacy: false, label, labelEdited: true, home: join(home, '.claude'),
    identity: { name: null, email, plan: null }, createdAt: created, configDir: dirOf(id), method });
const legacy = (provider) => ({ id: `account_legacy_${provider}`, provider, legacy: true, label: 'Account 1', labelEdited: false, home: join(home, `.${provider}`),
    identity: { name: null, email: null, plan: null }, createdAt: created });
const book = { version: 1, active: { claude: WORK }, accounts: [legacy('claude'), legacy('codex'),
    account(WORK, 'Work', 'work@example.invalid', 'subscription'),
    account(LAB, 'Lab', 'lab@example.invalid', 'subscription'),
    account(TEAM, 'Team API', null, 'console')] };
mkdirSync(join(home, '.genie', 'runtime'), { recursive: true });
writeFileSync(join(home, '.genie', 'runtime', 'accounts.json'), JSON.stringify(book, null, 2));
for (const id of [WORK, LAB, TEAM]) mkdirSync(dirOf(id), { recursive: true });

// THE STAND-IN CLI: what `claude auth status --json` prints in each directory (the real CLI's field names), and a login that
// says what it was asked and waits, as the real one waits for the browser. Its table is a file: prism-acp hands the CLI an
// allow-listed environment, so a variable of this script's would never reach it.
const table = {
    [dirOf(WORK)]: { loggedIn: true, authMethod: 'claude.ai', email: 'work@example.invalid', orgId: 'org-work', orgName: 'Example Org', subscriptionType: 'max', configDirectory: dirOf(WORK) },
    [dirOf(LAB)]: { loggedIn: true, authMethod: 'api_key', apiKeySource: '/login managed key', email: 'lab@example.invalid', configDirectory: dirOf(LAB) },
};
const tableFile = join(root, 'claude-status.json');
writeFileSync(tableFile, JSON.stringify(table));
// CommonJS (a .cjs) for the top-level `return` below, whatever the nearest package.json says.
const fakeCjs = join(root, 'claude-standin.cjs');
writeFileSync(fakeCjs, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR || null;
fs.appendFileSync(${JSON.stringify(join(root, 'standin-calls.log'))}, JSON.stringify({ args, dir }) + '\\n');
if (args[0] === '--version' || args[0] === '-v') { console.log('2.1.330 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
    const s = JSON.parse(fs.readFileSync(${JSON.stringify(tableFile)}, 'utf8'))[dir ?? ''];
    if (!s) { console.log(JSON.stringify({ loggedIn: false, authMethod: 'none', configDirectory: dir ?? undefined })); process.exit(1); }
    console.log(JSON.stringify(s)); process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'login') { console.log('STAND-IN LOGIN: claude ' + args.join(' ') + ' in ' + dir); setInterval(() => {}, 1000); return; }
console.log('stand-in claude: ' + args.join(' '));
`);
chmodSync(fakeCjs, 0o755);
// On Windows a shell cannot run a .cjs by itself: a .cmd runs it with this Node, as an npm shim runs a CLI.
const standIn = process.platform === 'win32' ? join(root, 'claude.cmd') : fakeCjs;
if (process.platform === 'win32') writeFileSync(standIn, `@"${process.execPath}" "${fakeCjs}" %*\r\n`);

const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    GENIE2_CLAUDE_BINARY: standIn,
};
for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'GENIE_HOME']) delete env[key];
const electron = createRequire(import.meta.url)('electron');

function launch() {
    const out = openSync(log, 'a');
    const args = ['.', `--remote-debugging-port=${PORT}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
    return spawn(electron, args, { env, stdio: ['ignore', out, out], detached: process.platform !== 'win32', windowsHide: false });
}
function hostPid() {
    try { const raw = JSON.parse(readFileSync(join(home, '.genie', 'runtime', 'host.json'), 'utf8')); return typeof raw.pid === 'number' ? raw.pid : null; } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
async function stopHost(pid) {
    if (pid === null || !alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
    for (const end = Date.now() + 15_000; alive(pid) && Date.now() < end;) await sleep(100);
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
async function stop(app) {
    const host = hostPid();
    const gone = new Promise((r) => { if (app.exitCode !== null) r(); else app.once('exit', r); });
    if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } }
    else { try { process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ } }
    await Promise.race([gone, sleep(20_000)]);
    if (app.exitCode === null && process.platform !== 'win32') { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } }
    await stopHost(host);
}

async function targets() { return (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })).json(); }
class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(pick = (all) => mainWindow(all)) {
        const until = Date.now() + 90_000;
        let page = null, last = 'no attempt';
        while (Date.now() < until && !page) {
            try { const all = await targets(); page = pick(all); last = `no page yet (${all.length})`; } catch (error) { last = String(error); }
            if (!page) await sleep(500);
        }
        if (!page) throw new Error(`no window on the debugger port: ${last}`);
        const c = new Cdp();
        c.#ws = new WebSocket(page.webSocketDebuggerUrl);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('debugger socket did not open within 15 s')), 15_000);
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
    async shot(name) {
        try {
            const s = await this.send('Page.captureScreenshot', { format: 'png' });
            if (s.result?.data) { mkdirSync(OUT, { recursive: true }); writeFileSync(join(OUT, name), Buffer.from(s.result.data, 'base64')); console.log(`  screenshot: ${OUT}/${name}`); }
        } catch (error) { console.log(`  screenshot ${name}: none (${String(error)})`); }
    }
    close() { this.#ws.close(); }
}
async function waitFor(cdp, expression, ms = 30_000) {
    for (const until = Date.now() + ms; Date.now() < until;) { if (await cdp.evaluate(expression)) return true; await sleep(200); }
    return false;
}
async function click(cdp, selector) {
    const at = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!at) return false;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    return true;
}
const q = (s) => JSON.stringify(s);
const CHIP = '[data-title-bar] [data-account-chip="claude"]';
const POP = '[data-account-popover="claude"]';

/** Close what covers the window first (a fresh home opens with What's new), as a person would, then open the popover. */
async function openPopover(cdp) {
    const hitChip = `(() => { const el = document.querySelector(${q(CHIP)}); if (!el) return false; const r = el.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(at && at.closest('[data-account-chip]')); })()`;
    for (let i = 0; i < 4 && !(await cdp.evaluate(hitChip)); i++) {
        const modal = await cdp.evaluate(`(() => { const d = document.querySelector('[role="dialog"], [aria-modal="true"]'); return d ? d.innerText.replace(/\\s+/g, ' ').slice(0, 120) : '(none)'; })()`);
        console.log(`  a dialog covers the window (${modal}): closing it with Escape`);
        for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await waitFor(cdp, hitChip, 3_000);
    }
    if (!(await cdp.evaluate(`Boolean(document.querySelector(${q(POP)}))`))) await click(cdp, CHIP);
    const opened = await waitFor(cdp, `(() => { const r = document.querySelector(${q(POP)})?.getBoundingClientRect(); return Boolean(r && r.left >= 0 && r.top >= 0); })()`, 8_000);
    return opened;
}
const seenOf = (cdp) => cdp.evaluate(`JSON.stringify((() => {
    const pop = document.querySelector(${q(POP)});
    if (!pop) return null;
    const row = (id) => { const s = pop.querySelector('[data-account="' + id + '"]'); if (!s) return null; const live = s.querySelector('[data-account-live]');
        return { pane: s.closest('[data-accounts-pane]')?.getAttribute('data-accounts-pane'), live: live?.getAttribute('data-account-live') ?? null, differences: live?.getAttribute('data-differences') ?? null,
            title: live?.getAttribute('title') ?? null, billing: s.querySelector('[data-account-billing]')?.textContent ?? null, org: s.querySelector('[data-account-org]')?.textContent ?? null,
            switch: Boolean(s.querySelector('[data-action="account-switch"]')), signIn: Boolean(s.querySelector('[data-action="account-sign-in"]')), text: s.textContent.slice(0, 160) }; };
    return { work: row(${q(WORK)}), lab: row(${q(LAB)}), team: row(${q(TEAM)}), ids: [...pop.querySelectorAll('[data-account]')].map((s) => s.getAttribute('data-account')),
        add: Boolean(pop.querySelector('[data-action="account-add-console"]')) && Boolean(pop.querySelector('[data-action="account-add-subscription"]')) };
})())`).then(JSON.parse);

console.log('\nCLAUDE ACCOUNTS OF THEIR OWN — what a person sees and does, in the real app\n');
let app = launch();
let cdp = null;
try {
    cdp = await Cdp.connect();
    check(await waitFor(cdp, `Boolean(document.querySelector('[data-route]'))`, 60_000), '0. the app is up, on a seeded home of its own');
    check(await waitFor(cdp, `Boolean(document.querySelector(${q(CHIP)}))`, 30_000), '1. the title bar has the Claude account chip');
    check((await cdp.evaluate(`document.querySelector(${q(CHIP)})?.textContent ?? ''`)).includes('Work'), '2. the chip names the active account, Work');
    check(await openPopover(cdp), '3. a click on the chip opens the popover (What\'s new closed first)');
    // The live state is asked of the stand-in CLI by the host; it arrives with a re-read of the accounts.
    let seen = null;
    for (const until = Date.now() + 40_000; Date.now() < until; await sleep(1_000)) {
        seen = await seenOf(cdp);
        if (seen?.work?.live && seen?.lab?.live) break;
        // Re-open: the popover re-reads the accounts when it opens.
        await click(cdp, CHIP); await sleep(300); await openPopover(cdp);
    }
    console.log(`  seen: ${JSON.stringify(seen)}`);
    check(seen?.work?.pane === 'active' && seen.work.live === 'ready', '4. the active account (left pane) is Signed in, from describe in its own directory', JSON.stringify(seen?.work));
    check(seen?.work?.billing === 'Subscription' && (seen.work.org ?? '').includes('Example Org'), '5. with its billing (Subscription) and its org', `${seen?.work?.billing} / ${seen?.work?.org}`);
    check(seen?.lab?.live === 'mismatch' && seen.lab.differences === 'method', '6. Lab, signed in with a Console key where a subscription was chosen, is a typed Mismatch (method)', JSON.stringify(seen?.lab));
    check(seen?.lab?.billing === 'API usage', '7. and its billing reads API usage', String(seen?.lab?.billing));
    check(seen?.team?.signIn === true && seen.team.switch === false, '8. Team API, not signed in, offers Sign in, not Switch', JSON.stringify(seen?.team));
    check(seen?.add === true, '9. Add subscription and Add Console (API) are there');
    await cdp.shot('claude-accounts-1011-popover.png');

    // SWITCH: one click, no login window. The chip and the book follow.
    const pagesBefore = (await targets()).filter((t) => t.type === 'page').length;
    check(await click(cdp, `${POP} [data-account="${LAB}"] [data-action="account-switch"]`), '10. Switch on Lab takes a click');
    const switched = await waitFor(cdp, `(document.querySelector(${q(CHIP)})?.textContent ?? '').includes('Lab')`, 15_000);
    check(switched, '11. the chip names Lab now', await cdp.evaluate(`document.querySelector(${q(CHIP)})?.textContent ?? ''`));
    const stored = JSON.parse(readFileSync(join(home, '.genie', 'runtime', 'accounts.json'), 'utf8'));
    check(stored.active?.claude === LAB, '12. the host\'s book has Lab as the active Claude account', JSON.stringify(stored.active));
    check((await targets()).filter((t) => t.type === 'page').length === pagesBefore, '13. no login window opened for the switch (no terminal, no TUI)');
    await openPopover(cdp);
    await cdp.shot('claude-accounts-1011-after-switch.png');

    // ADD: a Console account, waiting for its sign-in.
    check(await click(cdp, `${POP} [data-action="account-add-console"]`), '14. Add Console (API) takes a click');
    const added = await waitFor(cdp, `(() => { const pop = document.querySelector(${q(POP)}); return pop ? pop.querySelectorAll('[data-account]').length >= 4 : false; })()`, 15_000)
        || (await openPopover(cdp) && await waitFor(cdp, `document.querySelectorAll(${q(POP + ' [data-account]')}).length >= 4`, 10_000));
    const book2 = JSON.parse(readFileSync(join(home, '.genie', 'runtime', 'accounts.json'), 'utf8'));
    const newOne = book2.accounts.find((a) => ![WORK, LAB, TEAM, 'account_legacy_claude', 'account_legacy_codex'].includes(a.id));
    check(Boolean(newOne) && newOne.method === 'console' && typeof newOne.configDir === 'string', '15. the book has a new Console account with a directory of its own', JSON.stringify(newOne ?? null));
    check(Boolean(newOne) && existsSync(join(newOne.configDir, 'projects')), '16. its directory links its session history to the shared store (projects)');
    check(added, '17. the popover lists it');

    // SIGN IN, NOT YET (the owner: "I should not see any terminals nor do we store login keys"): shown, disabled, with why;
    // a click opens no window and runs no login. prism-acp's hidden login (Anthropic's page in the browser) comes next.
    await openPopover(cdp);
    const signIn = await cdp.evaluate(`(() => { const b = document.querySelector(${q(`${POP} [data-account="${TEAM}"] [data-action="account-sign-in"]`)}); return b ? { disabled: b.disabled, title: b.getAttribute('title'), note: b.closest('[data-account-sign-in-later]')?.textContent ?? '' } : null; })()`);
    check(signIn?.disabled === true && /no terminal/.test(signIn.title ?? '') && /next prism-acp/.test(signIn.note), '18. Sign in on Team API is shown DISABLED, saying it comes with the next prism-acp, never a terminal', JSON.stringify(signIn));
    const before = (await targets()).filter((t) => t.type === 'page').length;
    await click(cdp, `${POP} [data-account="${TEAM}"] [data-action="account-sign-in"]`);
    await sleep(2_000);
    check((await targets()).filter((t) => t.type === 'page').length === before && !(await targets()).some((t) => /login=claude/.test(t.url)), '19. a click on it opens no window (no terminal)');
    const logins = (existsSync(join(root, 'standin-calls.log')) ? readFileSync(join(root, 'standin-calls.log'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args[0] === 'auth' && c.args[1] === 'login');
    check(logins.length === 0, '20. and no `claude auth login` ran anywhere', JSON.stringify(logins));
    const statusCalls = (existsSync(join(root, 'standin-calls.log')) ? readFileSync(join(root, 'standin-calls.log'), 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.args[1] === 'status');
    check([dirOf(WORK), dirOf(LAB)].every((d) => statusCalls.some((c) => c.dir === d)), '21. the host asked each account\'s OWN directory (describe), never only the default', `${statusCalls.length} status calls`);
} catch (error) {
    check(false, 'the run did not finish', error instanceof Error ? error.message : String(error));
} finally {
    if (cdp) {
        try { if (failures.length > 0) console.log(`  on screen: ${String(await cdp.evaluate(`document.body?.innerText?.slice(0, 600) ?? ''`)).replace(/\s+/g, ' ')}`); } catch { /* gone */ }
        cdp.close();
    }
    await stop(app);
    if (failures.length > 0 && existsSync(log)) console.log(readFileSync(log, 'utf8').slice(-2000));
    if (failures.length > 0) {
        const hostLog = join(home, '.genie', 'logs', 'genie-host.log');
        if (existsSync(hostLog)) console.log(`  genie-host.log (accounts):\n    ${readFileSync(hostLog, 'utf8').split(/\r?\n/).filter((l) => /account|identity|login|describe/i.test(l)).slice(-30).join('\n    ')}`);
    }
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch { /* the runner cleans up */ }
}

if (failures.length > 0) {
    console.log(`\nCLAUDE ACCOUNTS FAILED — ${failures.length} check(s):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
console.log('\nCLAUDE ACCOUNTS OK');
process.exit(0);
