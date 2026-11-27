#!/usr/bin/env node
/**
 * AFTER A SWITCH, THE NEW ACCOUNT'S USAGE IS READ AT ONCE, AND EVERY AGENT SAYS WHICH ACCOUNT IT IS REALLY ON (Tynn #1084), in
 * the real app, with a stand-in Claude Code (scripts/usage-on-switch-stub-claude.mjs). CI and test VMs only, never a desktop.
 *
 *   node scripts/usage-on-switch-cdp.mjs            (Linux: under xvfb-run when there is no display)
 *
 * The owner on beta.66.1: he switched to his machine-default Claude login and the panel said "Usage unknown: not read yet"
 * for good, while his (busy) agent was still on the other account and its stream showed that account's 7d figure. Seeded:
 * two Claude accounts, Main (the default home, as his is) and Aux (a folder of its own, active), and the agent atlas. Then:
 *   U1 atlas, busy on Aux, its stream's limit line names Aux
 *   U2 Switch to Main in the popover → at once Main says "Reading usage…" (shot 01), and the panel says 1 agent is still on Aux
 *   U3 a few seconds later Main shows ITS OWN 7d window (shot 02); the probe ran in the default home, haiku, no history
 *   U4 atlas's header and chat say "On Aux · moves to Main at next idle" with Restart on Main now (shot 03)
 *   U5 "Check usage now" on Aux reads Aux at once (shot 04)
 *   U6 Restart on Main now moves atlas to Main, on its thread: the banner goes, the header says On Main (shot 05)
 */
import { mainWindow } from './cdp-main-window.mjs';
import { closeWhatsNew } from './cdp-whats-new.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForPageProbe } from './page-probe-cdp.mjs';

const WIN = process.platform === 'win32', OUT = resolve('ci-out/usage-on-switch-1084'), PORT = 9391, INSPECT = 9392, sessions = [], checks = [];
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

// THE ACCOUNTS. Names are fixtures (no person). Main is the default home (no folder of its own), as the owner's is.
const MAIN = 'account_legacy_claude', AUX = `account_${'d'.repeat(32)}`;
const SESSION = '5b0c6a1e-84d2-4c3f-9e7a-1084aaaa0001';

