#!/usr/bin/env node
/**
 * ESC UNSENDS, IN THE REAL APP (Tynn #1029). CI/test VM only.
 *
 * The real built Genie, its real chat, a real Esc key press through Chromium. Claude is a stub (esc-unsend-stub-claude.mjs)
 * that stays mid-turn, so the chat's agent is busy and a message sent now waits out the send buffer, and that writes down
 * every message the moment it reaches it: what the AGENT got, not what the UI shows.
 *
 *   E0  gauge control: the first message (it starts the long turn) is found in the stub's record.
 *   E1  a message with an image attached, sent while busy, is held: drawn with "Esc to unsend"; the composer emptied.
 *   E2  Esc inside the buffer: the held message is gone, its text AND its file are back in the composer, the view did not
 *       move (no Agent-view Esc).
 *   E3  after the buffer would have ended: the agent never received it, and the thread does not show it.
 *   E4  POSITIVE CONTROL: the same restored draft sent again and left alone: after the buffer the agent received its text
 *       and its image; an Esc now is NOT taken by the chat (the composer stays empty) and keeps its normal meaning (the
 *       field is blurred).
 *
 * Screenshots in ci-out/esc-unsend-1029/. Result: ci-out/esc-unsend-1029/result.json.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForPageProbe } from './page-probe-cdp.mjs';

const WIN = process.platform === 'win32', OUT = resolve('ci-out/esc-unsend-1029'), PORT = 9354, INSPECT = 9355, started = Date.now(), sessions = [], checks = [];
const RECEIVED = '/tmp/genie-esc-unsend-received.jsonl';
const BUFFER_MS = 5_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const demand = (ok, reason) => { if (!ok) throw new Error(reason); };
const json = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const received = () => { try { return readFileSync(RECEIVED, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
function check(id, ok, label, detail) {
    checks.push({ id, ok: Boolean(ok), label, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${label}${detail === undefined ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
    if (!ok) throw new Error(`${id} failed: ${label}`);
}
const targets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
async function until(label, read, ms = 30_000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await read().catch(() => null); if (v) return v; await sleep(150); } throw new Error(`${label} was not ready in ${ms} ms`); }

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

// A 1x1 PNG: an image the stub sees as an image block.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MARK = 'E1029 unsend me please';

let app, page, main, root, hostRecord, failure = null, code = 1;
try {
    demand(process.env.CI === 'true' || (process.platform === 'linux' && process.env.USER === 'genie'), 'refused: run only in CI or a test VM');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    for (const port of [PORT, INSPECT]) { let busy = false; try { await targets(port); busy = true; } catch (e) { if (e.name === 'TimeoutError') busy = true; } demand(!busy, `debugger port ${port} occupied; no app touched`); }
    rmSync(RECEIVED, { force: true });
    root = mkdtempSync(join(tmpdir(), 'genie-esc-unsend-')); const workspace = join(root, 'workspace'), runtime = join(root, '.genie', 'runtime'); mkdirSync(workspace); mkdirSync(OUT, { recursive: true });
    const stub = resolve('scripts/esc-unsend-stub-claude.mjs'); chmodSync(stub, 0o755);
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: join(root, '.genie'), GENIE_PAGE_PROBE: '1', GENIE2_CLAUDE_BINARY: stub };
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15_000, windowsHide: true });
    const atlas = (json(join(runtime, 'agents.json')) ?? []).find((a) => a.name === 'atlas' && a.provider === 'claude');
    demand(atlas, 'the seeded claude agent');
    const fd = openSync(join(OUT, 'electron.log'), 'w'), electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    const args = ['.', `--remote-debugging-port=${PORT}`, `--inspect=${INSPECT}`, `--user-data-dir=${join(root, 'profile')}`]; if (!WIN) args.push('--no-sandbox');
    if (process.platform === 'linux' && ['wayland', 'x11'].includes(process.env.XDG_SESSION_TYPE)) args.push(`--ozone-platform=${process.env.XDG_SESSION_TYPE}`);
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    app = spawn(xvfb ? 'xvfb-run' : electron, xvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, windowsHide: true, detached: !WIN, stdio: ['ignore', fd, fd] }); closeSync(fd); app.on('error', (e) => console.error(e.message));
    const target = await until('the main window', async () => mainWindow(await targets(PORT)), 240_000);
    page = await Cdp.connect(target.webSocketDebuggerUrl);
    main = await Cdp.connect((await until('the main inspector', async () => (await targets(INSPECT))[0])).webSocketDebuggerUrl);
    await waitForPageProbe(page);
    await until('the page connection', () => page.evaluate('window.genieTest.localProtocol.state().phase === "ready"'), 60_000);
    hostRecord = json(join(runtime, 'host.json'));
    await page.send('Page.enable');

    const CHAT = `[data-chat="pinned"][data-chat-subject="${atlas.id}"]`;
    // The composer ON SCREEN: ChatComposers keeps other chats' composers mounted and hidden (one for '' from before the
    // thread loaded comes first), and only the active one carries data-chat-composer.
    const BOX = `${CHAT} [data-chat-composer] [data-react-fancy-prompt-input]`;
    const FIELD = `${BOX} textarea, ${BOX} [contenteditable="true"]`;
    const shot = async (name) => { const s = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, `${name}.png`), Buffer.from(s.data, 'base64')); console.log(`SHOT ${name}.png`); };
    const key = async (k, code, vk) => { for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); };
    const esc = () => key('Escape', 'Escape', 27);
    const focusField = () => page.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(FIELD)}); f?.focus(); return document.activeElement === f; })()`);
    const typeText = async (text) => { demand(await focusField(), 'the composer takes focus'); await page.send('Input.insertText', { text }); };
    const clickSend = () => page.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(`${BOX} [data-react-fancy-prompt-input-send]`)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const attachPng = (name) => page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(`${BOX} input[type="file"]`)});
        if (!input) return false;
        const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), (c) => c.charCodeAt(0));
        const dt = new DataTransfer(); dt.items.add(new File([bytes], ${JSON.stringify(name)}, { type: 'image/png' }));
        input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const state = () => page.evaluate(`(() => {
        const chat = document.querySelector(${JSON.stringify(CHAT)}), f = document.querySelector(${JSON.stringify(FIELD)});
        const text = f ? (f.tagName === 'TEXTAREA' ? f.value : f.textContent) : null;
        const chips = [...(document.querySelector(${JSON.stringify(BOX)})?.querySelectorAll('[data-react-fancy-prompt-input-attachment]') ?? [])].map((c) => c.textContent.trim());
        const held = [...(chat?.querySelectorAll('[data-chat-held]') ?? [])].map((h) => ({ text: h.querySelector('[data-chat-user-text]')?.textContent ?? '', hint: h.querySelector('[data-unsend-hint]')?.textContent ?? null, files: [...h.querySelectorAll('[data-chat-held-file]')].map((x) => x.textContent) }));
        const thread = [...(chat?.querySelectorAll('[data-chat-message]') ?? [])].map((m) => m.textContent);
        return { busy: chat?.getAttribute('data-chat-busy') ?? null, text, chips, held, threadHasMark: thread.some((t) => t.includes(${JSON.stringify(MARK)})), fieldFocused: document.activeElement === f, agentSurface: document.querySelector('[data-surface="agent"]')?.getAttribute('data-agent') ?? null, dashboard: Boolean(document.querySelector('[data-surface="dashboard"]')) };
    })()`);

    // What's new opens on a first run and covers the window (run 2's screenshots): closed first, as a person would.
    try { await until('What’s new', () => page.evaluate(`Boolean(document.querySelector('[data-whats-new]'))`), 20_000); await page.evaluate(`document.querySelector('[data-action="whats-new-close"]')?.click(); true`); } catch { /* not shown */ }
    await until('What’s new to close', () => page.evaluate(`!document.querySelector('[data-whats-new]')`), 15_000);

    // Open atlas, with its chat beside it.
    await page.evaluate(`window.location.hash = '#genie://agent/${atlas.id}?tab=stream'; true`);
    await until('atlas with its chat and composer', () => page.evaluate(`Boolean(document.querySelector(${JSON.stringify(FIELD)}))`), 60_000);

    // E0: the first message starts atlas on the stub's long turn; the stub's record finds it (the gauge reads one).
    await typeText('E1029 start a long turn');
    demand(await clickSend(), 'the send button');
    let first = await until('the first message at the stub', async () => received().find((r) => r.text.includes('start a long turn')), 60_000).catch(() => null);
    if (!first && await page.evaluate(`Boolean(document.querySelector('[data-action="start-agent"]'))`)) {
        await page.evaluate(`document.querySelector('[data-action="start-agent"]').click(); true`);
        first = await until('the first message at the stub (after Start)', async () => received().find((r) => r.text.includes('start a long turn')), 90_000);
    }
    check('E0', Boolean(first), 'gauge control: the stub records a message that reached the agent', first);
    await until('atlas mid-turn (data-chat-busy)', async () => (await state()).busy === 'true', 60_000);

    // E1: held, with its file, and the hint. Nothing covers the window: the key goes where a person's would.
    demand(await page.evaluate(`!document.querySelector('[role="dialog"]')`), 'no dialog over the window before E1');
    await typeText(MARK);
    demand(await attachPng('unsend-me.png'), 'the composer file input');
    await until('the attachment chip', async () => (await state()).chips.length === 1, 10_000);
    const sentAt = Date.now();
    demand(await clickSend(), 'the send button (E1)');
    const heldNow = await until('the held message', async () => { const s = await state(); return s.held.length === 1 ? s : null; }, 3_000);
    check('E1', heldNow.held[0].text.includes(MARK) && /Esc\s*to unsend/.test(heldNow.held[0].hint ?? '') && heldNow.held[0].files.includes('unsend-me.png') && (heldNow.text ?? '').trim() === '' && heldNow.chips.length === 0,
        'held in the buffer: drawn with "Esc to unsend" and its file; the composer emptied', heldNow);
    await shot('01-held-esc-to-unsend');

    // E2: Esc in the buffer, from the composer (where the person's focus is after sending).
    demand(await focusField(), 'focus back in the composer');
    await esc();
    const pressedAt = Date.now();
    const back = await until('the message back in the box', async () => { const s = await state(); return s.held.length === 0 && (s.text ?? '').includes(MARK) && s.chips.length === 1 ? s : null; }, 3_000).catch(async () => state());
    check('E2', pressedAt - sentAt < BUFFER_MS && back.held.length === 0 && (back.text ?? '').includes(MARK) && back.chips.length === 1 && /unsend-me\.png/.test(back.chips[0]) && back.fieldFocused && back.agentSurface === atlas.id && !back.dashboard,
        'Esc inside the buffer: gone from the thread, text and file back in the composer, the view did not move', { ...back, pressedAfterMs: pressedAt - sentAt });
    await shot('02-esc-back-in-the-box');

    // E3: past the buffer, nothing reached the agent.
    await sleep(BUFFER_MS + 3_000);
    const after = await state(), got = received();
    check('E3', !got.some((r) => r.text.includes(MARK)) && !after.threadHasMark && after.held.length === 0 && (after.text ?? '').includes(MARK),
        'after the buffer: the agent never received it, the thread does not show it, the draft is still in the box', { received: got.map((r) => r.text), after });
    await shot('03-after-buffer-never-sent');

    // E4: POSITIVE CONTROL. The same restored draft, sent and left alone.
    const sent2 = Date.now();
    demand(await clickSend(), 'the send button (E4)');
    await until('held again', async () => (await state()).held.length === 1, 3_000);
    await shot('04a-control-held');
    const arrived = await until('the control at the agent', async () => received().find((r) => r.text.includes(MARK)), BUFFER_MS + 15_000).catch(() => null);
    await until('the control off the held row', async () => (await state()).held.length === 0, 15_000).catch(() => null);
    demand(await focusField(), 'focus in the composer (E4)');
    await esc();
    await sleep(500);
    const control = await state();
    check('E4', arrived !== null && arrived.at - sent2 >= BUFFER_MS - 250 && arrived.files.length === 1 && arrived.files[0].type === 'image' && arrived.files[0].bytes > 0 && (control.text ?? '').trim() === '' && control.chips.length === 0 && !control.fieldFocused,
        'control: left alone it reached the agent after the buffer, with its image; Esc after the buffer is not an unsend (composer stays empty) and keeps its meaning (field blurred)', { arrived, arrivedAfterMs: arrived ? arrived.at - sent2 : null, control });
    await shot('04b-control-delivered-esc-normal');
    code = 0;
} catch (e) { failure = e.stack ?? String(e); console.error(failure); }
finally {
    try { await main?.evaluate("process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').app.exit(0);true"); } catch {}
    for (const s of sessions) try { s.socket.close(); } catch {}
    await sleep(1000); if (app?.exitCode === null) { try { app.kill('SIGTERM'); } catch {} }
    const record = root ? json(join(root, '.genie', 'runtime', 'host.json')) : null;
    if (hostRecord && record?.pid === hostRecord.pid && record.startedAt === hostRecord.startedAt && Number.isFinite(record.startedAt) && record.startedAt >= started) { try { process.kill(record.pid, 'SIGTERM'); } catch {} }
    const head = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim(); } catch { return null; } })();
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'result.json'), JSON.stringify({ code, head, platform: process.platform, failure, checks, received: received() }, null, 2));
    console.log(`ESC_UNSEND_RESULT code=${code} passed=${checks.filter((c) => c.ok).length}/${checks.length}`);
    process.exitCode = code;
}
