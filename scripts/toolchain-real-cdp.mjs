#!/usr/bin/env node
/**
 * THE TOOLCHAIN, AS A PERSON GETS IT (Tynn #967): the real app and its genie-host on an Omarchy machine the harness has
 * not touched, driven through Settings → Toolchain over CDP. No fake runner, no table assertion: every check reads what
 * the card shows (its version, its badge, its progress steps, its words) and what the machine then has (`pacman -Q`,
 * the command answering, `docker info` as the user).
 *
 *   bash scripts/ci/linux.sh --only toolchain     (the gate runs it as its own shard, on its own VM)
 *
 * Why it exists (#958): the old rows passed because linux.sh installs a missing command with `sudo pacman` and the image
 * gives genie NOPASSWD sudo, so nothing a person meets was ever exercised. Here:
 *   - It runs BEFORE any harness pacman (linux.sh's row refuses after one).
 *   - genie gets a REAL password, and sudo asks for it: the NOPASSWD drop-in is moved aside for the row, a
 *     password-required grant (`genie ALL=(ALL:ALL) ALL`, what a person has) is put in, and both are put back at the end.
 *   - Every elevated step is answered in the CLIENT, with that password, typed into the password field Genie shows. A
 *     wrong one first, which must ask again (#973). The password never appears in argv or in any file: a sampler reads
 *     every process's argv while the row runs, and ~/.genie and ci-out are read for it at the end.
 *   - pacman installs php, composer and git, and updates a git the harness holds one version back (#968). The sync is
 *     settled with no partial upgrade: `pacman -Dk` is clean and the new commands run.
 *   - Docker: the image's "installed, daemon inactive" state, then Start; then the real install path after the harness
 *     removes it; then a Genie service (redis) started on it (#970).
 *   - A Genie-managed language install and its default (Node), which work today and must keep working.
 *   - The keyring's Install (#973 on its own: its pacman table is its own): gnome-keyring removed, the button pressed here,
 *     Genie's prompt in this client naming it, a wrong password asking again, the right one installing it.
 *
 * OUTPUT: one `TRACK <check> PASS|RED|BLOCKED|FAIL <reason> <what a person sees>` line per check (linux.sh's
 * tracked_verdict reads them against TRACKED_RED[toolchain]). <reason> is what turns the check green: `pacman` (#968),
 * `elevation` (#973), `docker` (#970), or `none` for checks that must pass today. RED = measured red for that reason;
 * BLOCKED = could not be measured because an earlier step of the same flow was red; FAIL = broken for a reason nobody
 * tracks (the row then fails the gate). Exit 1 when any check is not PASS.
 *
 * Refuses anywhere but a test machine (user genie, or GENIE_TEST_MACHINE=1): it removes system packages and changes sudo.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { mainWindow } from './cdp-main-window.mjs';
import { archiveBase, heldBackOf, holdBackCheck, holdBackLog, holdGitBack, readListing, repoVersion } from './toolchain-hold-back.mjs';
import { closeWhatsNew } from './cdp-whats-new.mjs';

if (process.env.GENIE_TEST_MACHINE !== '1' && userInfo().username !== 'genie') {
    console.error('refusing: this removes system packages and changes sudo; test machines only');
    process.exit(2);
}
process.env.XDG_RUNTIME_DIR ??= `/run/user/${userInfo().uid}`;
process.env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;

const PORT = Number(process.env.CDP_PORT ?? 9337);
const CAP_MS = Number(process.env.TOOLCHAIN_CAP_MS ?? 2_400_000);
const USER = userInfo().username;
const NOPASSWD = '/etc/sudoers.d/10-genie-test';
const ASIDE = '/var/tmp/genie-967-10-genie-test';
const PERSON = '/etc/sudoers.d/20-genie-967-person';
const OUT = join(process.cwd(), 'ci-out');
const ELECTRON = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron');
// Letters and digits only: nothing a shell or a form could read twice. Never printed.
const PW = `G${randomBytes(18).toString('hex')}9z`;
const WRONG = `wrong-${randomBytes(6).toString('hex')}`;

const say = (line) => console.log(`--- ${line}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
/** One check's line. `verdict`: PASS | RED | BLOCKED | FAIL. Never prints the password: it is scrubbed. */
function track(check, verdict, reason, detail = '') {
    const words = String(detail).replaceAll(PW, '<password>').replace(/\s+/g, ' ').trim().slice(0, 400);
    console.log(`TRACK ${check} ${verdict} ${reason}${words ? ` ${words}` : ''}`);
    results.push({ check, verdict, reason });
}
const until = async (ms, read, every = 500) => {
    const end = Date.now() + ms;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > end) return null;
        await sleep(every);
    }
};
const run = (command, args, opts = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...opts });
const out = (command, ...args) => { const r = run(command, args, { timeout: 60_000 }); return r.status === 0 ? r.stdout.trim() : ''; };
const ok = (command, ...args) => run(command, args).status === 0;
/** sudo with no password: only while the image's NOPASSWD drop-in is still in place. */
const sudoN = (...args) => ok('sudo', '-n', ...args);
/** sudo as a person runs it: the password on stdin, never on argv. */
// ...and then FORGOTTEN (`sudo -k`): sudo caches a password for minutes, and a cached one would let `sudo -n`, or an
// elevated step of Genie's, through with no prompt. The 2026-11-20 run 2 read "sudo -n refused false" for exactly that.
const sudoP = (...args) => { const r = run('sudo', ['-S', '-p', '', ...args], { input: `${PW}\n` }); run('sudo', ['-k']); return r; };
const pkgVersion = (pkg) => { const v = out('pacman', '-Q', pkg).split(/\s+/)[1] ?? ''; return v.replace(/^\d+:/, '').replace(/-[^-]+$/, ''); };
const sessionPath = (() => { const env = out('systemctl', '--user', 'show-environment'); return env.split('\n').find((l) => l.startsWith('PATH='))?.slice(5) || process.env.PATH; })();
const answersInSession = (cmd, ...args) => run(cmd, args, { env: { ...process.env, PATH: sessionPath }, timeout: 60_000 });
const dockerAnswers = () => answersInSession('docker', 'info', '--format', '{{.ServerVersion}}').status === 0;
const NO_PM = /no package manager/i;
const NO_AGENT = /pkexec|authentication agent|polkit|not authori[sz]ed|exit(ed)? (code )?12[67]/i;

