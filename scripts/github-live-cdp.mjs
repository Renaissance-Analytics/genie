#!/usr/bin/env node
/**
 * WHAT NEEDS A LIVE GITHUB SIGN-IN (plan §13, A1-A5 and S12): one person, once, about two minutes. On omarchy-test, with tynn.ai aliased to tynn.gen. Refuses anywhere else.
 *
 *   bash vm-tynn-alias-linux.sh <dir>            # the alias: nothing here may reach production Tynn
 *   npm ci && node node_modules/electron/install.js && npm run build
 *   node scripts/github-live-cdp.mjs sign-in     # A1 and A2. Prints the code; a person types it at github.com/login/device. Then SNAPSHOT THE VM: restoring `base` wipes the keychain.
 *   GITHUB_CLONE_URL=https://github.com/<owner>/<private-repo>.git GITHUB_PUSH_URL=https://github.com/<owner>/<empty-repo>.git node scripts/github-live-cdp.mjs run
 *   ... node scripts/github-live-cdp.mjs install-check     # only what the App's installation can see: `### github-live install=READY`, or NEEDS-THE-OWNER and what to do
 *
 * Both URLs are needed for sign-in too: straight after it, the installation is read and `### github-live install=` printed. Nothing is touched but those two repositories. Reading the installation asks GitHub for the list only.
 *
 * `run` works from the snapshot, and needs nobody. GITHUB_STEPS picks from a2,a3,a4,a5 (all, by default). A4 uses up the snapshot's refresh token and A5 ends the sign-in, so after either the snapshot's tokens may no longer work:
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
import { secretNote } from './secret-note.mjs';
// The feature snapshot is read on the page's own bridge now (P4 family 11): window.genieTest needs this.
process.env.GENIE_PAGE_PROBE ??= '1';

const MODE = process.argv[2];
if (MODE !== 'sign-in' && MODE !== 'run' && MODE !== 'install-check') { console.error('usage: github-live-cdp.mjs sign-in|run|install-check'); process.exit(2); }
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
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
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
const githubView = (cdp) => cdp.evaluate('(window.genieTest ?? window.genie).features.snapshot().then((d) => d?.integrations?.github ?? null)');
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

const INSTALL_URL = 'https://github.com/apps/genie-aos/installations/new';
const repoOf = (url) => {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url ?? '');
    if (!m) throw new Error('GITHUB_CLONE_URL and GITHUB_PUSH_URL must each be https://github.com/<owner>/<repo>.git');
    return { owner: m[1], name: m[2] };
};
/** What the App can see, from the token's own answer. Prints only ids, names and counts. True when both repositories are in a selected installation. */
async function installState(token) {
    const wanted = [repoOf(process.env.GITHUB_CLONE_URL), repoOf(process.env.GITHUB_PUSH_URL)];
    const owner = wanted[0].owner;
    const needs = (what) => { console.log(`### github-live install=NEEDS-THE-OWNER  ${what}`); return false; };
    const get = async (path) => {
        const r = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'genie-acceptance' } });
        return { status: r.status, body: r.status === 200 ? await r.json() : null };
    };
    const list = await get('/user/installations?per_page=100');
    if (list.status !== 200) return needs(`GitHub answered ${list.status} to /user/installations`);
    const rows = list.body.installations ?? [];
    for (const row of rows) say(`installation id=${row.id} account=${row.account?.login} selection=${row.repository_selection}`);
    if (rows.length === 0) say('no installation of this App is visible to this account');
    const mine = rows.find((row) => row.account?.login === owner);
    if (!mine) return needs(`the App is not installed on ${owner}: at ${INSTALL_URL} choose ${owner}, then "Only select repositories", then ${wanted.map((w) => w.name).join(' and ')}`);
    console.log(`### github-live install-id=${mine.id}`);
    if (mine.repository_selection !== 'selected') return needs(`the App can see every repository on ${owner}: at https://github.com/settings/installations/${mine.id} choose "Only select repositories", then ${wanted.map((w) => w.name).join(' and ')}`);
    const seen = new Map();
    for (let page = 1; page <= 20; page += 1) {
        const r = await get(`/user/installations/${mine.id}/repositories?per_page=100&page=${page}`);
        if (r.status !== 200) return needs(`GitHub answered ${r.status} listing installation ${mine.id}`);
        for (const repo of r.body.repositories ?? []) seen.set(repo.full_name, repo.id);
        if ((r.body.repositories ?? []).length < 100) break;
    }
    let missing = [];
    for (const w of wanted) {
        const id = seen.get(`${w.owner}/${w.name}`);
        say(`repository ${w.name}: ${id ? `the App can see it, id ${id}` : 'the App cannot see it'}`);
        if (!id) missing.push(w.name);
    }
    say(`and ${seen.size - (wanted.length - missing.length)} other repositories in that installation (not named, not touched)`);
    if (missing.length > 0) return needs(`add ${missing.join(' and ')} to installation ${mine.id}: https://github.com/settings/installations/${mine.id}`);
    console.log('### github-live install=READY');
    return true;
}

