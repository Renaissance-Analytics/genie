#!/usr/bin/env node
/**
 * A WEEKLY LIMIT HOLDS THE AGENT AND SAYS WHICH ACCOUNT HAS ROOM; A MESSAGE SENT MEANWHILE WAITS AND IS DELIVERED AFTER THE MOVE;
 * "SEND ALL NOW" SENDS, WITH PROGRESS AND A RESULT EACH (Tynn #1089), in the real app with a stand-in Claude Code
 * (scripts/limit-hold-stub-claude.mjs). CI and test VMs only, never a desktop.
 *
 *   node scripts/limit-hold-cdp.mjs            (Linux: under xvfb-run when there is no display)
 *
 * Seeded: two Claude accounts with folders of their own — Spent (active; its week is used up) and Roomy (65 % of its week
 * left) — and the agent atlas, with "When the active account runs out" at its default, Ask me. Then:
 *   L1 atlas's turn on Spent ends on "You've hit your weekly limit": it is HELD, and its chat line and the Accounts chip say
 *      "Spent is out until <reset> · Roomy has room." with "Switch to Roomy"; nothing switches by itself (shot 01)
 *   L2 a message sent while held waits, never "Not delivered" (shot 02)
 *   L3 "Switch to Roomy" (the normal switch): atlas moves to Roomy on its thread; the message waits through the move and is
 *      never "Not delivered" at any moment (shot 03), and is delivered in Roomy's folder (shot 04)
 *   L4 Roomy runs out too: "No Claude account has room: Roomy is out until <reset>. What you send waits and goes then.", no
 *      Switch; two messages wait (shot 05). atlas stopped: both kept "Not delivered" (shot 06, the owner's screen). Roomy has
 *      room again (Check usage now); Send all now restarts atlas once and sends both: "Sending 1 of 2…" (shot 07), then each
 *      message's result at the bar, waiting while held (shot 08); Resume now, and both are Sent (shot 09)
 *   L5 Settings → Providers: "When the active account runs out", Ask me / Switch to the account with the most room (shot 10)
 */
import { mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew } from './cdp-whats-new.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForPageProbe } from './page-probe-cdp.mjs';

