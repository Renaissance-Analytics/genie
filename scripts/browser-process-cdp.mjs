#!/usr/bin/env node
/**
 * THE GENIE BROWSER AS ITS OWN PROCESS, IN THE BUILT APP (the host split, P2b; decision 5). A site opened from the window comes
 * up in a second Electron started by the host; killing the window leaves it up, its sites still behind genie-host's own front
 * door (Tynn #1046 D2), so it says nothing is wrong; the host ending ends it.
 *
 * A page loads its real content through genie-host's in-app front door, before the window dies and again after (Tynn #1046
 * D2); Caddy (the external door) is not in CI's unpackaged app and is not what the browser uses.
 *
 * Linux only, on its own Xvfb: under xvfb-run the display ends with the window, and the browser with it, which would prove
 * nothing. It launches Electron, so it refuses to run anywhere but CI or a test machine. Exit 0 all passed; 1 a check
 * failed; 2 cannot run here. Every wait has a deadline, and the whole run has one.
 */
import { mainWindow } from './cdp-main-window.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The feature snapshot is read on the page's own bridge now (P4 family 11): window.genieTest needs this.
process.env.GENIE_PAGE_PROBE ??= '1';

if (process.env.CI !== 'true' && process.env.GENIE_TEST_MACHINE !== '1' && process.env.BROWSER_PROCESS_CDP_ALLOW !== '1') { console.error('refused: this launches Electron, and runs only on CI or a test machine'); process.exit(2); }
if (process.platform !== 'linux') { console.error('Linux only'); process.exit(2); }

const PORT = 9403;
const BROWSER_PORT = 9404;
const DISPLAY = ':77';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
    if (!ok) failures.push(label);
}
async function until(what, ms, read) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { const v = await read(); if (v) return v; } catch (error) { console.log(`  (${what}: ${error.message})`); }
        await sleep(500);
    }
    return null;
}
const processes = () => (spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf(' '); return { pid: Number(l.slice(0, i)), args: l.slice(i + 1) }; });
// By whole argument: the window carries --genie-browser-debug-port too.
const mains = (marker) => processes().filter((p) => { const words = p.args.split(' '); return words.includes(marker) && !p.args.includes('--type=') && /electron/.test(words[0]); });

class Cdp {
    #socket; #next = 1; #pending = new Map();
    static async connect(url) {
        const cdp = new Cdp();
        cdp.#socket = new WebSocket(url);
        cdp.#socket.addEventListener('message', (event) => { const frame = JSON.parse(event.data); const done = cdp.#pending.get(frame.id); if (typeof done === 'function') { cdp.#pending.delete(frame.id); done(frame); } });
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
const targets = async (port) => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();

const user = mkdtempSync(join(tmpdir(), 'browser-process-user-'));
const home = join(user, '.genie');
const data = mkdtempSync(join(tmpdir(), 'browser-process-data-'));
const ws = mkdtempSync(join(tmpdir(), 'browser-process-ws-'));
const WORKSPACE = 'browserprocws';
const HOST = 'browserproc.gen';
// What the site says, changed once the window is gone: a page showing the new words was fetched after it died.
let siteSays = `before-${process.pid}-${Date.now()}`;
const siteServer = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'no-store'); res.end(`<!doctype html><title>site</title><p id="probe">${siteSays}</p>`); });
await new Promise((r) => siteServer.listen(0, '127.0.0.1', r));
siteServer.unref();
writeFileSync(join(ws, 'project.json'), `${JSON.stringify({ name: 'Browser process', sites: { browserprocaaaaaaa: { repo: '', runMode: 'host', kind: 'http', enabled: true, name: 'browserproc', genName: HOST, hostPort: siteServer.address().port } } }, null, 2)}\n`);
mkdirSync(join(home, 'runtime'), { recursive: true });
writeFileSync(join(home, 'runtime', 'workspaces.json'), JSON.stringify([{ id: WORKSPACE, path: ws }], null, 2));

