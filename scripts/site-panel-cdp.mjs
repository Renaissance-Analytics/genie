#!/usr/bin/env node
/**
 * A SITE PANEL IN GENIE'S OWN WINDOW (the host split, P2b): the built app, its real CSP, its real preload, a real <webview>.
 * The unit tests hold the guard and the layer; this holds that they are wired into the window and that the window lets a
 * guest exist at all. Measured before only on bare Electron, under that CSP with 'unsafe-inline' added for the probe.
 *
 * What it can't show: the page itself. CI's unpackaged app has no Caddy, so a guest reaches the front door's address and
 * stops there. The page and its login are the VM's: this says so by checking only what holds without a door.
 *
 * It launches Electron, so it refuses to run anywhere but CI or a test machine (SITE_PANEL_CDP_ALLOW=1). Exit 0 all passed; 1 a
 * check failed; 2 cannot run here. Every wait has a deadline, and the whole run has one.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.CI !== 'true' && process.env.SITE_PANEL_CDP_ALLOW !== '1') { console.error('refused: this launches Electron, and runs only on CI or a test machine'); process.exit(2); }

const PORT = Number(process.env.CDP_PORT ?? 9333);
// With no key: nothing may open a store (core/browser-store.ts). A launch of its own, that a keyring can't help.
const LOCKED = process.env.SITE_PANEL_LOCKED === '1';
const STORE_ARG = LOCKED ? '--password-store=basic' : '--password-store=gnome-libsecret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const walk = (dir, found = []) => { let names = []; try { names = readdirSync(dir); } catch { return found; } for (const name of names) { const p = join(dir, name); try { if (statSync(p).isDirectory()) walk(p, found); else found.push(p); } catch { /* gone */ } } return found; };
function check(ok, label, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
async function until(what, ms, read) {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
        try { last = await read(); if (last) return last; } catch (error) { last = null; console.log(`  (${what}: ${error.message})`); }
        await sleep(500);
    }
    return null;
}