// --- the password never leaves stdin: every process's argv, sampled for the whole row ----------------------------------
const leaks = new Set();
const sampler = setInterval(() => {
    let pids = [];
    try { pids = readdirSync('/proc').filter((p) => /^\d+$/.test(p)); } catch { return; }
    for (const pid of pids) {
        try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(PW)) leaks.add(`argv of pid ${pid}`); } catch { /* gone, or not ours */ }
    }
}, 300);
sampler.unref();
function filesHolding(root, depth = 0, found = []) {
    if (depth > 8 || found.length > 5) return found;
    let names = [];
    try { names = readdirSync(root); } catch { return found; }
    for (const name of names) {
        const p = join(root, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) filesHolding(p, depth + 1, found);
        else if (st.isFile() && st.size < 50_000_000) { try { if (readFileSync(p).includes(PW)) found.push(p); } catch { /* unreadable */ } }
    }
    return found;
}

// --- CDP ------------------------------------------------------------------------------------------------------------
class Cdp {
    #ws; #id = 1; #pending = new Map();
    static async connect(url) {
        const c = new Cdp();
        c.#ws = new WebSocket(url);
        c.#ws.addEventListener('message', (ev) => { const f = JSON.parse(ev.data); const r = c.#pending.get(f.id); if (typeof r === 'function') { c.#pending.delete(f.id); r(f); } });
        await new Promise((res, rej) => { c.#ws.addEventListener('open', res, { once: true }); c.#ws.addEventListener('error', () => rej(new Error('CDP socket error')), { once: true }); });
        return c;
    }
    send(method, params = {}) {
        const id = this.#id++;
        return new Promise((r) => { this.#pending.set(id, r); this.#ws.send(JSON.stringify({ id, method, params })); });
    }
    async evaluate(expression) {
        const f = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (f.result?.exceptionDetails) throw new Error(`page threw: ${f.result.exceptionDetails.exception?.description ?? '?'}`);
        return f.result?.result?.value;
    }
}

let app = null;
let cdp = null;
let asideDone = false;
let personDone = false;
const hostPid = () => { try { return JSON.parse(readFileSync(join(homedir(), '.genie', 'runtime', 'host.json'), 'utf8')).pid; } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let finishing = false;
async function finish() {
    if (finishing) return;
    finishing = true;
    clearInterval(sampler);
    const host = hostPid();
    for (const pid of [app?.pid, host]) { if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } } }
    await sleep(1500);
    for (const pid of [app?.pid, host]) { if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
    // sudo as it was: the NOPASSWD drop-in back, the person's grant gone, and `sudo -n` answering again.
    // Both by password: while the person's grant is there it is the last match, so sudo asks.
    if (asideDone) sudoP('mv', '-f', ASIDE, NOPASSWD);
    if (personDone) sudoP('rm', '-f', PERSON);
    const restored = !(asideDone || personDone) || sudoN('true');
    if (!restored) track('z-sudo-restored', 'FAIL', 'none', `sudo -n does not answer after the restore (${NOPASSWD} back: ${asideDone}, ${PERSON} removed: ${personDone}); later jobs on this VM would ask for a password`);
    else if (asideDone || personDone) track('z-sudo-restored', 'PASS', 'none', 'sudo -n answers again, as the image had it');
    const files = filesHolding(join(homedir(), '.genie')).concat(filesHolding(OUT));
    if (leaks.size > 0 || files.length > 0) track('password-never-written', 'FAIL', 'none', `the password was found in: ${[...leaks, ...files].join(', ')}`);
    else track('password-never-written', 'PASS', 'none', 'not in any argv sampled during the row, nor in ~/.genie or ci-out');
    const notPass = results.filter((r) => r.verdict !== 'PASS');
    console.log(`### toolchain=${notPass.length === 0 ? 'PASS' : 'RED'}  ${results.length} checks, ${notPass.length} not passing: ${notPass.map((r) => `${r.check}(${r.verdict} ${r.reason})`).join(' ')}`);
    if (notPass.length > 0) {
        try {
            console.log('--- the end of the host log');
            for (const line of readFileSync(join(homedir(), '.genie', 'logs', 'genie-host.log'), 'utf8').split('\n').slice(-40)) console.log(line.replaceAll(PW, '<password>').slice(0, 240));
        } catch (error) { console.log(`--- no host log: ${error instanceof Error ? error.message : String(error)}`); }
    }
    process.exit(notPass.length === 0 ? 0 : 1);
}
setTimeout(() => { track('the-row-cap', 'FAIL', 'none', `the row ran past its ${CAP_MS / 1000} s cap`); void finish(); }, CAP_MS).unref();
process.on('SIGTERM', () => { void finish(); });

// --- the page ---------------------------------------------------------------------------------------------------------
/** A card as a person sees it: its badge, version, words and buttons. */
const card = (tool) => cdp.evaluate(`(() => {
    // Its card, or, for a language that has a section of its own instead (php, node, go ...), the row in it that carries
    // its install command: the 2026-11-20 run found no php card at all.
    const li = document.querySelector('li[data-tool=${JSON.stringify(tool)}]')
        ?? document.querySelector('[data-install-command=${JSON.stringify(tool)}]')?.closest('li, section, div');
    if (!li) return null;
    const buttons = [...li.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), action: b.getAttribute('data-action'), version: b.getAttribute('data-version'), disabled: b.disabled }));
    return {
        tone: li.getAttribute('data-tone'),
        version: li.querySelector('span.font-mono:not([data-install-command])')?.textContent.trim() ?? null,
        text: li.innerText.replace(/\\s+/g, ' ').trim(),
        installCommand: li.querySelector('[data-install-command]')?.textContent.trim() ?? null,
        installRefused: li.querySelector('[data-install-refused]')?.textContent.trim() ?? null,
        refusal: li.querySelector('[data-tool-refusal]')?.textContent.trim() ?? null,
        updating: li.querySelector('[data-tool-updating]')?.textContent.trim() ?? null,
        updated: li.querySelector('[data-tool-updated]')?.textContent.trim() ?? null,
        buttons,
    };
})()`);
/** Click a card's button by its words (what a person reads), or by its data-action. */
const press = (tool, match) => cdp.evaluate(`(() => {
    const li = document.querySelector('li[data-tool=${JSON.stringify(tool)}]');
    const re = new RegExp(${JSON.stringify(match)}, 'i');
    const b = li && [...li.querySelectorAll('button')].find((x) => !x.disabled && (re.test(x.textContent.trim()) || re.test(x.getAttribute('data-action') ?? '')));
    if (!b) return false;
    b.click();
    return true;
})()`);
/**
 * A tool's SIDE PANEL, opened as a person opens it: by choosing its card (#962's Toolchain: a language's versions, its
 * default radio and "Install another version" live there, and are on the page only while it is open).
 */
const openPanel = async (key) => {
    const isOpen = () => cdp.evaluate(`Boolean(document.querySelector('[data-toolchain-panel=${JSON.stringify(key)}]'))`);
    if (await isOpen()) return true;
    const chose = await until(30_000, () => cdp.evaluate(`(() => { const b = document.querySelector('[data-select-tool=${JSON.stringify(key)}]'); if (!b) return false; b.click(); return true; })()`));
    return Boolean(chose && (await until(15_000, isOpen)));
};
const act = (action) => cdp.evaluate(`(window.genieTest ?? window.genie).features.act(${JSON.stringify(action)}).then(() => true)`);
const snapshot = (path) => cdp.evaluate(`(window.genieTest ?? window.genie).features.snapshot().then((d) => { let v = d; for (const k of ${JSON.stringify(path)}) v = v?.[k]; return v ?? null; })`);
const recheck = async () => { await act({ kind: 'toolchain.check', force: true }); await sleep(1000); };
const stepsOf = (tool) => cdp.evaluate(`(window.__tc967?.steps?.[${JSON.stringify(tool)}] ?? [])`);
/** A password field the person can see, anywhere in the client: Genie's own elevation prompt. */
const promptShown = () => cdp.evaluate(`(() => {
    const input = [...document.querySelectorAll('input[type="password"]')].find((i) => i.offsetParent !== null);
    if (!input) return null;
    const box = input.closest('[role="dialog"], [role="alertdialog"], form, [data-elevation-prompt]') ?? input.parentElement;
    return { text: (box?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 300), empty: input.value === '' };
})()`);
async function answerPrompt(password) {
    await cdp.evaluate(`(() => { const i = [...document.querySelectorAll('input[type="password"]')].find((x) => x.offsetParent !== null); i.focus(); i.select?.(); return true; })()`);
    await cdp.send('Input.insertText', { text: password });
    const submitted = await cdp.evaluate(`(() => {
        const i = [...document.querySelectorAll('input[type="password"]')].find((x) => x.offsetParent !== null);
        const box = i.closest('[role="dialog"], [role="alertdialog"], form, [data-elevation-prompt]') ?? i.parentElement;
        const b = [...box.querySelectorAll('button')].find((x) => x.type === 'submit' || /^(ok|continue|allow|authori[sz]e|run|install|confirm|submit)/i.test(x.textContent.trim()));
        if (b) { b.click(); return true; }
        return false;
    })()`);
    if (!submitted) {
        for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }
}

let wrongTried = false;
/**
 * An action that needs root, as a person meets it: start it, wait for Genie's password prompt in this client, answer it
 * (the first time with a wrong password, which must ask again), and wait for `done`. Returns what happened.
 */
async function elevated(name, start, done, names, waitMs = 600_000) {
    const r = { prompted: false, promptText: '', reasked: null, refused: null, done: false };
    if (!(await start())) { r.refused = 'its button was not there to press'; return r; }
    const end = Date.now() + waitMs;
    const firstPromptBy = Date.now() + 120_000;
    let answers = 0;
    while (Date.now() < end) {
        const p = await promptShown();
        if (p) {
            r.prompted = true;
            r.promptText = p.text;
            if (!wrongTried) {
                wrongTried = true;
                await answerPrompt(WRONG);
                await sleep(3000);
                // Asked AGAIN: a fresh, empty field, not the same prompt still holding what was typed.
                r.reasked = Boolean(await until(30_000, async () => { const q = await promptShown(); return q?.empty ? q : null; }, 500));
                if (!r.reasked) return r;
            }
            // The right password, at most three times: a prompt that keeps coming back is a failure, not a loop.
            if (++answers > 3) { r.refused = 'the prompt came back after the right password three times'; return r; }
            await answerPrompt(PW);
            await sleep(2000);
            continue;
        }
        const d = await done();
        if (d) { r.done = true; return r; }
        const c = await card(name);
        const words = c?.refusal ?? c?.installRefused ?? null;
        if (words && !c?.updating) { r.refused = words; return r; }
        if (!r.prompted && Date.now() > firstPromptBy) { r.refused = null; return r; }
        await sleep(700);
    }
    return r;
}
const polkitFact = () => {
    const procs = out('pgrep', '-af', 'polkit');
    const agent = procs.split('\n').filter((l) => l && !/polkitd/.test(l));
    return agent.length > 0 ? `a polkit agent runs (${agent[0].slice(0, 80)})` : 'polkitd runs and NO polkit agent does, so a pkexec step has nobody to ask';
};
/** What an elevated step's failure reads as, by reason. */
function elevationVerdict(check, r, pkg) {
    if (r.refused && NO_PM.test(r.refused)) { track(check, 'BLOCKED', 'elevation', `not reached: refused first ("${r.refused}")`); return false; }
    if (!r.prompted) {
        track(check, 'RED', 'elevation', `no password prompt appeared in the client${r.refused ? `; the card said "${r.refused}"` : ' within 120 s'}; this machine: ${polkitFact()}`);
        return false;
    }
    if (r.reasked === false) { track(check, 'RED', 'elevation', 'a wrong password did not ask again'); return false; }
    if (pkg && !new RegExp(pkg, 'i').test(r.promptText)) { track(check, 'RED', 'elevation', `the prompt does not name ${pkg}: "${r.promptText}"`); return false; }
    track(check, 'PASS', 'elevation', `prompt "${r.promptText.slice(0, 120)}"${r.reasked ? '; a wrong password asked again' : ''}`);
    return true;
}

// --- the run ----------------------------------------------------------------------------------------------------------
try {
    // 0. THE MACHINE AS IT CAME, said before anything changes it.
    say(`user ${USER}; session PATH ${sessionPath}`);
    say(`pacman -Q: ${['git', 'php', 'composer', 'docker'].map((p) => `${p}=${pkgVersion(p) || '-'}`).join(' ')}; docker service ${out('systemctl', 'is-active', 'docker') || 'inactive'}; ${polkitFact()}`);

    // 1. SUDO AS A PERSON HAS IT. While NOPASSWD still holds: a real password, and whether the drop-in is there (its
    // folder is root's, 0750: only sudo can see into it). Then the password-required grant goes in. It sorts after the
    // NOPASSWD drop-in and the last match wins, so from that moment sudo asks for the password. The 2026-11-20 run
    // measured exactly that, with the grant written and `visudo -cf` failing, so a grant is judged by what sudo then
    // does, never by visudo. And the NOPASSWD drop-in goes aside, with the password.
    const chp = run('sudo', ['-n', 'chpasswd'], { input: `${USER}:${PW}\n` });
    sudoN('passwd', '-u', USER);
    const hadNopasswd = sudoN('test', '-e', NOPASSWD);
    const grant = join(mkdtempSync(join(tmpdir(), 'tc967-')), 'grant');
    writeFileSync(grant, `${USER} ALL=(ALL:ALL) ALL\n`);
    // Recorded before it is judged: whatever happens next, the end of the run removes it.
    personDone = true;
    const written = sudoN('install', '-m', '0440', '-o', 'root', '-g', 'root', grant, PERSON);
    asideDone = hadNopasswd && sudoP('mv', '-f', NOPASSWD, ASIDE).status === 0;
    const noNopasswd = !sudoN('true');
    const withPassword = sudoP('true').status === 0;
    if (chp.status === 0 && written && noNopasswd && withPassword) track('control-sudo-asks-for-the-password', 'PASS', 'none', `sudo -n is refused; sudo with the password works (${asideDone ? `${NOPASSWD} moved aside` : 'no NOPASSWD drop-in was there'})`);
    else { track('control-sudo-asks-for-the-password', 'FAIL', 'none', `chpasswd ${chp.status}, NOPASSWD drop-in there ${hadNopasswd}, grant written ${written}, moved aside ${asideDone}, sudo -n refused ${noNopasswd}, password works ${withPassword}`); throw new Error('sudo could not be set up as a person has it'); }

    // 2. git ABSENT, so its install is measured (the image ships it; npm ci has already run).
    const gitBefore = pkgVersion('git');
    const gitRemoved = sudoP('pacman', '-Rdd', '--noconfirm', 'git').status === 0 && !pkgVersion('git');
    track('control-git-removed', gitRemoved ? 'PASS' : 'FAIL', 'none', gitRemoved ? `git ${gitBefore} removed, so the card starts not-installed` : `pacman -Rdd git failed (git ${gitBefore})`);

    // 3. THE APP. Its window and host, under the session's PATH (what a person's apps get), on its own debugger port.
    run(process.execPath, ['scripts/smoke-seed.mjs'], { stdio: 'inherit' });
    const env = { ...process.env, PATH: sessionPath, GENIE_PAGE_PROBE: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    mkdirSync(OUT, { recursive: true });
    const appLog = openSync(join(OUT, 'toolchain-electron.log'), 'a');
    app = spawn(ELECTRON, ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', appLog, appLog] });
    const page = await until(90_000, async () => { try { return mainWindow(await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()); } catch { return null; } });
    if (!page) throw new Error(`no main window on the debugger port ${PORT} within 90 s`);
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    // The bridge AND its features: window.genie can exist before features.act does (the 2026-11-20 rerun threw on it).
    const bridged = await until(90_000, () => cdp.evaluate('typeof (window.genieTest ?? window.genie)?.features?.act === "function" && typeof (window.genieTest ?? window.genie)?.features?.snapshot === "function"'));
    if (!bridged) throw new Error('the page has no features bridge (features.act / features.snapshot) within 90 s');
    await closeWhatsNew((expression) => cdp.evaluate(expression));
    await cdp.evaluate(`window.location.hash = '#genie://toolchain'; true`);
    // Every progress step a card shows, as it shows it: a step that lasts 50 ms is still a step the person saw.
    await cdp.evaluate(`(() => {
        if (window.__tc967) return true;
        window.__tc967 = { steps: {} };
        const rec = () => {
            for (const el of document.querySelectorAll('[data-tool-updating], [data-tool-step], li[data-tool] [aria-busy="true"]')) {
                const tool = el.getAttribute('data-tool-updating') || el.getAttribute('data-tool-step') || el.closest('li[data-tool]')?.getAttribute('data-tool');
                // #962's card progress also shows a ticking elapsed time: the step is its words, never the clock.
                const text = (el.matches('[data-card-progress]') ? (el.querySelector('span.truncate')?.textContent ?? '') : el.textContent).trim();
                if (!tool || !text) continue;
                const a = (window.__tc967.steps[tool] ??= []);
                if (a[a.length - 1] !== text) a.push(text);
            }
        };
        new MutationObserver(rec).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        return true;
    })()`);
    await recheck();
    const shown = await until(180_000, async () => ((await cdp.evaluate(`document.querySelectorAll('li[data-tool]').length`)) >= 5 ? true : null));
    if (!shown) throw new Error('the Toolchain cards did not appear within 180 s');
    track('toolchain-cards', 'PASS', 'none', `${await cdp.evaluate(`document.querySelectorAll('li[data-tool]').length`)} cards`);

    // 4. NO "no package manager found" ANYWHERE, with pacman and yay on the machine.
    const pmWords = await cdp.evaluate(`[...document.querySelectorAll('li[data-tool]')].filter((li) => /no package manager/i.test(li.innerText)).map((li) => li.getAttribute('data-tool'))`);
    track('no-package-manager-words', pmWords.length === 0 ? 'PASS' : 'RED', 'pacman', pmWords.length === 0 ? 'no card says it' : `the cards of ${pmWords.join(', ')} say "no package manager found" (pacman ${pkgVersion('pacman')} and yay are on this machine)`);

    // 5. UPDATE OFFERED ONLY WHEN SOMETHING NEWER IS KNOWN, on the image's own docker card (git was removed above).
    {
        const c = await card('docker');
        const offers = (c?.buttons ?? []).filter((b) => b.action === 'toolchain-update');
        const known = c?.tone === 'update-available' || c?.tone === 'security-update';
        track('update-only-when-newer-known', offers.length === 0 || known ? 'PASS' : 'RED', 'pacman',
            offers.length === 0 || known ? `docker ${c?.version ?? '?'} (${c?.tone}) offers ${offers.map((b) => b.text).join(', ') || 'no Update'}` : `docker ${c?.version ?? '?'} offers "${offers.map((b) => b.text).join(', ')}" with nothing newer known (tone ${c?.tone})`);
    }

    // 6. PACMAN INSTALLS, each through the in-client prompt: php, composer, git.
    const installedByGenie = [];
    for (const [tool, pkg] of [['php', 'php'], ['composer', 'composer'], ['git', 'git']]) {
        const before = await card(tool);
        if (!before) {
            // No card and no install command anywhere: a language whose section offers only Genie's own builds. A person
            // has no way to get the system's package from here.
            await openPanel(tool);
            const words = await cdp.evaluate(`[...document.querySelectorAll('[data-${tool}-versions] [data-${tool}-system], [data-${tool}-versions] [data-${tool}-install-refused]')].map((e) => e.textContent.trim()).join(' / ')`);
            track(`${tool}-install`, 'RED', 'pacman', `no card offers to install ${pkg} with the system's package manager${words ? `; the ${tool} section says: "${words}"` : ''}`);
            track(`${tool}-elevation`, 'BLOCKED', 'elevation', 'not reached: nothing to install with');
            track(`${tool}-install-progress`, 'BLOCKED', 'pacman', 'not reached');
            continue;
        }
        if (before.tone !== null && before.tone !== 'not-installed') { track(`${tool}-install`, 'FAIL', 'none', `CONTROL: the card should start not-installed; it shows ${JSON.stringify(before).slice(0, 200)}`); continue; }
        if (before.installRefused) {
            track(`${tool}-install`, 'RED', 'pacman', `the card offers no Install: "${before.installRefused}"`);
            track(`${tool}-elevation`, 'BLOCKED', 'elevation', 'not reached: nothing to install with');
            track(`${tool}-install-progress`, 'BLOCKED', 'pacman', 'not reached');
            continue;
        }
        const r = await elevated(tool, () => press(tool, '^Install$'), async () => { if (!pkgVersion(pkg)) return null; const c = await card(tool); return c && c.tone !== 'not-installed' && c.version ? c : null; }, pkg);
        const prompted = elevationVerdict(`${tool}-elevation`, r, pkg);
        const after = await card(tool);
        const have = pkgVersion(pkg);
        const runs = answersInSession(tool, '--version').status === 0;
        if (r.done && have && after?.version && have.startsWith(after.version.split(/[-+]/)[0]) && runs) {
            track(`${tool}-install`, 'PASS', 'pacman', `the card shows ${after.version} (${after.tone}); pacman -Q ${pkg} ${have}; \`${tool} --version\` answers`);
            installedByGenie.push(tool);
        } else if (!prompted && !(r.refused && NO_PM.test(r.refused))) {
            track(`${tool}-install`, 'BLOCKED', 'pacman', `not measured: the elevated step did not run (card: ${after?.text?.slice(0, 160)})`);
        } else {
            track(`${tool}-install`, 'RED', 'pacman', `card ${after?.version ?? 'no version'} (${after?.tone}); pacman -Q ${pkg} ${have || 'not installed'}; runs ${runs}${r.refused ? `; the card said "${r.refused}"` : ''}`);
        }
        const steps = await stepsOf(tool);
        if (r.prompted || r.done) track(`${tool}-install-progress`, steps.length > 0 ? 'PASS' : 'RED', 'pacman', steps.length > 0 ? `steps: ${steps.join(' → ')}` : 'the card showed no progress step while it installed');
        else track(`${tool}-install-progress`, 'BLOCKED', 'pacman', 'not reached');
    }

    // 7. THE SYNC WITHOUT A PARTIAL UPGRADE: every installed package's dependencies are met, and what was installed runs.
    if (installedByGenie.length > 0) {
        const dk = run('pacman', ['-Dk']);
        const allRun = installedByGenie.every((t) => answersInSession(t, '--version').status === 0);
        track('pacman-no-partial-upgrade', dk.status === 0 && allRun ? 'PASS' : 'RED', 'pacman', `pacman -Dk: ${(dk.stdout + dk.stderr).trim().split('\n').slice(-2).join(' / ')}; ${installedByGenie.join(', ')} run: ${allRun}`);
    } else {
        track('pacman-no-partial-upgrade', 'BLOCKED', 'pacman', 'nothing was installed through Genie to check');
    }

    // 8. AN UPDATE: git held one version back by the harness (from the Arch archive), then Update on its card.
    {
        // The archive is outside Genie (Tynn #968): read with a deadline and once more, and when it cannot be read the control is
        // not set up, so the check is BLOCKED by `archive` (linux.sh TRACKED_ENV), never a failure of Genie's.
        const base = archiveBase(process.env);
        const listing = await readListing(fetch, `${archiveBase(process.env)}/packages/g/git/`);
        // Held below what THIS machine's repositories have (Tynn #968: Omarchy's mirror lags the archive), read without root
        // and without touching the system's sync databases, as Genie reads them.
        const repoGit = repoVersion(run, 'git', join(mkdtempSync(join(tmpdir(), 'tc968-')), 'db'));
        say(`git in this machine's repositories: ${repoGit ?? 'could not be read'}`);
        const plan = listing === null || repoGit === null ? null : heldBackOf(listing, repoGit);
        const held = plan?.held ?? null;
        const newest = plan?.newest ?? null;
        const url = held ? `${base}/packages/g/git/git-${held}-x86_64.pkg.tar.zst` : null;
        // The install is the harness's own control too (the archive read a second time, and pacman's hooks on a machine this
        // row has just changed): tried once more after a wait, with every try's output and status in this log.
        const heldRun = url ? await holdGitBack(() => sudoP('pacman', '-U', '--noconfirm', url)) : null;
        if (heldRun) for (const line of holdBackLog(url, heldRun)) console.log(line.replaceAll(PW, '<password>'));
        const heldOk = heldRun?.ok === true;
        if (!plan) {
            track('git-update', 'BLOCKED', 'archive', `CONTROL not set up: ${listing === null ? `the Arch archive (${base}) could not be read` : repoGit === null ? "this machine's repositories could not be read (checkupdates)" : `the Arch archive lists no git older than the repositories' ${repoGit}`}`);
        } else if (!heldOk) {
            // Still not set up: a control the harness could not make says nothing about Genie, so it BLOCKS (by `control`,
            // linux.sh TRACKED_ENV) with pacman's own words. The checks below, which measure Genie, are not reached.
            const control = holdBackCheck(url, heldRun);
            track('git-update', control.verdict, control.reason, control.detail);
        } else {
            await recheck();
            const before = await until(120_000, async () => { const c = await card('git'); return c?.version && held.startsWith(c.version.split(/[-+]/)[0]) ? c : null; }) ?? await card('git');
            const offer = (before?.buttons ?? []).find((b) => b.action === 'toolchain-update' && !b.disabled);
            if (!offer || (before?.tone !== 'update-available' && before?.tone !== 'security-update')) {
                track('git-update-offered', 'RED', 'pacman', `git ${before?.version ?? '?'} held back from ${newest}: the card is ${before?.tone} and offers ${offer ? `"${offer.text}"` : 'no Update'}`);
                track('git-update', 'BLOCKED', 'pacman', 'nothing newer was offered');
                track('git-update-elevation', 'BLOCKED', 'elevation', 'not reached');
            } else {
                track('git-update-offered', 'PASS', 'pacman', `git ${before.version} (${before.tone}): "${offer.text}"`);
                const r = await elevated('git', () => press('git', '^toolchain-update$'), async () => { const c = await card('git'); return c?.updated ? c : null; }, 'git');
                elevationVerdict('git-update-elevation', r, 'git');
                const after = await card('git');
                const have = pkgVersion('git');
                const steps = await stepsOf('git');
                const moved = have && !held.startsWith(have) && after?.version && have.startsWith(after.version.split(/[-+]/)[0]);
                track('git-update', moved && steps.length > 0 ? 'PASS' : r.prompted || r.done ? 'RED' : 'BLOCKED', 'pacman',
                    `card ${after?.version ?? '?'} ${after?.updated ?? ''} (${after?.tone}); pacman -Q git ${have}; steps: ${steps.join(' → ') || 'none'}${r.refused ? `; the card said "${r.refused}"` : ''}`);
            }
        }
    }

    // 9. DOCKER, INSTALLED WITH ITS DAEMON OFF: the card says Not running and offers Start; Start runs it. Off as
    // `pacman -S docker` leaves it, with neither the service nor its socket enabled. The image enables docker.socket, so
    // the first `docker` a probe runs starts the daemon (the 2026-11-20 run: inactive before the app, active by this
    // step). Each unit's state as the image had it is said first.
    {
        say(`docker as the image has it: service ${out('systemctl', 'is-enabled', 'docker.service') || '?'}/${out('systemctl', 'is-active', 'docker.service') || 'inactive'}, socket ${out('systemctl', 'is-enabled', 'docker.socket') || '?'}/${out('systemctl', 'is-active', 'docker.socket') || 'inactive'}`);
        sudoP('systemctl', 'disable', '--now', 'docker.socket', 'docker.service');
        await recheck();
        const c = await card('docker');
        const off = out('systemctl', 'is-active', 'docker') !== 'active';
        const says = c && /not running/i.test(c.text);
        const start = c?.buttons.find((b) => /^start/i.test(b.text) && !b.disabled);
        if (!off) track('docker-daemon-off', 'FAIL', 'none', 'CONTROL: docker is still active after the harness disabled and stopped it and its socket');
        else if (says && start) track('docker-daemon-off', 'PASS', 'docker', `the card: "${c.text.slice(0, 160)}"`);
        else track('docker-daemon-off', 'RED', 'docker', `daemon inactive; the card shows "${c?.text?.slice(0, 160) ?? 'no docker card'}" (${says ? 'Not running' : 'no "Not running"'}, ${start ? 'Start' : 'no Start'})`);
        if (off && says && start) {
            const r = await elevated('docker', () => press('docker', '^start'), async () => (dockerAnswers() ? true : null), 'docker');
            elevationVerdict('docker-start-elevation', r, 'docker');
            const runsNow = dockerAnswers();
            track('docker-start', runsNow && out('systemctl', 'is-enabled', 'docker') === 'enabled' ? 'PASS' : 'RED', 'docker', `docker service ${out('systemctl', 'is-active', 'docker') || 'inactive'}, ${out('systemctl', 'is-enabled', 'docker') || 'not enabled'}; docker info as ${USER}: ${runsNow ? 'answers' : 'does not answer'}`);
        } else {
            track('docker-start-elevation', 'BLOCKED', 'elevation', 'not reached: no Start offered');
            track('docker-start', 'BLOCKED', 'docker', 'no Start offered');
        }
    }

    // 10. DOCKER'S REAL INSTALL: the harness removes it, and the card installs it, enables it and answers as the user.
    {
        sudoP('systemctl', 'stop', 'docker.socket', 'docker.service');
        const removed = sudoP('pacman', '-Rdd', '--noconfirm', 'docker').status === 0 && !pkgVersion('docker');
        if (!removed) track('docker-install', 'FAIL', 'none', 'CONTROL: the harness could not remove docker');
        else {
            await recheck();
            const before = await until(60_000, async () => { const c = await card('docker'); return c?.tone === 'not-installed' ? c : null; }) ?? await card('docker');
            if (before?.tone !== 'not-installed') track('docker-install', 'FAIL', 'none', `CONTROL: docker was removed and the card still shows ${before?.version ?? '?'} (${before?.tone})`);
            else if (before.installRefused) {
                track('docker-install', 'RED', NO_PM.test(before.installRefused) ? 'pacman' : 'docker', `the card offers no Install: "${before.installRefused}"`);
                track('docker-install-elevation', 'BLOCKED', 'elevation', 'not reached');
                track('docker-install-runs', 'BLOCKED', 'docker', 'not reached');
            } else {
                const r = await elevated('docker', () => press('docker', '^Install$'), async () => { const c = await card('docker'); return c && c.tone !== 'not-installed' && c.version ? c : null; }, 'docker');
                elevationVerdict('docker-install-elevation', r, 'docker');
                const after = await card('docker');
                const have = pkgVersion('docker');
                track('docker-install', r.done && have ? 'PASS' : r.prompted ? 'RED' : 'BLOCKED', 'docker', `card ${after?.version ?? '?'} (${after?.tone}); pacman -Q docker ${have || 'not installed'}; steps: ${(await stepsOf('docker')).join(' → ') || 'none'}`);
                const answers = await until(60_000, async () => (dockerAnswers() ? true : null));
                track('docker-install-runs', answers ? 'PASS' : r.done ? 'RED' : 'BLOCKED', 'docker', `docker service ${out('systemctl', 'is-active', 'docker') || 'inactive'}; docker info as ${USER}: ${answers ? 'answers' : 'does not answer'}; the card: "${after?.text?.slice(0, 120) ?? ''}"`);
            }
        }
    }

    // 11. A GENIE SERVICE ON THAT DOCKER: a dedicated redis, created and running.
    if (!dockerAnswers()) {
        track('docker-service', 'BLOCKED', 'docker', `docker does not answer for ${USER}, so no service can start`);
    } else {
        await act({ kind: 'services.create', form: { workspaceId: 'tynn', engine: 'redis', major: '8', scope: 'dedicated' }, consent: true });
        const running = await until(300_000, async () => {
            const list = (await snapshot(['services', 'instances'])) ?? [];
            return list.find((s) => s?.instance?.engine === 'redis' && s.status === 'running') ?? null;
        }, 2000);
        const list = (await snapshot(['services', 'instances'])) ?? [];
        track('docker-service', running ? 'PASS' : 'FAIL', 'none', running ? `redis is running (${out('docker', 'ps', '--format', '{{.Image}} {{.Status}}').split('\n')[0]})` : `docker answers, and redis did not run: ${JSON.stringify(list.map((s) => ({ engine: s?.instance?.engine, status: s?.status, note: s?.note }))).slice(0, 300)}`);
    }

    // 12. A GENIE-MANAGED LANGUAGE AND ITS DEFAULT (Node): works today, and must keep working.
    {
        // As a person does it in #962's Toolchain: choose the Node card, which opens its side panel; press the Install
        // that "Install another version" offers (the version its picker shows, the newest by default); then that
        // version's default radio. Each is a button the person presses. One that is not there is a FAIL saying so, never
        // an action the row takes in their place (that fallback is what read the 2026-11-21 break as "did not install").
        const sel = (s) => JSON.stringify(s);
        const clickThe = (s) => cdp.evaluate(`(() => { const b = document.querySelector(${sel(s)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
        const opened = await openPanel('node');
        const pick = opened ? await cdp.evaluate(`document.querySelector('[data-install-another="node"] [data-node-install]')?.getAttribute('data-node-install') ?? null`) : null;
        if (!opened) track('node-install', 'FAIL', 'none', 'choosing the Node card did not open its panel');
        else if (!pick) track('node-install', 'FAIL', 'none', `the Node panel offers no "Install another version": "${(await cdp.evaluate(`document.querySelector('[data-toolchain-panel="node"]')?.innerText ?? ''`)).replace(/\s+/g, ' ').slice(0, 200)}"`);
        else {
            const pressed = await clickThe(`[data-install-another="node"] [data-node-install="${pick}"]`);
            const row = pressed && (await until(600_000, async () => { await openPanel('node'); return cdp.evaluate(`Boolean(document.querySelector(${sel(`[data-toolchain-panel="node"] li[data-node-version="${pick}"]`)}))`); }, 1000));
            const onCard = await cdp.evaluate(`Boolean(document.querySelector(${sel(`[data-version-chip="node:${pick}"]`)}))`);
            track('node-install', row ? 'PASS' : 'FAIL', 'none', !pressed ? `the Install for Node ${pick} could not be pressed (disabled)` : row ? `Node ${pick} has its row in the Node panel${onCard ? ', and a chip on the Node card' : ''}` : `Node ${pick} did not install: ${JSON.stringify(await snapshot(['toolchain', 'refusals']))?.slice(0, 200)}`);
            if (row) {
                await openPanel('node');
                const made = await until(30_000, () => clickThe(`[data-toolchain-panel="node"] [data-make-default="node:${pick}"]`));
                const isDefault = made && (await until(120_000, async () => { await openPanel('node'); return cdp.evaluate(`Boolean(document.querySelector(${sel(`li[data-node-version="${pick}"][data-default="true"] [data-is-default="node:${pick}"]`)}))`); }, 1000));
                const nodeNow = answersInSession('bash', '-lc', 'node --version').stdout?.trim() ?? '';
                track('node-default', isDefault ? 'PASS' : 'FAIL', 'none', !made ? `Node ${pick}'s default radio could not be pressed` : isDefault ? `Node ${pick}'s radio reads the default in its row; a login shell's node: ${nodeNow || 'none'}` : `Node ${pick}'s row does not read the default; ${JSON.stringify(await snapshot(['toolchain', 'defaults']))?.slice(0, 160)}`);
            }
        }
    }
    // 13. ELEVATION IN THE CLIENT, ON ITS OWN (Tynn #973): the one elevated step on this machine that waits on nothing
    // but #973 — the keyring's Install, which has its own pacman table. Its package really removed and its daemon ended,
    // then the card's button pressed from THIS window: Genie's prompt must appear here naming the packages, a wrong
    // password must ask again, and the right one must install it (pacman -Q). Last, so nothing before it meets a machine
    // without a keyring; the keyring is back at the end of the step whatever happened.
    {
        const keyringPkgs = 'gnome-keyring';
        const hadKeyring = Boolean(pkgVersion(keyringPkgs));
        const gone = hadKeyring && sudoP('pacman', '-Rdd', '--noconfirm', keyringPkgs).status === 0 && !pkgVersion(keyringPkgs);
        run('pkill', ['-f', 'gnome-keyring-daemon']);
        if (!gone) track('keyring-elevation', 'FAIL', 'none', `CONTROL: ${hadKeyring ? 'the harness could not remove gnome-keyring' : 'gnome-keyring was not installed to begin with'}`);
        else {
            // Not awaited: the button's action answers once the install is done, which waits on the prompt this step answers.
            const r = await elevated('keyring', async () => { void act({ kind: 'keyring.fix' }).catch(() => {}); return true; }, async () => (pkgVersion(keyringPkgs) ? true : null), keyringPkgs);
            elevationVerdict('keyring-elevation', r, keyringPkgs);
            // What the card said, when the install did not land: its failure in Genie's words (pacman's last line among them).
            const card = await snapshot(['integrations', 'keyring']).catch(() => null);
            track('keyring-install', r.done && pkgVersion(keyringPkgs) ? 'PASS' : r.prompted ? 'FAIL' : 'BLOCKED', r.prompted ? 'none' : 'elevation', `pacman -Q gnome-keyring ${pkgVersion(keyringPkgs) || 'not installed'}${r.refused ? `; Genie said "${r.refused}"` : ''}${card ? `; the card: ${JSON.stringify(card).slice(0, 300)}` : ''}`);
        }
        if (hadKeyring && !pkgVersion(keyringPkgs)) sudoP('pacman', '-S', '--needed', '--noconfirm', keyringPkgs);
    }
} catch (error) {
    track('the-row-threw', 'FAIL', 'none', error instanceof Error ? error.message : String(error));
}
await finish();
