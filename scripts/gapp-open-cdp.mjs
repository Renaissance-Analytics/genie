#!/usr/bin/env node
/**
 * A REAL INSTALLED APP OPENS (Tynn #595). CI or a test VM only: never the owner's desktop.
 *
 * The real product, in its own home and profile: an installed app already in the GApp book (the same files a person who
 * installed it has), the store's Open button clicked in the real window, and the app's own window checked over CDP. Its
 * page must load from the app's https origin, through the front door and Genie's `.gen` certificate, and `app.me` must
 * answer over the real channel. Nothing in src knows this script exists.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { waitForPageProbe } from './page-probe-cdp.mjs';

const PORT = Number(process.env.CDP_PORT ?? 9336);
const WIN = process.platform === 'win32';
const OUT = resolve('smoke-out');
const APP = 'com.example.realapp';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
function demand(ok, message) { if (!ok) throw new Error(message); }
async function until(label, fn, ms = 60_000) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        try { const value = await fn(); if (value) return value; } catch (error) { last = error.message; }
        await sleep(200);
    }
    throw new Error(`${label}: nothing in ${ms} ms${last ? ` (${last})` : ''}`);
}

class Cdp {
    next = 0;
    pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.socket = new WebSocket(url);
        c.socket.addEventListener('message', (event) => {
            const frame = JSON.parse(event.data);
            if (frame.id !== undefined) { c.pending.get(frame.id)?.(frame); c.pending.delete(frame.id); }
        });
        await new Promise((ok, fail) => { c.socket.addEventListener('open', ok, { once: true }); c.socket.addEventListener('error', fail, { once: true }); });
        return c;
    }
    async evaluate(expression) {
        const id = ++this.next;
        const frame = await Promise.race([
            new Promise((ok) => { this.pending.set(id, ok); this.socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); }),
            sleep(30_000).then(() => { throw new Error(`no answer to: ${expression.slice(0, 80)}`); }),
        ]);
        if (frame.error) throw new Error(frame.error.message);
        if (frame.result.exceptionDetails) throw new Error(frame.result.exceptionDetails.exception?.description ?? 'page exception');
        return frame.result.result.value;
    }
    close() { this.socket.close(); }
}

/** An app already installed: its files, and the book's record of them with the digest of exactly those files. */
function seedInstalledApp(home) {
    const dir = join(home, 'gapps', APP, '1.0.0');
    const files = {
        'app/index.html': '<!doctype html><title>Real app</title><p>A real installed app.</p>',
        'genie-package.json': JSON.stringify({
            id: APP, name: 'Real App', version: '1.0.0', publisher: { name: 'Example' },
            contributions: [{
                id: `${APP}.app`, kind: 'app', docs: { name: 'Real App', description: 'An app.' },
                reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: {
                    calls: ['app.me', 'app.call', 'app.storage.get', 'app.storage.set', 'app.storage.delete', 'app.storage.list'],
                    events: ['app.grantChanged', 'app.catalogChanged'],
                } },
                permissions: { capabilities: [], network: [] },
                payload: { entry: 'app/index.html', uses: ['knowledge'], storage: 'app' },
            }],
        }),
    };
    mkdirSync(join(dir, 'app'), { recursive: true });
    for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), text);
    const listing = Object.keys(files).map((path) => ({ path, key: Buffer.from(path, 'utf8') })).sort((a, b) => Buffer.compare(a.key, b.key)).map(({ path }) => `${sha(Buffer.from(files[path], 'utf8'))}  ${path}\n`).join('');
    const digest = sha(Buffer.from(listing, 'utf8'));
    writeFileSync(join(home, 'gapps', 'book.json'), JSON.stringify({ apps: [{
        packageId: APP, name: 'Real App', version: '1.0.0', digest, state: 'installed', unverified: true,
        grant: { packageId: APP, version: '1.0.0', digest, publisher: 'unverified', uses: ['knowledge'], network: [], scope: 'workstation', grantedAt: 1, grantedBy: 'person' },
    }] }));
}

