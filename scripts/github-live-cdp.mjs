#!/usr/bin/env node
/**
 * WHAT NEEDS A LIVE GITHUB SIGN-IN (plan §13, A1-A5 and S12): one person, once, about two minutes. On omarchy-test, with tynn.ai aliased to tynn.gen. Refuses anywhere else.
 *
 *   bash vm-tynn-alias-linux.sh <dir>            # the alias: nothing here may reach production Tynn
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/github-live-cdp.mjs sign-in     # A1 and A2. Prints the code; a person types it at github.com/login/device. Then SNAPSHOT THE VM: restoring `base` wipes the keychain.
 *   GITHUB_CLONE_URL=https://github.com/<owner>/<private-repo>.git GITHUB_PUSH_URL=https://github.com/<owner>/<empty-repo>.git node scripts/github-live-cdp.mjs run
 *
 * `run` works from the snapshot, and needs nobody:
 * - A2: still signed in after a restart, with real token shapes.
 * - A3 and S12: a real clone, submodule add and push, through the window's own calls. While they run every process is read from /proc: the window and everything under it must carry no token, and
 *   the host's git must, which is the control that the reading can see one. Nothing else under the host may.
 * - A4: if the App issues expiring tokens, the recorded expiry is moved into the past, and the next launch must rotate both in the keychain. If not, it says so.
 * - A5: signing out clears both entries, and GitHub still answers the old token: it revokes nothing.
 *
 * GITHUB_PUSH_URL must be an EMPTY repository: the build pushes `main`, and an existing `main` refuses it. So A3's push proves once per empty repository, and `run` says so rather than failing on it.
 * A5 ends the sign-in, so rerunning `run` means restoring the snapshot.
 *
 * Prints `### github-live <check>=PASS|FAIL  detail`, then `### github-live=PASS|FAIL`. Capped at 25 min. No token, code excepted, is ever printed: the device code is what the person types and it is
 * not a credential by itself.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const MODE = process.argv[2];
if (MODE !== 'sign-in' && MODE !== 'run') { console.error('usage: github-live-cdp.mjs sign-in|run'); process.exit(2); }
if (userInfo().username !== "genie") { console.error('refusing: test machines only'); process.exit(2); }
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;

const PORT = Number(process.env.CDP_PORT ?? 9222);
const home = join(homedir(), '.genie');
const runtime = join(home, 'runtime');
const require = createRequire(`${process.cwd()}/`);
const work = mkdtempSync(join(tmpdir(), 'github-live-'));
const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, name, detail = '') => { console.log(`### github-live ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`); if (!ok) failures.push(name); };
const until = async (what, ms, read) => {
    const end = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > end) { say(`gave up waiting for ${what} after ${ms / 1000} s`); return null; }
        await sleep(500);
    }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const hostPid = () => { try { return json(join(runtime, 'host.json')).pid; } catch { return null; } };

const { AsyncEntry } = require('@napi-rs/keyring');
const PIN = { linux: { store: 'secret-service' } };
const held = async (name) => { try { return (await new AsyncEntry('Genie', name, PIN).getPassword()) ?? null; } catch { return null; } };
const ACCESS = 'github/access';
const REFRESH = 'github/refresh';
const githubFile = join(home, 'github.json');

let window = null;
async function stopApp() {
    const host = hostPid();
    for (const pid of [window?.pid, host]) { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(2000);
    for (const pid of [window?.pid, host]) { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    window = null;
    await sleep(500);
}
async function finish() {
    await stopApp();
    try { rmSync(work, { recursive: true, force: true }); } catch { /* gone */ }
    console.log(`### github-live=${failures.length === 0 ? 'PASS' : 'FAIL'}${failures.length ? `  failed: ${failures.join(', ')}` : ''}`);
    process.exit(failures.length === 0 ? 0 : 1);
}
setTimeout(() => { check(false, 'the-25-min-cap'); void finish(); }, 1_500_000).unref();