class Cdp {
    #socket; #next = 1; #pending = new Map();
    static async connect(url) {
        const cdp = new Cdp();
        cdp.#socket = new WebSocket(url);
        cdp.#socket.addEventListener('message', (event) => { const frame = JSON.parse(event.data); const done = cdp.#pending.get(frame.id); if (done) { cdp.#pending.delete(frame.id); done(frame); } });
        await new Promise((resolve, reject) => { cdp.#socket.addEventListener('open', resolve, { once: true }); cdp.#socket.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true }); });
        return cdp;
    }
    send(method, params = {}) { const id = this.#next++; return new Promise((resolve) => { this.#pending.set(id, resolve); this.#socket.send(JSON.stringify({ id, method, params })); }); }
    async evaluate(expression) {
        const frame = await Promise.race([this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(20_000).then(() => { throw new Error(`no answer in 20 s: ${expression.slice(0, 60)}`); })]);
        if (frame.result?.exceptionDetails) throw new Error(`page threw: ${frame.result.exceptionDetails.exception?.description ?? 'unknown'}`);
        return frame.result?.result?.value;
    }
    close() { this.#socket.close(); }
}

// A home of its own. Every Genie process reads its root through genieRoot() (#1605): GENIE_HOME when set, else ~/.genie by
// the OS's home. Both are set here, to the same folder, so either reading lands in it.
const user = mkdtempSync(join(tmpdir(), 'site-panel-user-'));
const home = join(user, '.genie');
const data = mkdtempSync(join(tmpdir(), 'site-panel-data-'));
const ws = mkdtempSync(join(tmpdir(), 'site-panel-ws-'));
const WORKSPACE = 'sitepanelws';
const HOST = 'panelsite.gen';
// A site with its own server: a route with no Caddy, as a site's proxy needs none here.
const siteServer = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>panelsite</title><p>panel page</p>'); });
await new Promise((r) => siteServer.listen(0, '127.0.0.1', r));
siteServer.unref();
writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: 'Site panel', sites: { panelsiteaaaaaaaa: { repo: '', runMode: 'host', kind: 'http', enabled: true, name: 'panelsite', genName: HOST, hostPort: siteServer.address().port } } }, null, 2)}\n`);
mkdirSync(join(home, 'runtime'), { recursive: true });
writeFileSync(join(home, 'runtime', 'workspaces.json'), JSON.stringify([{ id: WORKSPACE, path: ws }], null, 2));

const log = openSync(join(tmpdir(), 'site-panel-electron.log'), 'a');
const launcher = process.platform === 'linux' ? ['xvfb-run', ['--auto-servernum', '--server-args=-screen 0 1440x900x24', 'npx', 'electron', '.', '--no-sandbox', STORE_ARG]] : ['npx', ['electron', '.']];
const app = spawn(launcher[0], [...launcher[1], `--remote-debugging-port=${PORT}`, `--user-data-dir=${data}`], { env: { ...process.env, HOME: user, USERPROFILE: user, GENIE_HOME: home, GENIE_PAGE_PROBE: '1' }, stdio: ['ignore', log, log], detached: process.platform !== 'win32', shell: process.platform === 'win32' });
const end = (code) => {
    try { if (process.platform !== 'win32') process.kill(-app.pid, 'SIGKILL'); else app.kill(); } catch { /* gone */ }
    if (code !== 0) { try { console.log(readFileSync(join(tmpdir(), 'site-panel-electron.log'), 'utf8').slice(-3000)); } catch { /* none */ } }
    process.exit(code);
};
setTimeout(() => { console.log('FAIL the run\'s own deadline, 260 s'); end(1); }, 260_000).unref?.();

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
try {
    const page = await until('the window', 60_000, async () => (await targets()).find((t) => t.type === 'page' && /index\.html/.test(t.url)));
    if (!page) { check(false, 'the main window came up'); end(1); }
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    const ready = await until('window.genie', 60_000, () => cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"'));
    check(ready === true, 'the main window came up, with its preload');

    const webviews = async () => (await targets()).filter((t) => t.type === 'webview');
    if (LOCKED) {
        const refused = await cdp.evaluate(`window.genie.sitePanels.prepare(${JSON.stringify(HOST)})`);
        check(refused.ok === false && refused.locked === true, 'no key: a site is refused, and says why', JSON.stringify(refused));
        // No keyring at all (basic): the words say none is available and what to install, never "unlock it".
        check(/no system keyring is available/.test(refused.error ?? '') && /GNOME Keyring or KWallet/.test(refused.error ?? '') && !/unlock/i.test(refused.error ?? ''), 'no keyring: the panel’s words say none is there and what to install', JSON.stringify(refused.error));
        await cdp.evaluate(`(() => { const v = document.createElement('webview'); v.setAttribute('src', 'https://${HOST}/'); document.body.appendChild(v); return true; })()`);
        await sleep(2500);
        check((await webviews()).length === 0, 'no key: a webview gets no guest', JSON.stringify((await webviews()).map((t) => t.url)));
        check(!existsSync(join(home, 'browser', WORKSPACE)), 'no key: no store was opened');
        cdp.close();
        console.log(failures.length === 0 ? 'site-panel-cdp locked: all passed' : `site-panel-cdp locked: FAILED ${failures.join('; ')}`);
        end(failures.length === 0 ? 0 : 1);
    }
    const addTag = (src) => cdp.evaluate(`(() => { const v = document.createElement('webview'); v.setAttribute('src', ${JSON.stringify(src)}); document.body.appendChild(v); return true; })()`);

    // The tag exists at all, in this window: without webviewTag it is an inert element with no getWebContentsId.
    await addTag('about:blank');
    await sleep(1500);
    check(await cdp.evaluate(`typeof document.querySelector('webview').reload === 'function'`), 'CONTROL the main window has the webview tag');
    check((await webviews()).length === 0, 'an about:blank webview is refused by main: no guest', JSON.stringify((await webviews()).map((t) => t.url)));

    const refused = await cdp.evaluate(`window.genie.sitePanels.prepare('not-served.gen')`);
    check(refused.ok === false, 'a site not served here is refused, in words', JSON.stringify(refused));

    await addTag(`file://${join(ws, 'public', 'index.html').replace(/\\/g, '/')}`);
    await addTag('https://example.com/');
    await sleep(2500);
    check((await webviews()).length === 0, 'a file:// and an open-web webview are refused: no guest', JSON.stringify((await webviews()).map((t) => t.url)));

