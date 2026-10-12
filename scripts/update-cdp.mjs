#!/usr/bin/env node
/**
 * DRIVE AN UPDATE THROUGH THE REAL APP — check → download → install, over CDP, via the same
 * `window.genie.updates` the Deck's signal strip uses.
 *
 *   EXPECT_VERSION=0.0.1 node scripts/update-cdp.mjs
 *
 * Runs against an INSTALLED app launched with `--remote-debugging-port=9222`, whose
 * `resources/app-update.yml` points at `serve-feed.mjs`. Every claim is checked against the
 * state the main process reports, and the Deck is visited so the signal strip's rendering of
 * each phase is seen in a real window, not only its model in a unit test.
 *
 * The last step quits the app to apply the update, so the socket dropping at the end is the
 * expected outcome; what happens after is the caller's to verify (the installed version).
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
    const until = Date.now() + 60_000;
    let last = 'no attempt';
    while (Date.now() < until) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
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

const state = (cdp) => cdp.evaluate('window.genie.updates.state()');
const until = async (cdp, pred, ms, what) => {
    const end = Date.now() + ms;
    let s = await state(cdp);
    while (!pred(s) && Date.now() < end) { await new Promise((r) => setTimeout(r, 300)); s = await state(cdp); }
    if (!pred(s)) throw new Error(`timed out waiting for ${what}; last state ${JSON.stringify(s)}`);
    return s;
};

console.log('\nTHE UPDATE PATH — check, download, install, through the installed app\n');
const page = await findTarget();
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
try {
    await cdp.evaluate('document.readyState');

    const idle = await state(cdp);
    check(idle.phase === 'idle' && idle.version === null, '1. the updater starts idle, claiming nothing', JSON.stringify(idle));

    // AUTO_CHECK=1 (genie2#91): nobody calls check() — the installed app must find the feed BY ITSELF,
    // within the boot delay plus a margin. Otherwise the driver asks, as before.
    const auto = process.env.AUTO_CHECK === '1';
    const checked = auto
        ? await until(cdp, (s) => s.phase === 'available' || s.phase === 'none' || s.phase === 'error', 60_000, 'the app to check the feed on its own')
        : await cdp.evaluate('window.genie.updates.check()');
    check(checked.phase === 'available', auto ? '2. the app checked the feed ON ITS OWN and found the update' : '2. a check finds the feed\'s update', `phase ${checked.phase}${checked.error ? ` error ${checked.error}` : ''}`);
    check(checked.version === EXPECT, `3. the offered version is the one the feed serves  — expected ${EXPECT}`, String(checked.version));
    check(typeof checked.checkedAt === 'number', '4. the check is timestamped', String(checked.checkedAt));

    // Nothing downloads by itself: the state must still be `available` after a pause.
    await new Promise((r) => setTimeout(r, 1500));
    const still = await state(cdp);
    check(still.phase === 'available', '5. CONTROL: nothing downloads without being asked', still.phase);

    await cdp.evaluate('location.hash = "#genie://deck"; true');
    await new Promise((r) => setTimeout(r, 400));
    const shown = await cdp.evaluate('(() => { const b = document.querySelector("[data-signal=update]"); return b ? { text: b.textContent, action: b.dataset.action } : null; })()');
    check(shown !== null && shown.action === 'update-download', '6. the Deck shows the update as a signal whose door is download', JSON.stringify(shown));
    check(shown !== null && shown.text.includes(EXPECT), '7. the signal names the version', shown?.text ?? '');
    await cdp.screenshot(`${process.cwd()}/update-available.png`);
    if (auto) {
        console.log(failures.length === 0 ? '\nAUTO-CHECK PROVEN — the installed app found the update on the feed without being asked, offered it, and downloaded nothing.' : `\nAUTO-CHECK FAILED — ${failures.length}: ${failures.join(' | ')}`);
        process.exit(failures.length === 0 ? 0 : 1);
    }

    // Click the door rather than call the bridge: this is the path a person takes.
    await cdp.evaluate('document.querySelector("[data-signal=update]").click(); true');
    const downloading = await until(cdp, (s) => s.phase === 'downloading' || s.phase === 'downloaded', 10_000, 'download to start');
    check(downloading.phase === 'downloading' || downloading.phase === 'downloaded', '8. clicking the signal starts the download', downloading.phase);

    const downloaded = await until(cdp, (s) => s.phase === 'downloaded' || s.phase === 'error', 120_000, 'download to finish');
    check(downloaded.phase === 'downloaded', '9. the download lands', `phase ${downloaded.phase}${downloaded.error ? ` error ${downloaded.error}` : ''}`);
    check(downloaded.percent === 100, '10. progress reached 100', String(downloaded.percent));

    await new Promise((r) => setTimeout(r, 400));
    const ready = await cdp.evaluate('(() => { const b = document.querySelector("[data-signal=update]"); return b ? { text: b.textContent, action: b.dataset.action } : null; })()');
    check(ready !== null && ready.action === 'update-install', '11. the signal now offers install', JSON.stringify(ready));
    await cdp.screenshot(`${process.cwd()}/update-downloaded.png`);

    // §7.4 — "an upgrade ends every agent session and does not revive them" — is only a claim
    // if an agent is RUNNING when install is asked. Start the seeded codex agent (the stub
    // app-server behind GENIE2_CODEX_BINARY) through the same door a person uses, and wait for
    // the host to report its session running. The caller proves the other half afterwards:
    // no stub process survives the quit, and none is back after the relaunch.
    const codexId = await cdp.evaluate('window.genie.snapshot().then((s) => (s.agents.find((a) => a.provider === "codex") ?? {}).id ?? null)');
    check(typeof codexId === 'string', '11b. the seed left a codex agent to run', String(codexId));
    if (typeof codexId === 'string') {
        await cdp.evaluate(`window.genie.openAgent(${JSON.stringify(codexId)}); true`);
        const end = Date.now() + 30_000;
        let running = null;
        while (Date.now() < end) {
            running = await cdp.evaluate(`window.genie.agentDetail(${JSON.stringify(codexId)}).then((d) => d?.session?.running ?? null)`);
            if (running === true) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        check(running === true, '11c. that agent\'s session is RUNNING when install is asked', String(running));
    }

    // §7.2's POSITIVE CONTROL (Fancy, 2026-10-10): with fancy-pty every live terminal is one
    // helper process under the install dir, so N live terminals must show N helpers to the same
    // process scan the teardown uses — a scan that has only ever observed nothing is not a
    // scan. One terminal is opened here and LEFT OPEN through install(); the helper is our own
    // child (excluded from the orphan kill by descent) and before-quit closes it. The caller
    // asserts 0 helpers after the relaunch.
    const wsId = await cdp.evaluate('window.genie.snapshot().then((s) => s.workspaces?.[0]?.id ?? null)');
    if (typeof wsId === 'string') {
        const term = await cdp.evaluate(`window.genie.terminals.open(${JSON.stringify(wsId)}, { cols: 80, rows: 24 })`);
        check(term && term.pid > 0, '11d. a Workspace terminal is open when install is asked', `pid ${term?.pid}`);
        await new Promise((r) => setTimeout(r, 1500));
        const { execFileSync } = await import('node:child_process');
        const helpers = execFileSync('powershell', ['-NoProfile', '-Command',
            // @(...) on purpose: in Windows PowerShell 5.1, (pipeline).Count on exactly ONE CimInstance
            // result is $null (the PSObject intrinsic-member bug) — the first run read "0 helper(s)"
            // while the dump showed the helper, pid 4700, right there. Zero and two counted fine.
            "@(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'fancy-pty-helper*' -and $_.ExecutablePath -like \"$env:LOCALAPPDATA\\Programs\\Genie\\*\" }).Count"],
            { encoding: 'utf8', timeout: 30_000 }).trim();
        const n = Number(helpers || 0);
        if (n === 0 && !process.env.EXPECT_HELPERS) console.log('  (no fancy-pty helper under the install dir — node-pty engine, or the helper is elsewhere; set EXPECT_HELPERS=1 to assert)');
        else check(n === 1, '11e. CONTROL: that terminal is exactly ONE fancy-pty-helper under the install dir — the §7.2 scan has something to find', `${n} helper(s)`);
        if (process.env.EXPECT_HELPERS && n !== 1) {
            // Say what IS there, so a failed control is a measurement and not a shrug: every
            // process that names fancy-pty anywhere, and everything running from the install dir
            // that is not Genie.exe itself (pid, parent, path, first 160 chars of the command line).
            const dump = execFileSync('powershell', ['-NoProfile', '-Command',
                "Get-CimInstance Win32_Process | Where-Object { ($_.Name -like '*fancy*') -or ($_.CommandLine -like '*fancy-pty*') -or ($_.ExecutablePath -like \"$env:LOCALAPPDATA\\Programs\\Genie\\*\" -and $_.Name -ne 'Genie.exe') } | ForEach-Object { \"$($_.ProcessId) ppid=$($_.ParentProcessId) $($_.Name) path=$($_.ExecutablePath) cmd=$(if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(160, $_.CommandLine.Length)) })\" }"],
                { encoding: 'utf8', timeout: 30_000 }).trim();
            console.log(`  --- processes naming fancy-pty, or under the install dir (not Genie.exe) ---\n${dump ? dump.split(/\r?\n/).map((l) => `  ${l}`).join('\n') : '  (none)'}`);
            const term = await cdp.evaluate(`window.genie.terminals.list(${JSON.stringify(wsId)})`).catch(() => null);
            console.log(`  --- terminals the host lists for the workspace ---\n  ${JSON.stringify(term)}`);
        }
    }

    // §7.2 report, through the bridge this time so the caller gets the text.
    const result = await cdp.evaluate('window.genie.updates.install()');
    check(result !== null && typeof result.report === 'string', '12. install answers with the teardown report', result?.report?.split('\n')[0] ?? 'null');
    console.log(`\n--- §7.2 report ---\n${result?.report ?? '(none)'}\n`);
} catch (error) {
    // The socket dropping after step 12 is the app quitting to install — expected. Anything
    // before that is a failure.
    if (failures.length === 0 && String(error).includes('socket')) console.log('  (socket closed — the app is quitting to install)');
    else { check(false, 'the update path threw', String(error)); }
} finally {
    try { cdp.close(); } catch { /* already gone */ }
}

if (failures.length) { console.log(`\nUPDATE PATH FAILED — ${failures.length} check(s):\n${failures.map((f) => `  - ${f}`).join('\n')}`); process.exit(1); }
console.log('\nUPDATE PATH DRIVEN — the app is applying the update; verify the installed version next.');
process.exit(0);