const logFile = join(tmpdir(), 'browser-process-electron.log');
const log = openSync(logFile, 'a');
// THE DISPLAY: the session's own when there is one (a Wayland session, as on an Omarchy machine: scripts/ci/linux.sh), and
// a virtual X screen where there is none (a bare runner) or when CI_DISPLAY=xvfb asks for one. Nothing here needs X.
const inSession = process.platform === 'linux' && process.env.CI_DISPLAY !== 'xvfb' && process.env.XDG_SESSION_TYPE === 'wayland' && !!process.env.WAYLAND_DISPLAY;
// Its own Xvfb, not xvfb-run, where it needs one: under xvfb-run the display ends with the window. A session outlives it already.
const xvfb = inSession ? null : spawn('Xvfb', [DISPLAY, '-screen', '0', '1440x900x24'], { stdio: 'ignore', detached: true });
xvfb?.unref();
if (xvfb) await sleep(1000);
const env = { ...process.env, ...(inSession ? {} : { DISPLAY }), HOME: user, GENIE_HOME: home };
const app = spawn('npx', ['electron', '.', '--no-sandbox', '--password-store=gnome-libsecret', `--remote-debugging-port=${PORT}`, `--genie-browser-debug-port=${BROWSER_PORT}`, `--user-data-dir=${data}`], { env, stdio: ['ignore', log, log], detached: true });
const end = (code) => {
    for (const p of processes()) if (p.args.includes(data) || p.args.includes('--genie-browser') || p.args.includes(home)) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ }
    if (xvfb) { try { process.kill(xvfb.pid, 'SIGKILL'); } catch { /* gone */ } }
    if (code !== 0) {
        try { console.log(readFileSync(logFile, 'utf8').slice(-2500)); } catch { /* none */ }
        try { console.log(readFileSync(join(home, 'logs', 'genie-browser.log'), 'utf8').slice(-2500)); } catch { console.log('(no genie-browser.log)'); }
    }
    process.exit(code);
};
setTimeout(() => { console.log('FAIL the run\'s own deadline, 240 s'); end(1); }, 240_000).unref?.();