    // A site waits for the person's first start; this is that click's action.
    const prepared = await until(`${HOST} to be served`, 45_000, async () => {
        const r = await cdp.evaluate(`window.genie.sitePanels.prepare(${JSON.stringify(HOST)})`);
        if (r.ok) return r;
        const state = await cdp.evaluate(`window.genie.features.snapshot().then((d) => JSON.stringify((d.hosting?.sites ?? []).map((x) => ({ id: x.id, host: x.host, state: x.state, reason: x.reason ?? x.error ?? null }))))`);
        console.log(`  prepare: ${JSON.stringify(r)}; sites: ${state}`);
        const site = JSON.parse(state ?? '[]').find((x) => x.host === HOST);
        if (site) console.log(`  start: ${JSON.stringify(await cdp.evaluate(`window.genie.features.act({ kind: 'hosting.startSite', siteId: ${JSON.stringify(site.id)} }).then((r) => JSON.stringify(r ?? null), (e) => String(e))`))}`);
        return null;
    });
    check(prepared?.ok === true, 'CONTROL an enabled site is allowed, with its store routed', JSON.stringify(prepared));

    // Through the product: the tab's panel, not a tag of ours.
    const tabs = { tabs: [{ id: 'sitetab', name: 'SiteTab', layout: 'single', cells: [{ kind: 'site', ref: HOST }] }] };
    const set = await cdp.evaluate(`window.genieTest.workspaces.setSetting(${JSON.stringify(WORKSPACE)}, 'workspace_tabs', ${JSON.stringify(JSON.stringify(tabs))})`);
    console.log(`  setSetting: ${JSON.stringify(set)}`);
    await cdp.evaluate(`window.location.hash = '#genie://workspace/${WORKSPACE}?view=tab:sitetab'; true`);
    const opened = await until('the tab', 20_000, () => cdp.evaluate(`!!document.querySelector('[data-site-panel-box]')`));
    if (opened !== true) console.log(`  at the failure: ${await cdp.evaluate(`JSON.stringify({ hash: location.hash, text: (document.querySelector('[data-surface="workspace"]')?.textContent ?? 'no workspace surface').slice(0, 300) })`)}`);
    check(opened === true, 'the workspace tab shows the site panel');

    const guest = await until('the guest', 20_000, async () => (await webviews()).find((t) => t.url.includes(HOST)) ?? null);
    check(guest !== null, 'the panel made a guest, under the window\'s real CSP', JSON.stringify((await webviews()).map((t) => t.url)));
    const placed = await cdp.evaluate(`(() => { const b = document.querySelector('[data-site-panel-box]')?.getBoundingClientRect(); const v = [...document.querySelectorAll('webview')].find((w) => (w.getAttribute('src') || '').includes(${JSON.stringify(HOST)})); if (!b || !v) return null; const r = v.getBoundingClientRect(); return { box: [b.left, b.top, b.width, b.height].map(Math.round), view: [r.left, r.top, r.width, r.height].map(Math.round), visibility: getComputedStyle(v).visibility }; })()`);
    check(placed !== null && placed.visibility === 'visible' && placed.view.join() === placed.box.join() && placed.box[2] > 0, 'the page sits over the panel\'s box', JSON.stringify(placed));

