#!/usr/bin/env node
/**
 * DRIVE AN INSTALLED v1 GENIE'S OWN UPDATER so it upgrades itself to Genie 2.
 *
 *   EXPECT_VERSION=2.0.0-beta.5 node scripts/upgrade-from-v1-cdp.mjs
 *
 * Runs against a REAL installed `0.7.0-beta.342` or `2.0.0-beta.4` (the old repo's releases),
 * launched with `--remote-debugging-port=9222`, whose `resources/app-update.yml` has been
 * pointed at `serve-feed.mjs` serving a Genie 2 build. Nothing here is Genie 2 code: the
 * bridge driven is v1's `window.genie.updater` — `mode()`, `status()`, `check()`, `apply()` —
 * read from v1's `main/preload.ts` and `main/updater/ipc.ts` at those tags. `apply()` is v1's
 * one-click "Update": download → install → restart, hands-free, through v1's own drain gate
 * (no agents on a fresh install, so the gate opens).
 *
 * The last step makes v1 quit to run the Genie 2 installer, so the socket dropping is the
 * expected end; the caller verifies what is installed and running afterwards.
 */
const PORT = Number(process.env.CDP_PORT ?? 9222);
const EXPECT = process.env.EXPECT_VERSION;
if (!EXPECT) { console.error('EXPECT_VERSION is required'); process.exit(2); }

const failures = [];
function check(ok, label, detail = '') {
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    if (!ok) failures.push(label);
}

async function findTarget() {
    const until = Date.now() + 90_000;
    let last = 'no attempt';
    while (Date.now() < until) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            // v1 opens more than one page (nextron); any page with the bridge will do.
            const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !/devtools/.test(t.url));
            if (page) return page;
            last = `no page yet (${targets.length})`;
        } catch (e) { last = String(e); }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`no window on the debugger port: ${last}`);
}

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => {
            const f = JSON.parse(ev.data);
            const r = c.#pending.get(f.id);
            if (r) { c.#pending.delete(f.id); r(f); }
        });
        await new Promise((res, rej) => {
            c.#ws.addEventListener('open', res, { once: true });
            c.#ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true });
        });
        return c;
    }
    send(method, params = {}) {
        const id = this.#id++;
        return new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); });
    }
    async evaluate(expression) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (f.error) throw new Error(`CDP: ${JSON.stringify(f.error)}`);
        if (f.result.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result.result.value;
    }
    async screenshot(file) {
        const f = await this.send('Page.captureScreenshot', { format: 'png' });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(file, Buffer.from(f.result.data, 'base64'));
    }
    close() { this.#ws.close(); }
}

const status = (cdp) => cdp.evaluate('window.genie.updater.status()');
const until = async (cdp, pred, ms, what) => {
    const end = Date.now() + ms;
    let s = await status(cdp);
    while (!pred(s) && Date.now() < end) { await new Promise((r) => setTimeout(r, 500)); s = await status(cdp); }
    if (!pred(s)) throw new Error(`timed out waiting for ${what}; last status ${JSON.stringify({ ...s, log: undefined })}`);
    return s;
};

console.log('\nTHE UPGRADE PATH FROM v1 — the installed v1 updates itself to Genie 2\n');
const page = await findTarget();
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
try {
    // v1's bridge can take a moment after the page exists.
    const bridged = await (async () => {
        const end = Date.now() + 60_000;
        while (Date.now() < end) {
            const ok = await cdp.evaluate('typeof window.genie === "object" && typeof window.genie.updater === "object"').catch(() => false);
            if (ok) return true;
            await new Promise((r) => setTimeout(r, 500));
        }
        return false;
    })();
    check(bridged, '1. v1\'s bridge is present (window.genie.updater)');

    const mode = await cdp.evaluate('window.genie.updater.mode()');
    check(mode === 'phase2', '2. the installed v1 runs its electron-updater backend (packaged → phase2)', String(mode));

    const before = await status(cdp);
    check(typeof before.currentVersion === 'string', '3. v1 reports the version it is', `currentVersion ${before.currentVersion}`);
    const from = before.currentVersion;

    await cdp.evaluate('window.genie.updater.check()');
    const found = await until(cdp, (s) => s.latestVersion === EXPECT || s.error, 60_000, 'the check to find the feed');
    check(found.latestVersion === EXPECT, `4. v1's check finds the Genie 2 build on the feed  — expected ${EXPECT}`, `latestVersion ${found.latestVersion}, state ${found.state}${found.error ? `, error ${found.error}` : ''}`);
    check(!found.error, '5. and reports no error', found.error ?? '');

    // Nothing downloads on its own in v1 either (its autoDownload is off) — a control that the
    // apply below is what moves it.
    await new Promise((r) => setTimeout(r, 1500));
    const still = await status(cdp);
    check(still.state !== 'downloading' && still.state !== 'ready-to-restart', '6. CONTROL: nothing downloads without the click', still.state);
    await cdp.screenshot(`${process.cwd()}/upgrade-from-${from}-available.png`).catch(() => {});

    // THE CLICK — v1's hands-free Update: download → install → restart.
    const applied = await cdp.evaluate('window.genie.updater.apply()').catch((e) => ({ ok: false, error: String(e) }));
    check(applied && applied.ok !== false, '7. apply() was accepted by v1', JSON.stringify(applied));

    // v1 quits to install; the socket drops. Watch the status move while we still can.
    let last = null;
    try {
        last = await until(cdp, (s) => s.state === 'downloading' || s.state === 'ready-to-restart' || s.state === 'restarting' || (typeof s.progress === 'number' && s.progress > 0), 60_000, 'the download to start');
        check(true, '8. v1 is downloading / staging the Genie 2 build', `state ${last.state}, progress ${last.progress}`);
        await until(cdp, (s) => s.state === 'ready-to-restart' || s.state === 'restarting', 180_000, 'the download to land');
        check(true, '9. the build landed in v1 (ready to restart)');
    } catch (e) {
        if (String(e).includes('socket') || String(e).includes('CDP')) console.log('  (socket closed — v1 is quitting to install)');
        else throw e;
    }
} catch (error) {
    if (failures.length === 0 && (String(error).includes('socket') || String(error).includes('CDP'))) console.log('  (socket closed — v1 is quitting to install)');
    else check(false, 'the upgrade path threw', String(error));
} finally {
    try { cdp.close(); } catch { /* already gone */ }
}

if (failures.length) { console.log(`\nUPGRADE PATH FAILED — ${failures.length} check(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`); process.exit(1); }
console.log('\nUPGRADE PATH DRIVEN — v1 is applying Genie 2; verify what is installed and running next.');
process.exit(0);