try {
    const page = await until('the window', 60_000, async () => mainWindow(await targets(PORT)));
    if (!page) { check(false, 'the main window came up'); end(1); }
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    check(await until('window.genie', 60_000, () => cdp.evaluate('typeof window.genie === "object" && document.readyState === "complete"')) === true, 'the main window came up, with its preload');
    await until(`${HOST} served`, 45_000, async () => {
        const r = await cdp.evaluate(`window.genie.sitePanels.prepare(${JSON.stringify(HOST)})`);
        if (r.ok) return r;
        const sites = JSON.parse(await cdp.evaluate(`(window.genieTest ?? window.genie).features.snapshot().then((d) => JSON.stringify(d.hosting?.sites ?? []))`) ?? '[]');
        const site = sites.find((x) => x.host === HOST);
        if (site) await cdp.evaluate(`(window.genieTest ?? window.genie).features.act({ kind: 'hosting.startSite', siteId: ${JSON.stringify(site.id)} }).then(() => true, () => false)`);
        return null;
    });

    check(mains('--genie-browser').length === 0, 'CONTROL no browser process before anything asks for one');
    await cdp.evaluate(`window.genie.browserWindow.open(${JSON.stringify(HOST)}).then((r) => JSON.stringify(r))`).then((r) => console.log(`  open: ${r}`));
    const up = await until('the browser process', 40_000, () => { const m = mains('--genie-browser'); return m.length > 0 ? m[0] : null; });
    check(up !== null, 'asked from the window, a browser process starts', up ? `pid ${up.pid}` : '');
    const chrome = await until('its chrome', 40_000, async () => (await targets(BROWSER_PORT)).find((t) => t.type === 'page' && /browser\.html/.test(t.url)) ?? null);
    check(chrome !== null, 'its own chrome, on its own debugger');
    const window = chrome ? await Cdp.connect(chrome.webSocketDebuggerUrl) : null;
    if (window) {
        const tab = await until('the tab', 20_000, () => window.evaluate(`document.querySelectorAll('[data-browser-tab]').length`));
        check(tab === 1, 'the site came up in a tab there', String(tab));
    }
    // The site's own page in the browser process: its view's target, and what it shows.
    const sitePage = async () => { const t = (await targets(BROWSER_PORT)).find((x) => x.type === 'page' && x.url.includes(HOST)); return t ? Cdp.connect(t.webSocketDebuggerUrl) : null; };
    const shows = (cdp) => cdp.evaluate(`document.getElementById('probe')?.textContent ?? ''`);
    const before = siteSays;
    const siteCdp = await until('the site page', 30_000, sitePage);
    // CONTROL (the gauge can see a page load): with the window here, the site's real content came through the front door.
    check(siteCdp !== null && (await until('its content', 30_000, async () => ((await shows(siteCdp)) === before ? true : null))) === true, 'CONTROL the site page shows its content through the front door', before);
    const pageTabs = (await targets(PORT)).filter((t) => /browser\.html/.test(t.url));
    check(pageTabs.length === 0, 'the window process holds no Genie browser for this machine', JSON.stringify(pageTabs.map((t) => t.url)));

    const mainPid = mains(`--remote-debugging-port=${PORT}`)[0]?.pid;
    check(typeof mainPid === 'number' && mainPid !== up?.pid, 'CONTROL a separate window process', `window ${mainPid}, browser ${up?.pid}`);
    const hostPid = JSON.parse(readFileSync(join(home, 'runtime', 'host.json'), 'utf8')).pid;

    process.kill(mainPid, 'SIGKILL');
    await sleep(4000);
    check(mains(`--remote-debugging-port=${PORT}`).length === 0, 'CONTROL the window process is gone');
    check(mains('--genie-browser').some((p) => p.pid === up.pid), 'the window killed: the browser process stays');
    if (window) {
        check(await window.evaluate(`typeof window.genieBrowser === 'object'`) === true, 'and still answers');
        // The front door is genie-host's (Tynn #1046 D2): the window going takes nothing of it down, so no "can't load" notice
        // comes, however long it is given, and the site's tab is still there.
        await sleep(6000);
        const read = (selector) => window.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
        // CONTROL: the same reader reads the text of an element that is there (the site's tab), so an empty notice is no blind read.
        check(((await read('[data-browser-tab]')) ?? '').trim() !== '', 'CONTROL the reader reads a tab\'s text');
        const notice = (await read('[data-browser-notice]')) ?? '';
        check(!/can.t load/.test(notice), 'and says nothing is wrong: genie-host\'s door stayed up', JSON.stringify(notice));
        check(await window.evaluate(`document.querySelectorAll('[data-browser-tab]').length`) === 1, 'and the site\'s tab is still there');
    }
    // THE NEW CONTRACT, POSITIVELY: with the window dead, a fresh load of the site gets its NEW content, through genie-host's
    // own front door (the window held the door before D2, and this load failed).
    siteSays = `after-${process.pid}-${Date.now()}`;
    if (siteCdp) {
        await siteCdp.send('Page.reload', { ignoreCache: true });
        const fresh = await until('the reloaded content', 30_000, async () => ((await shows(siteCdp)) === siteSays ? true : null));
        check(fresh === true, 'with no window, a reload loads the site\'s new content through genie-host\'s front door', siteSays);
    } else check(false, 'with no window, a reload loads the site\'s new content through genie-host\'s front door', 'no site page');

    process.kill(hostPid, 'SIGTERM');
    const gone = await until('the browser to end', 30_000, () => !mains('--genie-browser').some((p) => p.pid === up.pid));
    check(gone === true, 'the host ending on purpose ends the browser');
} catch (error) {
    check(false, 'the run', error.stack ?? String(error));
}
console.log(failures.length === 0 ? 'browser-process-cdp: all passed' : `browser-process-cdp: FAILED ${failures.join('; ')}`);
end(failures.length === 0 ? 0 : 1);