    if (guest) {
        const inside = await Cdp.connect(guest.webSocketDebuggerUrl);
        const seen = await until('the guest to answer', 15_000, () => inside.evaluate(`JSON.stringify({ genie: typeof window.genie, require: typeof require, process: typeof process })`));
        check(seen !== null && JSON.parse(seen).genie === 'undefined' && JSON.parse(seen).require === 'undefined' && JSON.parse(seen).process === 'undefined', 'the guest has no preload API and no Node', String(seen));
        // The guest's session is the store: a cookie set through the guest lands in that folder's file. Prepare alone makes the folder.
        await inside.send('Network.enable');
        const cookie = await inside.send('Network.setCookie', { name: 'panelrowcookie', value: 'panelrowvalue', domain: HOST, path: '/', secure: true, expires: Date.now() / 1000 + 3600 });
        check(cookie.result?.success === true, 'CONTROL a cookie can be set through the guest', JSON.stringify(cookie.result ?? cookie.error));
        const inFile = (dir) => walk(dir).filter((file) => /Cookies$/.test(file) && readFileSync(file).includes('panelrowcookie'));
        const landed = await until('the cookie to reach the store', 60_000, () => inFile(join(home, 'browser', WORKSPACE, 'window')).length > 0);
        check(landed === true, 'the guest\'s cookies are in the workspace\'s store');
        check(inFile(data).length === 0, 'and not in the window\'s own profile');
        inside.close();
    }
    const store = join(home, 'browser', WORKSPACE, 'window');
    check(existsSync(store), 'the workspace\'s store is under Genie\'s home', store);

    // Leaving the tab keeps the page: the same guest, not reloaded.
    const before = (await webviews()).find((t) => t.url.includes(HOST))?.id;
    const held = await Cdp.connect((await webviews()).find((t) => t.url.includes(HOST)).webSocketDebuggerUrl);
    await held.evaluate('window.kept = 42; true');
    await cdp.evaluate(`window.location.hash = '#genie://dashboard'; true`);
    await sleep(1500);
    const hidden = await cdp.evaluate(`(() => { const v = [...document.querySelectorAll('webview')].find((w) => (w.getAttribute('src') || '').includes(${JSON.stringify(HOST)})); return v ? getComputedStyle(v).visibility : 'no such webview'; })()`);
    check(hidden === 'hidden', 'off screen, the page is hidden', String(hidden));
    check((await webviews()).find((t) => t.url.includes(HOST))?.id === before && before !== undefined, 'and the same guest is still there', String(before));
    // And back: Genie's Workspace mounts again, before its settings have arrived. Batch SS on omarchy-test: the page was closed here.
    await cdp.evaluate(`window.location.hash = '#genie://workspace/${WORKSPACE}?view=tab:sitetab'; true`);
    check(await until('the panel again', 20_000, () => cdp.evaluate(`!!document.querySelector('[data-site-panel-box]')`)) === true, 'back on the tab, the panel is there');
    await sleep(2000);
    check((await webviews()).find((t) => t.url.includes(HOST))?.id === before, 'back on the tab: the same guest', JSON.stringify((await webviews()).map((t) => t.id)));
    check(await held.evaluate('String(window.kept)').catch((e) => e.message) === '42', 'back on the tab: its page as it was left');
    check(await cdp.evaluate(`[...document.querySelectorAll('webview')].filter((w) => (w.getAttribute('src') || '').includes(${JSON.stringify(HOST)})).map((w) => getComputedStyle(w).visibility).join()`) === 'visible', 'back on the tab: one page, visible');
    held.close();
    cdp.close();
} catch (error) {
    check(false, 'the run', error.stack ?? String(error));
}
console.log(failures.length === 0 ? 'site-panel-cdp: all passed' : `site-panel-cdp: FAILED ${failures.join('; ')}`);
end(failures.length === 0 ? 0 : 1);