async function installCheck() {
    const cdp = await launch();
    const signed = await signedInAs(cdp);
    check(Boolean(signed), 'still-signed-in');
    const token = await held(ACCESS);
    cdp.close();
    await stopApp();
    if (!token) throw new Error('nothing in the keychain: restore the snapshot taken after sign-in');
    await installState(token);
}

async function signIn() {
    repoOf(process.env.GITHUB_CLONE_URL);
    repoOf(process.env.GITHUB_PUSH_URL);
    const cdp = await launch();
    await cdp.evaluate(`window.genie.features.act({ kind: 'integrations.githubSignIn' }).then(() => true)`);
    const device = await until('a device code', 60_000, async () => (await githubView(cdp))?.device ?? null);
    if (!device) throw new Error(`no device code: ${JSON.stringify(await githubView(cdp))}`);
    const lasts = Math.max(0, Math.round((device.expiresAt - Date.now()) / 1000));
    console.log(`### github-live CODE ${device.userCode} at ${device.verificationUri} lasts ${lasts} s, until ${new Date(device.expiresAt).toISOString()}`);
    // Watched for as long as GitHub says the code lasts, and a little longer. A flow that ended early says why, in Genie's words.
    let ended = null;
    const signed = await until('the person to approve', device.expiresAt - Date.now() + 30_000, async () => {
        const g = await githubView(cdp);
        if (g?.status === 'signed-in') return g;
        if (!g?.device) { ended = g; return g ?? {}; }
        return null;
    });
    if (signed?.status !== 'signed-in') {
        const words = ended ? `the sign-in ended: ${String(ended.message ?? ended.status ?? 'no words')}` : `nobody approved the code in its ${lasts} s`;
        check(false, 'A1-signed-in', `${words}. Nothing is saved; run sign-in again for a new code`);
        cdp.close();
        return;
    }
    check(true, 'A1-signed-in', String(signed.user?.login ?? ''));
    cdp.close();
    await stopApp();
    await a2();
    const token = await held(ACCESS);
    if (token) await installState(token);
    say('now snapshot this VM: everything after this works from it');
}

async function a2() {
    const access = await held(ACCESS);
    const refresh = await held(REFRESH);
    check(/^(ghu|gho)_/.test(access ?? ''), 'A2.1-the-keychain-holds-a-real-access-token', secretNote(access));
    check(refresh === null || /^ghr_/.test(refresh), 'A2.2-and-a-refresh-token-if-the-app-issues-them', refresh ? secretNote(refresh) : 'none: this App issues non-expiring tokens');
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
    repoOf(cloneUrl);
    repoOf(pushUrl);
    const steps = new Set((process.env.GITHUB_STEPS ?? 'a2,a3,a4,a5').split(',').map((step) => step.trim()));
    for (const step of steps) if (!['a2', 'a3', 'a4', 'a5'].includes(step)) throw new Error(`no step ${step}: a2, a3, a4 or a5`);
    if (steps.has('a2')) await a2();
    if (steps.has('a3')) await a3(cloneUrl, pushUrl);
    if (steps.has('a4')) await a4();
    if (steps.has('a5')) await a5();
}

async function a3(cloneUrl, pushUrl) {
    say('A3 and S12: a real clone, submodule add and push, with every process read while they run');
    const cdp = await launch();
    await signedInAs(cdp);
    const token = await held(ACCESS);
    if (!token) throw new Error('nothing in the keychain: restore the snapshot taken after sign-in');
    if (!(await installState(token))) throw new Error('the App cannot see both repositories, so nothing was cloned or pushed');
    const needles = [token, Buffer.from(`x-access-token:${token}`).toString('base64')];
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
}

async function a4() {
    say('A4: a real renewal, if this App issues expiring tokens');
    const row = json(githubFile);
    const token = await held(ACCESS);
    const oldRefresh = await held(REFRESH);
    if (typeof row.accessExpiresAt === 'number' && oldRefresh) {
        writeFileSync(githubFile, JSON.stringify({ ...row, accessExpiresAt: Date.now() - 60_000 }, null, 2), { mode: 0o600 });
        const cdp = await launch();
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
}

async function a5() {
    say('A5: sign out');
    const cdp = await launch();
    await signedInAs(cdp);
    const finalToken = await held(ACCESS);
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
    if (MODE === 'sign-in') await signIn(); else if (MODE === 'install-check') await installCheck(); else await run();
} catch (error) {
    check(false, 'the-check-threw', error instanceof Error ? error.message : String(error));
}
await finish();