let app, root, log, code = 1;
try {
    demand(process.env.CI === 'true', 'refused: this runs the real app, so only on CI');
    demand(existsSync('dist/main/entry.js'), 'run from a built checkout');
    root = mkdtempSync(join(tmpdir(), 'genie-gapp-open-'));
    mkdirSync(OUT, { recursive: true });
    const workspace = join(root, 'workspace');
    const home = join(root, '.genie');
    mkdirSync(workspace);
    mkdirSync(home);
    const env = { ...process.env, HOME: root, USERPROFILE: root, GENIE_HOME: home, GENIE_PAGE_PROBE: '1' };
    execFileSync(process.execPath, [resolve('scripts/smoke-seed.mjs')], { cwd: workspace, env, stdio: 'pipe', timeout: 15_000, windowsHide: true });
    seedInstalledApp(home);

    log = openSync(join(OUT, 'gapp-open-electron.log'), 'w');
    const electron = resolve('node_modules/electron', WIN ? 'dist/electron.exe' : 'dist/electron');
    const args = ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(root, 'profile')}`, ...(WIN ? [] : ['--no-sandbox'])];
    const xvfb = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    app = spawn(xvfb ? 'xvfb-run' : electron, xvfb ? ['--auto-servernum', '--server-args=-screen 0 1440x900x24', electron, ...args] : args, { env, windowsHide: true, detached: !WIN, stdio: ['ignore', log, log] });

    const target = await until('the app page', async () => (await targets()).find((t) => t.type === 'page' && /index\.html/.test(t.url)));
    const page = await Cdp.connect(target.webSocketDebuggerUrl);
    await waitForPageProbe(page);
    await until('a ready page connection', () => page.evaluate('window.genieTest.localProtocol.state().phase === "ready"'));

    await until('the GApps icon', () => page.evaluate('(() => { const b = document.querySelector(\'[data-feature="GApps"]\'); if (!b) return false; b.click(); return true; })()'));
    // The store reads the book when it opens: the installed app's row, then its Open button, clicked as a person does.
    await until('the Open button of the installed app', () => page.evaluate(`(() => { const b = document.querySelector('[data-gapp="${APP}"] [data-gapp-action="open"]'); if (!b || b.disabled) return false; b.click(); return true; })()`));

    const opened = await until('the app window', async () => (await targets()).find((t) => t.type === 'page' && /\.apps\.gen\//.test(t.url)));
    console.log(`app window: ${opened.url}`);
    demand(opened.url === 'https://com-example-realapp.apps.gen/app/index.html', `the window is at ${opened.url}`);
    const win = await Cdp.connect(opened.webSocketDebuggerUrl);
    await until('its page', () => win.evaluate('document.readyState === "complete" && document.title === "Real app"'));

    const me = await until('app.me over the real channel', () => win.evaluate('window.genieApp.request("app.me")'), 30_000);
    console.log(`app.me: ${JSON.stringify(me)}`);
    demand(me.packageId === APP && me.version === '1.0.0' && me.preview === false && me.publisher === 'unverified', `app.me said ${JSON.stringify(me)}`);
    demand(Array.isArray(me.granted) && me.granted.includes('knowledge'), `granted is ${JSON.stringify(me.granted)}`);
    const stored = await win.evaluate('window.genieApp.request("app.storage.set", { key: "k", value: 7 }).then(() => window.genieApp.request("app.storage.get", { key: "k" }))');
    demand(stored === 7, `the store gave back ${JSON.stringify(stored)}`);

    // Sealed: only the bridge reaches the page.
    const sealed = await win.evaluate('({ require: typeof window.require, process: typeof window.process, genie: typeof window.genie, keys: Object.keys(window.genieApp).sort() })');
    console.log(`sealed: ${JSON.stringify(sealed)}`);
    demand(sealed.require === 'undefined' && sealed.process === 'undefined' && sealed.genie === 'undefined' && sealed.keys.join() === 'on,request', `the window is not sealed: ${JSON.stringify(sealed)}`);
    const refused = await win.evaluate('window.genieApp.request("app.call", { elementId: "imDone", args: {} }).then(() => "ran", (e) => e.message)');
    console.log(`an element not granted: ${refused}`);
    demand(refused.startsWith('NotGrantedError(imDone)'), `an element not granted answered: ${refused}`);

    console.log('PASS: a real installed app opened, its bridge connected');
    code = 0;
} catch (error) {
    console.error(`FAIL: ${error.message}`);
    if (log !== undefined) { try { console.error(readFileSync(join(OUT, 'gapp-open-electron.log'), 'utf8').slice(-4000)); } catch { /* no log */ } }
} finally {
    if (app?.pid) {
        try { if (WIN) execFileSync('taskkill', ['/pid', String(app.pid), '/t', '/f'], { stdio: 'ignore' }); else process.kill(-app.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (log !== undefined) closeSync(log);
    await sleep(500);
    if (root) { try { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); } catch { /* the runner is thrown away */ } }
}
process.exit(code);