class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (r) { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => { c.#ws.addEventListener('open', res, { once: true }); c.#ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true }); });
        return c;
    }
    async evaluate(expression) {
        const id = this.#id++;
        const f = await new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
        if (f.result?.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result?.result?.value;
    }
    close() { try { this.#ws.close(); } catch { /* gone */ } }
}
async function launch() {
    const env = { ...process.env, XDG_SESSION_TYPE: 'x11', DISPLAY: process.env.DISPLAY ?? ':0' };
    delete env.ELECTRON_RUN_AS_NODE;
    window = spawn(require('electron'), ['.', '--no-sandbox', '--ozone-platform=x11', `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
    const page = await until('a window on the debugger port', 90_000, async () => {
        try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null; } catch { return null; }
    });
    if (!page) throw new Error('no window on the debugger port');
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await until('window.genie', 30_000, () => cdp.evaluate('typeof window.genie === "object"'));
    return cdp;
}
const githubView = (cdp) => cdp.evaluate('window.genie.features.snapshot().then((d) => d?.integrations?.github ?? null)');
// Installations too: with none read yet the clone goes without the sign-in (core/github.ts cloneAuthFor), and this would read as no token.
const signedInAs = (cdp) => until('the GitHub sign-in and its installations', 60_000, async () => { const g = await githubView(cdp); return g?.status === 'signed-in' && g.installations !== null ? g : null; });

/** Whose descendant each process is, read from /proc. A process that ends mid-read is skipped. */
function processes() {
    const rows = new Map();
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const stat = readFileSync(`/proc/${name}/stat`, 'latin1');
            const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            rows.set(Number(name), { pid: Number(name), ppid: Number(after[1]), comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) });
        } catch { /* gone */ }
    }
    return rows;
}
const underRoot = (rows, pid, root) => { for (let at = pid, n = 0; at && n < 64; at = rows.get(at)?.ppid, n += 1) if (at === root) return true; return false; };
const carries = (pid, needles) => {
    for (const file of ['environ', 'cmdline']) {
        try {
            const text = readFileSync(`/proc/${pid}/${file}`, 'latin1');
            if (needles.some((needle) => text.includes(needle))) return file;
        } catch { /* gone, or not ours */ }
    }
    return null;
};

/** While `work` runs, every process under the window and under the host, read over and over. */
async function watching(needles, windowPid, host, during) {
    const seen = { windowProcesses: new Set(), windowGit: new Set(), windowCarrying: [], hostGit: new Set(), hostGitCarrying: new Set(), hostOtherCarrying: [] };
    let running = true;
    const sampler = (async () => {
        while (running) {
            const rows = processes();
            for (const row of rows.values()) {
                if (underRoot(rows, row.pid, windowPid)) {
                    seen.windowProcesses.add(row.pid);
                    if (row.comm.startsWith('git')) seen.windowGit.add(row.pid);
                    const hit = carries(row.pid, needles);
                    if (hit) seen.windowCarrying.push(`${row.comm} ${row.pid} ${hit}`);
                } else if (underRoot(rows, row.pid, host)) {
                    const hit = carries(row.pid, needles);
                    if (row.comm.startsWith('git')) { seen.hostGit.add(row.pid); if (hit) seen.hostGitCarrying.add(row.pid); } else if (hit) seen.hostOtherCarrying.push(`${row.comm} ${row.pid} ${hit}`);
                }
            }
            await sleep(15);
        }
    })();
    try { return { result: await during(), seen }; } finally { running = false; await sampler; }
}

const gitWith = (token, ...args) => execFileSync('git', args, {
    encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` },
});
const githubAnswers = async (token) => (await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'genie-acceptance' } })).status;