const WIN = process.platform === 'win32', OUT = resolve('ci-out/limit-hold-1089'), PORT = 9393, INSPECT = 9394, sessions = [], checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const demand = (ok, reason) => { if (!ok) throw new Error(reason); };
const json = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const q = (s) => JSON.stringify(s);
function check(id, ok, label, detail) {
    checks.push({ id, ok: Boolean(ok), label, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${label}${detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const targets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
async function until(label, read, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await read().catch(() => null); if (v) return v; await sleep(150); } throw new Error(`${label} was not ready in ${ms} ms`); }
const maybe = (label, read, ms) => until(label, read, ms).catch(() => null);

class Cdp {
    next = 0; pending = new Map();
    static async connect(url) {
        const c = new Cdp(); c.socket = new WebSocket(url);
        c.socket.addEventListener('message', (event) => { const frame = JSON.parse(event.data); const done = c.pending.get(frame.id); if (typeof done === 'function') done(frame); c.pending.delete(frame.id); });
        c.socket.addEventListener('close', () => { for (const done of c.pending.values()) done({ error: { message: 'CDP closed' } }); c.pending.clear(); });
        await new Promise((ok, no) => { const t = setTimeout(() => no(new Error('CDP connect timed out')), 10_000); c.socket.addEventListener('open', () => { clearTimeout(t); ok(); }, { once: true }); c.socket.addEventListener('error', (e) => { clearTimeout(t); no(e); }, { once: true }); });
        sessions.push(c); return c;
    }
    send(method, params = {}) {
        const id = ++this.next;
        return new Promise((ok, no) => {
            const t = setTimeout(() => { this.pending.delete(id); no(new Error(`CDP ${method} timed out`)); }, 60_000);
            this.pending.set(id, (frame) => { clearTimeout(t); if (frame.error) no(new Error(frame.error.message)); else ok(frame.result); });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression) {
        const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page exception');
        return r.result.value;
    }
}

// THE ACCOUNTS. Names are fixtures (no person). Both have folders of their own; Spent is active and its week is used up.
const SPENT = `account_${'e'.repeat(32)}`, ROOMY = `account_${'f'.repeat(32)}`;
const SESSION = '5b0c6a1e-84d2-4c3f-9e7a-1089aaaa0001';
const HOUR = 3_600_000;

let app, page, root, failure = null, code = 1;
try {
    demand(process.env.CI === 'true' || process.env.GENIE_TEST_MACHINE === '1', 'refused: run only in CI or a test VM');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    for (const port of [PORT, INSPECT]) { let busy = false; try { await targets(port); busy = true; } catch (e) { if (e.name === 'TimeoutError') busy = true; } demand(!busy, `debugger port ${port} occupied; no app touched`); }
    root = mkdtempSync(join(tmpdir(), 'genie-limit-1089-'));
    const workspace = join(root, 'workspace'), genie = join(root, '.genie'), runtime = join(genie, 'runtime');
    mkdirSync(workspace); mkdirSync(OUT, { recursive: true });
    const stubDir = join(root, 'stub'); mkdirSync(stubDir);
    const stub = join(stubDir, 'claude.mjs');
    copyFileSync(resolve('scripts/limit-hold-stub-claude.mjs'), stub); chmodSync(stub, 0o755);
    const spentDir = join(genie, 'accounts', 'claude', SPENT), roomyDir = join(genie, 'accounts', 'claude', ROOMY);
    mkdirSync(spentDir, { recursive: true }); mkdirSync(roomyDir, { recursive: true });
    // Roomy's CLI is slow to start (4 s), so the move and the restart can be seen.
    writeFileSync(join(stubDir, 'status.json'), JSON.stringify({
        [spentDir]: { loggedIn: true, authMethod: 'claude.ai', email: 'spent@example.invalid', subscriptionType: 'max', configDirectory: spentDir, spent: true },
        [roomyDir]: { loggedIn: true, authMethod: 'claude.ai', email: 'roomy@example.invalid', subscriptionType: 'max', configDirectory: roomyDir, used: 0.35, initDelayMs: 4_000 },
    }));
    const calls = () => { try { return readFileSync(join(stubDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const said = (folder, words) => calls().some((c) => c.dir === folder && typeof c.said === 'string' && c.said.includes(words));
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: genie, GENIE_PAGE_PROBE: '1', GENIE2_CLAUDE_BINARY: stub };
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15_000, windowsHide: true });
    const atlas = (json(join(runtime, 'agents.json')) ?? []).find((a) => a.name === 'atlas' && a.provider === 'claude');
    demand(atlas, 'the seeded claude agent');
    const created = new Date(Date.now() - 86_400_000).toISOString();
    writeFileSync(join(runtime, 'accounts.json'), JSON.stringify({ version: 1, active: { claude: SPENT }, accounts: [
        // The machine-default Claude login the book always has (no reading of its own: its room is unknown, never offered).
        { id: 'account_legacy_claude', provider: 'claude', legacy: true, label: 'Default', labelEdited: true, home: join(root, '.claude'), identity: { name: null, email: null, plan: null }, createdAt: created },
        { id: 'account_legacy_codex', provider: 'codex', legacy: true, label: 'Account 1', labelEdited: false, home: join(root, '.codex'), identity: { name: null, email: null, plan: null }, createdAt: created },
        { id: SPENT, provider: 'claude', legacy: false, label: 'Spent', labelEdited: true, home: join(root, '.claude'), identity: { name: null, email: 'spent@example.invalid', plan: 'max' }, createdAt: created, configDir: spentDir, method: 'subscription' },
        { id: ROOMY, provider: 'claude', legacy: false, label: 'Roomy', labelEdited: true, home: join(root, '.claude'), identity: { name: null, email: 'roomy@example.invalid', plan: 'max' }, createdAt: created, configDir: roomyDir, method: 'subscription' },
    ] }, null, 2));
    // Each account's own last reading, as the host saves them (Tynn #1070): Spent's week used up, Roomy's 65 % left.
    const now = Date.now();
    const win = (leftPct, resetsAtMs) => ({ window: '7d', usedPct: 100 - leftPct, leftPct, resetsAtMs, over: false });
    const reading = (accountId, w) => ({ source: { provider: 'claude', accountId }, runId: 'seed', room: { plan: null, window: '7d', leftPct: w.leftPct, resetsAtMs: w.resetsAtMs, over: false, windows: [w] } });
    writeFileSync(join(genie, 'headroom-board.json'), JSON.stringify({ format: 2, readings: [reading(SPENT, win(0, now + 144 * HOUR)), reading(ROOMY, win(65, now + 72 * HOUR))] }));
    // Its conversation is in the shared session store, so it can move to Roomy on its own thread.
    mkdirSync(join(root, '.claude', 'projects', '-workspace'), { recursive: true });
    writeFileSync(join(root, '.claude', 'projects', '-workspace', `${SESSION}.jsonl`), `${JSON.stringify({ type: 'summary', sessionId: SESSION })}\n`);

    const fd = openSync(join(OUT, 'electron.log'), 'w'), electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    const args = ['.', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${join(root, 'profile')}`]; if (!WIN) args.push('--no-sandbox');
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    app = spawn(xvfb ? 'xvfb-run' : electron, xvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, windowsHide: true, detached: !WIN, stdio: ['ignore', fd, fd] }); closeSync(fd); app.on('error', (e) => console.error(e.message));
    page = await Cdp.connect((await until('the main window', async () => mainWindow(await targets(PORT)), 240_000)).webSocketDebuggerUrl);
    await waitForPageProbe(page);
    await until('the page connection', () => page.evaluate('window.genieTest.localProtocol.state().phase === "ready"'), 60_000);
    await page.send('Page.enable');
    const shot = async (name) => { const s = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, `${name}.png`), Buffer.from(s.data, 'base64')); console.log(`SHOT ${name}.png`); };
    const press = (selector) => page.evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el || el.disabled) return false; el.scrollIntoView({ block: 'nearest' }); el.click(); return true; })()`);
    const text = (selector) => page.evaluate(`document.querySelector(${q(selector)})?.textContent ?? null`);
    await closeWhatsNew((expression) => page.evaluate(expression));

    const CHAT = `[data-chat="pinned"][data-chat-subject="${atlas.id}"]`;
    const BOX = `${CHAT} [data-chat-composer] [data-react-fancy-prompt-input]`;
    const FIELD = `${BOX} textarea, ${BOX} [contenteditable="true"]`;
    const type = async (words) => {
        demand(await page.evaluate(`(() => { const f = document.querySelector(${q(FIELD)}); f?.focus(); return document.activeElement === f; })()`), 'the composer takes focus');
        await page.send('Input.insertText', { text: words });
        demand(await press(`${BOX} [data-react-fancy-prompt-input-send]`), 'the send button');
        await sleep(400);
    };
    const chatText = () => text(CHAT);
    await page.evaluate(`window.location.hash = '#genie://agent/${atlas.id}?tab=stream'; true`);
    await until('atlas with its composer', () => page.evaluate(`Boolean(document.querySelector(${q(FIELD)}))`), 60_000);

    // L1: the week runs out on Spent.
    await type('L1089 start the work');
    if (!(await maybe('atlas started', async () => calls().some((c) => !c.probe && c.args?.includes('--print')), 30_000)) && await page.evaluate(`Boolean(document.querySelector('[data-action="start-agent"]'))`)) {
        await press('[data-action="start-agent"]');
    }
    const outLine = await maybe('the active-out line', () => text(`${CHAT} [data-chat-active-out]`), 90_000);
    check('L1a', /^Spent is out until .+ · Roomy has room\./.test(outLine ?? ''), 'held: the chat line says Spent is out until its reset and Roomy has room', outLine);
    check('L1b', /Switch to Roomy/.test(outLine ?? ''), 'with one click, Switch to Roomy', outLine);
    const chipLine = await maybe('the chip line', () => text('[data-accounts-active-out]'), 15_000);
    check('L1c', /Spent is out until .+ · Roomy has room\./.test(chipLine ?? '') && /Switch to Roomy/.test(chipLine ?? ''), 'the Accounts chip says the same, with Switch to Roomy', chipLine);
    check('L1d', /weekly limit/.test((await chatText()) ?? ''), 'the provider\'s own words are in the chat');
    check('L1e', !calls().some((c) => c.dir === roomyDir && !c.probe && c.args?.includes('--print')), 'Ask me: nothing switched by itself (no run on Roomy)');
    await shot('01-held-ask');

    // L2: a message while held waits.
    await type('why do I keep getting this?');
    const waits = await maybe('the message waits', () => text(`${CHAT} [data-chat-queued]`), 15_000);
    check('L2a', Boolean(waits), 'the message is shown waiting', waits);
    check('L2b', !/Not delivered/.test((await chatText()) ?? ''), 'never "Not delivered"');
    await shot('02-message-waits');

    // L3: Switch to Roomy, the normal switch; the message waits through the move, and is delivered in Roomy's folder.
    check('L3a', await press(`${CHAT} [data-chat-active-out] [data-action="switch-account"]`), 'Switch to Roomy takes a click');
    let sawNotDelivered = false, movingShot = false;
    const end = Date.now() + 60_000;
    while (Date.now() < end && !said(roomyDir, 'why do I keep getting this?')) {
        const t = (await chatText().catch(() => '')) ?? '';
        if (/Not delivered/.test(t)) sawNotDelivered = true;
        const note = await text(`${CHAT} [data-chat-queued]`).catch(() => null);
        if (!movingShot && note && calls().some((c) => c.dir === roomyDir && !c.probe && c.args?.includes('--print'))) { await shot('03-moving'); movingShot = true; console.log(`  the note during the move: ${note}`); }
        await sleep(100);
    }
    check('L3b', said(roomyDir, 'why do I keep getting this?'), 'the message reached atlas on Roomy, in Roomy\'s own folder');
    check('L3c', !sawNotDelivered, 'at no moment of the move did the chat say "Not delivered"');
    check('L3d', !said(spentDir, 'why do I keep getting this?'), 'the spent account\'s process was never sent it');
    check('L3e', movingShot, 'the move was seen: atlas starting on Roomy while the message waited');
    const reply = await maybe('the reply', async () => ((await chatText()) ?? '').includes('got: why do I keep getting this?') || null, 30_000);
    check('L3f', Boolean(reply), 'atlas answered it on Roomy');
    check('L3g', !(await page.evaluate(`Boolean(document.querySelector(${q(`${CHAT} [data-chat-active-out]`)}))`)), 'the active-out line is gone once Roomy is active');
    await shot('04-delivered-after-move');

    // L4: Roomy runs out too — nothing has room, said plainly — and two messages wait. The agent is stopped, so they are kept
    // "Not delivered. Kept for you to send again." (the owner's screen). Roomy gets room back; Send all now sends both, with
    // progress and a result each.
    const status = JSON.parse(readFileSync(join(stubDir, 'status.json'), 'utf8'));
    status[roomyDir] = { ...status[roomyDir], spent: true };
    writeFileSync(join(stubDir, 'status.json'), JSON.stringify(status));
    await type('L1089 hold again');
    const noRoom = await maybe('the no-room line', async () => { const t = await text(`${CHAT} [data-chat-active-out]`); return t && /^No Claude account has room: Roomy is out until .+\. What you send waits and goes then\.$/.test(t) ? t : null; }, 60_000);
    check('L4a', Boolean(noRoom), 'no account with room: said plainly, with the reset, and no Switch', noRoom ?? await text(`${CHAT} [data-chat-active-out]`));
    check('L4a2', !(await page.evaluate(`Boolean(document.querySelector(${q(`${CHAT} [data-chat-active-out] [data-action="switch-account"]`)}))`)), 'nothing to switch to');
    await type('L1089 first kept');
    await type('L1089 second kept');
    const queued = await maybe('two waiting', () => page.evaluate(`document.querySelectorAll(${q(`${CHAT} [data-chat-queued]`)}).length === 2 || null`), 15_000);
    check('L4b', Boolean(queued), 'both wait while it is held');
    await shot('05-no-room-messages-wait');
    await page.evaluate(`window.genieTest.stopAgent(${q(atlas.id)}); true`);
    const kept = await maybe('two not delivered', async () => /2 not delivered/.test((await text(`${CHAT} [data-chat-queue="undelivered"]`)) ?? '') || null, 30_000);
    check('L4c', Boolean(kept), 'stopped: both kept "Not delivered", one Send all now', await text(`${CHAT} [data-chat-queue]`));
    // Roomy has room again: its usage read at once, by the panel's own "Check usage now".
    status[roomyDir] = { ...status[roomyDir], spent: false };
    writeFileSync(join(stubDir, 'status.json'), JSON.stringify(status));
    const CHIP = '[data-title-bar] [data-account-chip="claude"]', POP = '[data-account-popover="claude"]';
    if (!(await page.evaluate(`Boolean(document.querySelector(${q(POP)}))`))) await press(CHIP);
    await maybe('the popover', () => page.evaluate(`Boolean(document.querySelector(${q(POP)}))`), 10_000);
    await press(`${POP} [data-account="${ROOMY}"] [data-action="check-usage"]`);
    const roomy = await maybe('Roomy has room', async () => { const t = await text(`${POP} [data-account="${ROOMY}"]`); return t && /35% used/.test(t) ? t : null; }, 60_000);
    check('L4d', Boolean(roomy), 'Roomy read again: it has room', roomy);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(500);
    await shot('06-kept-not-delivered');
    check('L4e', await press(`${CHAT} [data-action="send-all"]`), 'Send all now takes a click');
    const progress = await maybe('the progress', () => text(`${CHAT} [data-send-all-progress="running"]`), 10_000);
    check('L4f', /Sending \d of 2…/.test(progress ?? ''), 'it says how far it is', progress);
    if (progress) await shot('07-sending');
    // atlas starts again, still held by Roomy's refusal: both handed over and WAITING — said so at the bar, never "Sent".
    const done = await maybe('the results', () => page.evaluate(`(() => { const r = [...document.querySelectorAll(${q(`${CHAT} [data-send-all-result]`)})]; return r.length === 2 ? r.map((e) => [e.getAttribute('data-outcome'), e.textContent]) : null; })()`), 90_000);
    check('L4g', Array.isArray(done) && done.every(([o]) => o === 'waiting' || o === 'sent'), "each message's result at the bar, as the chat has it (held: waiting)", done);
    check('L4g2', !/Not delivered/.test((await chatText()) ?? ''), 'neither is "Not delivered" any more');
    await shot('08-send-all-results');
    // The person: Roomy has room again, so Resume now. Both go, and the bar says Sent.
    await maybe('Resume now', () => page.evaluate(`Boolean(document.querySelector(${q(`${CHAT} [data-action="resume-limit"]`)}))`), 30_000);
    check('L4h', await press(`${CHAT} [data-action="resume-limit"]`), 'Resume now takes a click');
    const both = await maybe('both received', async () => (said(roomyDir, 'L1089 first kept') && said(roomyDir, 'L1089 second kept')) || null, 60_000);
    check('L4i', Boolean(both), 'atlas received both, on Roomy');
    const sentNow = await maybe('both sent', () => page.evaluate(`(() => { const r = [...document.querySelectorAll(${q(`${CHAT} [data-send-all-result]`)})]; return r.length === 2 && r.every((e) => e.getAttribute('data-outcome') === 'sent') ? r.map((e) => e.textContent) : null; })()`), 30_000);
    check('L4j', Boolean(sentNow), 'the bar now says Sent for each', sentNow);
    await shot('09-send-all-delivered');

    // L5: the setting.
    await page.evaluate(`window.location.hash = '#genie://settings'; true`);
    if (await maybe('the providers nav', () => page.evaluate(`Boolean(document.querySelector('[data-settings-nav="providers"]'))`), 15_000)) await press('[data-settings-nav="providers"]');
    const setting = await maybe('the setting', () => text('[data-when-active-out]'), 15_000);
    check('L5a', /When the active account runs out/.test(setting ?? '') && /Ask me/.test(setting ?? '') && /Switch to the account with the most room/.test(setting ?? ''), 'Settings → Providers: When the active account runs out — Ask me / Switch to the account with the most room', setting);
    await page.evaluate(`document.querySelector('[data-when-active-out]')?.scrollIntoView({ block: 'center' }); true`);
    await sleep(300);
    await shot('10-setting');
    code = checks.every((c) => c.ok) ? 0 : 1;
} catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`FAIL: ${failure}`);
    try { if (page) { const s = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, 'failure.png'), Buffer.from(s.data, 'base64')); } } catch { /* gone */ }
    // The host's own log, for the reason (it is in the run's home, which the runner does not bring back).
    try { const hostLog = root ? join(root, '.genie', 'logs', 'genie-host.log') : null; if (hostLog && existsSync(hostLog)) { copyFileSync(hostLog, join(OUT, 'genie-host.log')); console.log(readFileSync(hostLog, 'utf8').split(/\r?\n/).slice(-40).join('\n')); } } catch { /* gone */ }
} finally {
    for (const s of sessions) { try { s.socket.close(); } catch { /* gone */ } }
    if (app && app.exitCode === null) { try { if (WIN) execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ } }
    await sleep(2_000);
    if (app && app.exitCode === null && !WIN) { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } }
    try { const hostJson = root ? json(join(root, '.genie', 'runtime', 'host.json')) : null; if (hostJson?.pid) process.kill(hostJson.pid, 'SIGKILL'); } catch { /* gone */ }
    writeFileSync(join(OUT, 'result.json'), JSON.stringify({ code, failure, checks }, null, 2));
}
console.log(code === 0 ? '\nLIMIT HOLD OK' : `\nLIMIT HOLD FAILED${failure ? `: ${failure}` : ''}`);
process.exit(code);