let app, page, root, failure = null, code = 1;
try {
    demand(process.env.CI === 'true' || process.env.GENIE_TEST_MACHINE === '1', 'refused: run only in CI or a test VM');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    for (const port of [PORT, INSPECT]) { let busy = false; try { await targets(port); busy = true; } catch (e) { if (e.name === 'TimeoutError') busy = true; } demand(!busy, `debugger port ${port} occupied; no app touched`); }
    root = mkdtempSync(join(tmpdir(), 'genie-usage-1084-'));
    const workspace = join(root, 'workspace'), genie = join(root, '.genie'), runtime = join(genie, 'runtime');
    mkdirSync(workspace); mkdirSync(OUT, { recursive: true });
    const stubDir = join(root, 'stub'); mkdirSync(stubDir);
    const stub = join(stubDir, 'claude.mjs');
    copyFileSync(resolve('scripts/usage-on-switch-stub-claude.mjs'), stub); chmodSync(stub, 0o755);
    const auxDir = join(genie, 'accounts', 'claude', AUX);
    mkdirSync(auxDir, { recursive: true });
    // Who is signed in where, and each folder's limits (the share used), as the stand-in reports them.
    writeFileSync(join(stubDir, 'status.json'), JSON.stringify({
        '': { loggedIn: true, authMethod: 'claude.ai', email: 'main@example.invalid', subscriptionType: 'max', limit: { seven_day: 0.12 } },
        [auxDir]: { loggedIn: true, authMethod: 'claude.ai', email: 'aux@example.invalid', subscriptionType: 'max', configDirectory: auxDir, limit: { seven_day: 0.33 } },
    }));
    const calls = () => { try { return readFileSync(join(stubDir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: genie, GENIE_PAGE_PROBE: '1', GENIE2_CLAUDE_BINARY: stub };
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']) delete env[key];
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15_000, windowsHide: true });
    const atlas = (json(join(runtime, 'agents.json')) ?? []).find((a) => a.name === 'atlas' && a.provider === 'claude');
    demand(atlas, 'the seeded claude agent');
    // The book: Main (default home) and Aux (its own folder), Aux active. No reading of Main exists anywhere.
    const created = new Date(Date.now() - 86_400_000).toISOString();
    writeFileSync(join(runtime, 'accounts.json'), JSON.stringify({ version: 1, active: { claude: AUX }, accounts: [
        { id: MAIN, provider: 'claude', legacy: true, label: 'Main', labelEdited: true, home: join(root, '.claude'), identity: { name: null, email: 'main@example.invalid', plan: 'max' }, createdAt: created },
        { id: 'account_legacy_codex', provider: 'codex', legacy: true, label: 'Account 1', labelEdited: false, home: join(root, '.codex'), identity: { name: null, email: null, plan: null }, createdAt: created },
        { id: AUX, provider: 'claude', legacy: false, label: 'Aux', labelEdited: true, home: join(root, '.claude'), identity: { name: null, email: 'aux@example.invalid', plan: 'max' }, createdAt: created, configDir: auxDir, method: 'subscription' },
    ] }, null, 2));
    // Its conversation is in the shared session store (the default home's, which an account folder shares), so it can move.
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
    // A button pressed as a person's click reaches it (React's onClick). The popover reflows as readings arrive, so a mouse
    // event at coordinates read a moment earlier can land on another row; the element itself is what is pressed.
    const press = (selector) => page.evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) return false; el.scrollIntoView({ block: 'nearest' }); el.click(); return true; })()`);
    const click = async (selector) => {
        const at = await page.evaluate(`(() => { const el = document.querySelector(${q(selector)}); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        if (!at) return false;
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
        return true;
    };
    const text = (selector) => page.evaluate(`document.querySelector(${q(selector)})?.textContent ?? null`);
    await closeWhatsNew((expression) => page.evaluate(expression));

    // U1: atlas, busy on Aux.
    const CHAT = `[data-chat="pinned"][data-chat-subject="${atlas.id}"]`;
    const BOX = `${CHAT} [data-chat-composer] [data-react-fancy-prompt-input]`;
    const FIELD = `${BOX} textarea, ${BOX} [contenteditable="true"]`;
    await page.evaluate(`window.location.hash = '#genie://agent/${atlas.id}?tab=stream'; true`);
    await until('atlas with its composer', () => page.evaluate(`Boolean(document.querySelector(${q(FIELD)}))`), 60_000);
    demand(await page.evaluate(`(() => { const f = document.querySelector(${q(FIELD)}); f?.focus(); return document.activeElement === f; })()`), 'the composer takes focus');
    await page.send('Input.insertText', { text: 'U1084 a long piece of work' });
    demand(await page.evaluate(`(() => { const b = document.querySelector(${q(`${BOX} [data-react-fancy-prompt-input-send]`)}); if (!b || b.disabled) return false; b.click(); return true; })()`), 'the send button');
    if (!(await maybe('atlas started', async () => calls().some((c) => !c.probe && c.args.includes('--print')), 30_000)) && await page.evaluate(`Boolean(document.querySelector('[data-action="start-agent"]'))`)) {
        await page.evaluate(`document.querySelector('[data-action="start-agent"]').click(); true`);
    }
    await until('atlas mid-turn', () => page.evaluate(`document.querySelector(${q(CHAT)})?.getAttribute('data-chat-busy') === 'true'`), 90_000);
    const agentRun = calls().find((c) => !c.probe && c.args.includes('--print'));
    check('U1a', agentRun?.dir === auxDir, 'atlas runs in Aux\'s own folder', agentRun?.dir);
    const line = await maybe('the stream\'s limit line', async () => page.evaluate(`[...document.querySelectorAll('[data-surface="agent"] *')].map((e) => e.textContent).find((t) => /window left on Aux/.test(t ?? '') && t.length < 160) ?? null`), 30_000);
    check('U1b', Boolean(line), 'the stream\'s rate-limit line names the account it came from (on Aux)', line);

    // U2: Switch to Main.
    const CHIP = '[data-title-bar] [data-account-chip="claude"]', POP = '[data-account-popover="claude"]';
    if (!(await page.evaluate(`Boolean(document.querySelector(${q(POP)}))`))) await click(CHIP);
    await until('the popover', () => page.evaluate(`Boolean(document.querySelector(${q(POP)}))`), 10_000);
    const mainLive = await maybe('Main signed in (live)', () => page.evaluate(`Boolean(document.querySelector(${q(`${POP} [data-account="${MAIN}"] [data-action="account-switch"]`)}))`), 30_000);
    check('U2a', mainLive, 'Main offers Switch (Claude Code says the default home is signed in to it)');
    check('U2a2', await press(`${POP} [data-account="${MAIN}"] [data-action="account-switch"]`), 'Switch on Main takes a click');
    await maybe('Main active', () => page.evaluate(`Boolean(document.querySelector(${q(`${POP} [data-accounts-pane="active"] [data-account="${MAIN}"]`)}))`), 10_000);
    const reading = await maybe('Main active, being read', () => page.evaluate(`(() => { const s = document.querySelector(${q(`${POP} [data-accounts-pane="active"] [data-account="${MAIN}"]`)}); return s && s.querySelector('[data-account-usage-reading]') ? s.textContent : null; })()`), 6_000);
    check('U2b', Boolean(reading), 'right after the switch, Main (now active) says "Reading usage…"', reading);
    const stillOn = await maybe('the still-on banner', () => text(`${POP} [data-accounts-still-on]`), 10_000);
    check('U2c', /1 agent still on Aux until idle/.test(stillOn ?? '') && /Restart on Main now/.test(stillOn ?? ''), 'the panel says 1 agent is still on Aux until idle, with Restart on Main now', stillOn);
    await shot('01-right-after-switch');

    // U3: a few seconds later, Main's own window.
    const windows = await maybe('Main\'s own windows', () => page.evaluate(`(() => { const s = document.querySelector(${q(`${POP} [data-account="${MAIN}"]`)}); const w = s ? [...s.querySelectorAll('[data-account-window]')] : []; return w.length > 0 ? { windows: w.map((x) => x.getAttribute('data-account-window')), text: s.textContent } : null; })()`), 30_000);
    check('U3a', windows?.windows?.includes('7d') && /12% used/.test(windows.text) && !/not read yet|Reading usage/.test(windows.text), 'a few seconds later Main shows its OWN 7d window (12% used), not Aux\'s 33%', windows);
    const mainProbe = calls().find((c) => c.probe && c.dir === null);
    check('U3b', Boolean(mainProbe) && mainProbe.args[mainProbe.args.indexOf('--model') + 1] === 'haiku' && mainProbe.args.includes('--max-turns') && mainProbe.args[mainProbe.args.indexOf('--tools') + 1] === '', 'the probe ran in the default home, on haiku, one turn, no tools, nothing kept', mainProbe?.args.join(' '));
    await shot('02-a-few-seconds-later');

    // U4: atlas says where it is.
    await click(CHIP); await sleep(300);
    const header = await maybe('the header', () => text(`[data-agent-runs-on="${AUX}"]`), 15_000);
    check('U4a', /On Aux · moves to Main at next idle/.test(header ?? ''), 'the agent header: On Aux · moves to Main at next idle', header);
    const chat = await maybe('the chat', () => text(`${CHAT} [data-chat-account]`), 15_000);
    check('U4b', /on Aux until idle, then Main/.test(chat ?? ''), 'the chat: on Aux until idle, then Main', chat);
    check('U4c', await page.evaluate(`Boolean(document.querySelector('[data-surface="agent"] [data-action="move-now"]'))`), 'the header offers Restart on Main now');
    await shot('03-agent-still-on-old-account');

    // U5: Check usage now on Aux.
    await click(CHIP);
    await until('the popover again', () => page.evaluate(`Boolean(document.querySelector(${q(POP)}))`), 10_000);
    const auxBefore = calls().filter((c) => c.probe && c.dir === auxDir).length;
    check('U5a', await press(`${POP} [data-account="${AUX}"] [data-action="check-usage"]`), 'Aux has Check usage now');
    const auxReading = await maybe('Aux reading', () => page.evaluate(`Boolean(document.querySelector(${q(`${POP} [data-account="${AUX}"] [data-account-usage-reading]`)}))`), 5_000);
    check('U5b', auxReading, 'Aux says "Reading usage…" at once');
    await shot('04-check-usage-now');
    const auxDone = await maybe('Aux read', async () => calls().filter((c) => c.probe && c.dir === auxDir).length > auxBefore && !(await page.evaluate(`Boolean(document.querySelector(${q(`${POP} [data-account="${AUX}"] [data-account-usage-reading]`)}))`)), 30_000);
    check('U5c', auxDone, 'Check usage now read Aux, in Aux\'s own folder, at once');

    // U6: Restart on Main now.
    check('U6a', await press(`${POP} [data-accounts-still-on] [data-action="move-now"]`), 'Restart on Main now takes a click');
    const moved = await maybe('atlas on Main', () => page.evaluate(`!document.querySelector(${q(`${POP} [data-accounts-still-on]`)}) && Boolean(document.querySelector('[data-agent-runs-on="${MAIN}"]'))`), 60_000);
    const onMain = await text(`[data-agent-runs-on="${MAIN}"]`);
    check('U6b', moved && /^On Main$/.test((onMain ?? '').trim()), 'atlas moved to Main: the banner is gone and the header says On Main', onMain);
    // Genie also runs Claude Code for other things after a switch (its model list): the agent's own relaunch is the one resuming its thread.
    const relaunch = calls().find((c) => !c.probe && c.args.includes('--resume') && c.args[c.args.indexOf('--resume') + 1] === SESSION);
    check('U6c', relaunch !== undefined && relaunch.dir === null, 'on its own thread (--resume), in the default home', relaunch ? `${relaunch.dir} ${relaunch.args.join(' ')}` : JSON.stringify(calls().filter((c) => !c.probe).map((c) => [c.dir, c.args.slice(0, 6).join(' ')])));
    await shot('05-after-restart-on-main');
    code = checks.every((c) => c.ok) ? 0 : 1;
} catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    console.error(`FAIL: ${failure}`);
    try { if (page) { const s = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, 'failure.png'), Buffer.from(s.data, 'base64')); } } catch { /* gone */ }
} finally {
    for (const s of sessions) { try { s.socket.close(); } catch { /* gone */ } }
    if (app && app.exitCode === null) { try { if (WIN) execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ } }
    await sleep(2_000);
    if (app && app.exitCode === null && !WIN) { try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ } }
    try { const hostJson = root ? json(join(root, '.genie', 'runtime', 'host.json')) : null; if (hostJson?.pid) process.kill(hostJson.pid, 'SIGKILL'); } catch { /* gone */ }
    writeFileSync(join(OUT, 'result.json'), JSON.stringify({ code, failure, checks }, null, 2));
}
console.log(code === 0 ? '\nUSAGE ON SWITCH OK' : `\nUSAGE ON SWITCH FAILED${failure ? `: ${failure}` : ''}`);
process.exit(code);