async function signIn() {
    const cdp = await launch();
    await cdp.evaluate(`window.genie.features.act({ kind: 'integrations.githubSignIn' }).then(() => true)`);
    const device = await until('a device code', 60_000, async () => (await githubView(cdp))?.device ?? null);
    if (!device) throw new Error(`no device code: ${JSON.stringify(await githubView(cdp))}`);
    console.log(`### github-live CODE ${device.userCode} at ${device.verificationUri}  (type it there and approve; this waits 15 minutes)`);
    const signed = await until('the person to approve', 900_000, async () => { const g = await githubView(cdp); return g?.status === 'signed-in' ? g : null; });
    check(Boolean(signed), 'A1-signed-in', signed ? String(signed.user?.login ?? '') : JSON.stringify(await githubView(cdp)));
    cdp.close();
    await stopApp();
    await a2();
    say('now snapshot this VM: everything after this works from it');
}

async function a2() {
    const access = await held(ACCESS);
    const refresh = await held(REFRESH);
    check(/^(ghu|gho)_/.test(access ?? ''), 'A2.1-the-keychain-holds-a-real-access-token', access ? `${access.slice(0, 4)}…, ${access.length} characters` : 'none');
    check(refresh === null || /^ghr_/.test(refresh), 'A2.2-and-a-refresh-token-if-the-app-issues-them', refresh ? `${refresh.slice(0, 4)}…, ${refresh.length} characters` : 'none: this App issues non-expiring tokens');
    const row = existsSync(githubFile) ? readFileSync(githubFile, 'utf8') : '';
    check(row !== '' && !row.includes(access ?? 'no token') && !/tokenEnc|refreshEnc/.test(row), 'A2.3-no-token-in-the-file');
    const cdp = await launch();
    const again = await signedInAs(cdp);
    check(Boolean(again), 'A2.4-it-survives-a-restart');
    cdp.close();
    await stopApp();
}

async function run() {
    const cloneUrl = process.env.GITHUB_CLONE_URL;
    const pushUrl = process.env.GITHUB_PUSH_URL;
    if (!cloneUrl || !pushUrl) throw new Error('GITHUB_CLONE_URL and GITHUB_PUSH_URL are required');
    await a2();
    const token = await held(ACCESS);
    if (!token) throw new Error('nothing in the keychain: restore the snapshot taken after sign-in');
    const needles = [token, Buffer.from(`x-access-token:${token}`).toString('base64')];

    say('A3 and S12: a real clone, submodule add and push, with every process read while they run');
    let cdp = await launch();
    await signedInAs(cdp);
    const emptyBefore = gitWith(token, 'ls-remote', pushUrl).trim() === '';
    check(emptyBefore, 'A3.0-the-push-repository-is-empty', emptyBefore ? '' : 'an existing main refuses the push: give an empty repository');
    const parent = join(work, 'made');
    execFileSync('mkdir', ['-p', parent]);
    const name = `live-${Date.now().toString(36)}`;
    const host = hostPid();
    const plan = { name, parent, source: join(work, 'nothing-brought-in'), staged: false, repos: [{ name: 'code', url: cloneUrl, local: false }], knowledge: [], primary: 'code' };
    // The clone Add workspace's import stages is thrown away; the submodule add below is what stays.
    const { result, seen } = await watching(needles, window.pid, host, async () => {
        const staged = await cdp.evaluate(`window.genie.workspaces.stageFromGit(${JSON.stringify(cloneUrl)})`);
        const built = await cdp.evaluate(`window.genie.workspaces.buildEnvelope(${JSON.stringify(plan)}, ${JSON.stringify({ kind: 'paste', url: pushUrl })})`);
        if (staged?.ok && staged.existing === false) await cdp.evaluate(`window.genie.workspaces.discardStaged(${JSON.stringify(staged.analysis?.root ?? "")})`).catch(() => {});
        return { staged, built };
    });
    check(result.staged?.ok === true, 'A3.1-the-clone', JSON.stringify(result.staged?.reason ?? 'cloned'));
    check(result.built?.ok === true, 'A3.2-the-submodule-add', String(result.built?.reason ?? result.built?.path ?? ''));
    const problems = result.built?.published?.problems ?? [];
    check(Boolean(result.built?.published) && problems.length === 0, 'A3.3-the-push', problems.map((p) => `${p.step}: ${p.message}`).join('; ') || 'no step failed');
    const head = result.built?.path ? execFileSync('git', ['-C', result.built.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() : 'none';
    const remote = gitWith(token, 'ls-remote', pushUrl, 'refs/heads/main').trim().split(/\s+/)[0] ?? '';
    check(remote !== '' && remote === head, 'A3.4-github-has-what-was-built', `${head.slice(0, 8)} ${remote.slice(0, 8)}`);
    const config = result.built?.path ? readFileSync(join(result.built.path, '.git', 'config'), 'utf8') : '';
    check(config !== '' && !needles.some((n) => config.includes(n)), 'A3.5-no-token-in-the-clones-config');

    check(seen.hostGitCarrying.size > 0, 'S12.0-CONTROL-the-reading-can-see-it-on-the-hosts-git', `${seen.hostGitCarrying.size} of ${seen.hostGit.size} git processes under the host carried it`);
    check(seen.windowProcesses.size > 0 && seen.windowCarrying.length === 0, 'S12.1-nothing-under-the-window-carries-a-token', seen.windowCarrying.slice(0, 5).join(', ') || `${seen.windowProcesses.size} processes read, ${seen.windowGit.size} of them git`);
    check(seen.hostOtherCarrying.length === 0, 'S12.2-under-the-host-only-git-carries-it', seen.hostOtherCarrying.slice(0, 5).join(', ') || 'none');
    check(!carries(window.pid, needles) && !carries(host, needles), 'S12.3-the-window-and-the-host-themselves-carry-none');
    cdp.close();
    await stopApp();

    say('A4: a real renewal, if this App issues expiring tokens');
    const row = json(githubFile);
    const oldRefresh = await held(REFRESH);
    if (typeof row.accessExpiresAt === 'number' && oldRefresh) {
        writeFileSync(githubFile, JSON.stringify({ ...row, accessExpiresAt: Date.now() - 60_000 }, null, 2), { mode: 0o600 });
        cdp = await launch();
        const renewed = await until('the tokens to rotate', 90_000, async () => { const now = await held(ACCESS); return now && now !== token ? now : null; });
        check(Boolean(renewed), 'A4.1-the-access-token-rotated-in-the-keychain');
        const newRefresh = await held(REFRESH);
        check(Boolean(newRefresh) && newRefresh !== oldRefresh, 'A4.2-and-the-refresh-token');
        check(renewed ? (await githubAnswers(renewed)) === 200 : false, 'A4.3-github-answers-the-new-one');
        cdp.close();
        await stopApp();
    } else {
        say('A4 does not apply: this App issued non-expiring tokens, so there is nothing to renew');
    }

    say('A5: sign out');
    const finalToken = await held(ACCESS);
    cdp = await launch();
    await signedInAs(cdp);
    await cdp.evaluate(`window.genie.features.act({ kind: 'integrations.githubSignOut' }).then(() => true)`);
    const out = await until('the sign-out to reach the file', 30_000, () => { try { return json(githubFile).state === 'signed-out'; } catch { return false; } });
    check(Boolean(out), 'A5.1-signed-out-is-on-disk');
    check((await held(ACCESS)) === null && (await held(REFRESH)) === null, 'A5.2-both-entries-are-gone');
    const answered = finalToken ? await githubAnswers(finalToken) : 0;
    check(answered === 200, 'A5.3-it-revoked-nothing-on-github', `GitHub answered ${answered} to the old token`);
    cdp.close();
}

try {
    say('the alias: tynn.ai must be tynn.gen on this machine');
    const resolved = execFileSync('getent', ['hosts', 'tynn.ai'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    if (resolved !== '127.0.0.1' && resolved !== '::1') throw new Error(`tynn.ai resolves to ${resolved}: the alias is not up, and this would reach production`);
    check(true, '0-tynn-ai-is-the-alias', resolved);
    if (MODE === 'sign-in') await signIn(); else await run();
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
