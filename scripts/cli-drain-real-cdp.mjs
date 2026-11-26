#!/usr/bin/env node
/**
 * CLI UPDATES IN THE REAL APP (Tynn #1067), on a test VM only (GENIE_TEST_MACHINE=1, which both gates set), never a desktop:
 *   node scripts/cli-drain-real-cdp.mjs                 (linux.sh / windows.ps1 row `cli-drain`)
 *
 * PART 1, AT START, THE REAL CLAUDE CODE. An older Claude Code is installed by Anthropic's own installer into a home of this
 * run's own, and an agent on it is recorded as cut off mid-turn by the last quit (so the window resumes it at once). Then
 * Genie is launched on that home:
 *   - the wait window says what the host is updating, and is photographed while it does;
 *   - afterwards `claude --version` in that home is the newest published version;
 *   - genie-host's lifecycle log has `startup updates: done` BEFORE it composed hosting, opened its process book and
 *     before any agent started — and the agent did start after it (the positive control of that gauge).
 *
 * PART 2, A MANUAL UPDATE WITH AN AGENT RUNNING. Genie on a second home, pointed at a stub Claude Code that REFUSES its
 * update while any session of it runs (scripts/stub-claude-cli-1067.mjs; an .exe on Windows, stub-cli-exe-1067.cs). An
 * agent is started; then Update on Claude Code's Toolchain row:
 *   - the stub's own event log: the session ended, the update ran with no session alive, a NEW session started after;
 *   - the agent runs again, the lifecycle log has the drain's lines in order, the row's result names who was started again;
 *   - a failing update (the stub told to fail) still starts the agent again, and the row says why.
 * The Toolchain row is photographed during the drain and after each result, at 1280x800.
 *
 * Exit 0 every check passed; 1 a check failed; 2 not a test machine.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { isHostWaitWindow } from './cdp-main-window.mjs';
import { closeWhatsNew } from './cdp-whats-new.mjs';
import { attach, Cdp, check, failures, hostPid, killHard, launch, makeHome, readOr, sleep, step, until, WIN } from './crash-cdp-lib.mjs';

if (process.env.GENIE_TEST_MACHINE !== '1') {
    console.error('cli-drain-real-cdp installs Claude Code and launches Genie: a test machine only (GENIE_TEST_MACHINE=1)');
    process.exit(2);
}
process.env.GENIE_PAGE_PROBE ??= '1';

const PORT = Number(process.env.CLI_DRAIN_CDP_PORT ?? 9471);
const INSPECT = Number(process.env.CLI_DRAIN_INSPECT ?? 9472);
const OUT = resolve('ci-out');
const OS = WIN ? 'windows' : 'linux';
mkdirSync(OUT, { recursive: true });
const AGENT = `agent_${'c1d2e3f4'.repeat(4)}`;
const cleanups = [];

const npm = (args) => execFileSync(WIN ? 'npm.cmd' : 'npm', args, { encoding: 'utf8', timeout: 120_000, shell: WIN, windowsHide: true }).trim();
const lines = (text) => text.split(/\r?\n/);
const at = (text, pattern) => lines(text).findIndex((l) => pattern.test(l));

async function shoot(cdp, name, size = { width: 1280, height: 800 }) {
    try {
        if (size) await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false });
        await sleep(400);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        if (size) await cdp.send('Emulation.clearDeviceMetricsOverride');
        if (!shot.result?.data) throw new Error('no data');
        const file = join(OUT, `${name}-${OS}.png`);
        writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
        console.log(`  screenshot: ${file}`);
        return file;
    } catch (error) {
        console.log(`  screenshot ${name}: none (${error instanceof Error ? error.message : String(error)})`);
        return null;
    }
}

function seedAgent(h, { interrupted }) {
    const now = new Date().toISOString();
    writeFileSync(join(h.genie, 'runtime', 'agents.json'), JSON.stringify([{ id: AGENT, workspaceId: 'crash', provider: 'claude', name: 'atlas', instructions: null, threadId: null, createdAt: now, lastUsedAt: null, mode: 'manual', accessScope: 'none' }], null, 2));
    if (interrupted) writeFileSync(join(h.genie, 'runtime', 'interrupted-at-quit.json'), JSON.stringify([AGENT]));
}

async function stopGenie(h, app) {
    const pid = hostPid(h);
    if (app?.child?.pid) killHard(app.child.pid);
    if (pid) killHard(pid);
    await sleep(1500);
}

// ------------------------------------------------------------------------------------------------- part 1: at start
async function partStart() {
    step('1', 'an older Claude Code, installed by its own installer into this run’s home');
    const h = makeHome('cli-drain-start');
    const bin = join(h.home, '.local', 'bin');
    h.env = { ...h.env, PATH: `${bin}${delimiter}${h.env.PATH ?? h.env.Path ?? ''}` };
    delete h.env.GENIE2_CODEX_BINARY;
    const versions = JSON.parse(npm(['view', '@anthropic-ai/claude-code', 'versions', '--json']));
    const latest = npm(['view', '@anthropic-ai/claude-code', 'version']);
    const older = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).at(-6);
    console.log(`  newest ${latest}; installing ${older}`);
    const installEnv = { ...h.env };
    const installed = WIN
        ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& ([scriptblock]::Create((Invoke-RestMethod https://claude.ai/install.ps1))) ${older}`], { env: installEnv, encoding: 'utf8', timeout: 900_000, windowsHide: true })
        : spawnSync('bash', ['-c', `curl -fsSL https://claude.ai/install.sh | bash -s ${older}`], { env: installEnv, encoding: 'utf8', timeout: 900_000 });
    const claude = join(bin, WIN ? 'claude.exe' : 'claude');
    const before = existsSync(claude) ? spawnSync(claude, ['--version'], { env: h.env, encoding: 'utf8', timeout: 60_000, windowsHide: true }).stdout.trim() : '';
    if (!check(before.startsWith(older), `1a. CONTROL: Claude Code ${older} is installed in the run’s home, older than ${latest}`, before || `${installed.status}: ${(installed.stderr || installed.stdout || '').slice(-300)}`)) return;
    seedAgent(h, { interrupted: true });

    step('2', 'Genie launched: the host updates Claude Code before anything starts');
    const app = launch(h, { port: PORT, inspect: INSPECT, label: 'start' });
    cleanups.push(() => stopGenie(h, app));
    // The wait window: found by its file, read and photographed while it says what is being updated.
    let waitText = '';
    let waitShot = null;
    await until(async () => {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3_000) })).json();
        const wait = targets.find(isHostWaitWindow);
        if (!wait) return /startup updates: (done|time limit)/.test(readOr(h.lifecycle)) ? 'over' : null;
        const c = await Cdp.connect(wait.webSocketDebuggerUrl, 'wait');
        try {
            const text = await c.evaluate(`document.body?.innerText ?? ''`, 5_000);
            if (/Updating Genie’s tools/.test(text)) { waitText = text.replace(/\s+/g, ' '); waitShot = await shoot(c, 'cli-drain-startup-wait', null); return 'shown'; }
        } finally { await c.closed(2_000); }
        return null;
    }, 600_000, 500);
    check(/Updating Claude Code \S+ → \S+/.test(waitText) && waitShot !== null, '2a. the wait window says Claude Code is being updated, and was photographed', waitText || 'never shown');
    const { cdp } = await attach({ port: PORT, inspect: INSPECT, label: 'start' });
    const after = spawnSync(claude, ['--version'], { env: h.env, encoding: 'utf8', timeout: 60_000, windowsHide: true }).stdout.trim();
    check(after.startsWith(latest), `2b. Claude Code in that home is now ${latest}`, after);

    const agentStarted = await until(() => at(readOr(h.lifecycle), /spawn kind=agent|agent start owner=/) >= 0, 120_000);
    const log = readOr(h.lifecycle);
    const done = at(log, /startup updates: done/);
    const updated = at(log, /startup update: Updating Claude Code/);
    const hosting = at(log, /boot step=hosting/);
    const book = at(log, /process book open/);
    const firstAgent = at(log, /spawn kind=agent|agent start owner=/);
    check(updated >= 0 && done > updated, '2c. the lifecycle log says the update ran and the start’s updates were done', lines(log)[updated] ?? 'no update line');
    check(done >= 0 && hosting > done && (book === -1 || book > done), '2d. hosting and the process book came AFTER the updates', `done@${done} hosting@${hosting} book@${book}`);
    check(Boolean(agentStarted) && firstAgent > done, '2e. the resumed agent started AFTER the updates (and did start: the positive control)', `done@${done} first agent line@${firstAgent}: ${lines(log)[firstAgent] ?? 'none'}`);

    await closeWhatsNew((expression) => cdp.evaluate(expression));
    await cdp.evaluate(`window.location.hash = '#genie://toolchain'; true`);
    await until(() => cdp.evaluate(`Boolean(document.querySelector('li[data-tool="claude-code"]'))`), 120_000);
    await shoot(cdp, 'cli-drain-startup-toolchain');
    await cdp.closed(2_000);
    await stopGenie(h, app);
}

// --------------------------------------------------------------------------- part 2: a manual update, an agent running
function stubCli(root) {
    const dir = join(root, 'stub-bin');
    mkdirSync(dir, { recursive: true });
    for (const f of ['stub-claude-cli-1067.mjs', 'stub-claude.mjs']) copyFileSync(resolve('scripts', f), join(dir, f));
    if (!WIN) {
        const file = join(dir, 'claude');
        writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'stub-claude-cli-1067.mjs')}" "$@"\n`);
        chmodSync(file, 0o755);
        return file;
    }
    const csc = join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const file = join(dir, 'claude.exe');
    const built = spawnSync(csc, ['/nologo', '/target:exe', `/out:${file}`, resolve('scripts', 'stub-cli-exe-1067.cs')], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
    if (built.status !== 0) throw new Error(`csc could not build the stub .exe: ${(built.stdout + built.stderr).slice(-400)}`);
    return file;
}

const events = (state) => lines(readOr(join(state, 'events.log'))).filter(Boolean);
const card = (cdp) => cdp.evaluate(`(() => { const li = document.querySelector('li[data-tool="claude-code"]'); return li ? { text: li.innerText.replace(/\\s+/g, ' ').slice(0, 300), updating: li.querySelector('[data-tool-updating]')?.textContent.trim() ?? null, refusal: li.querySelector('[data-tool-refusal]')?.textContent.trim() ?? null } : null; })()`);

async function partDrain() {
    step('3', 'Genie on a stub Claude Code that refuses its update while a session of it runs');
    const h = makeHome('cli-drain-manual');
    const state = join(h.root, 'stub-state');
    mkdirSync(state, { recursive: true });
    const program = stubCli(h.root);
    h.env = { ...h.env, GENIE2_CLAUDE_BINARY: program, STUB_CLI_STATE: state, STUB_CLI_NODE: process.execPath, STUB_CLI_UPDATE_MS: '8000' };
    seedAgent(h, { interrupted: false });
    const app = launch(h, { port: PORT, inspect: INSPECT, label: 'manual' });
    cleanups.push(() => stopGenie(h, app));
    const { cdp } = await attach({ port: PORT, inspect: INSPECT, label: 'manual' });
    await closeWhatsNew((expression) => cdp.evaluate(expression));
    const atStart = events(state);
    const firstSession = atStart.findIndex((l) => / session start/.test(l));
    const startUpdate = atStart.findIndex((l) => / update ok/.test(l));
    check(startUpdate >= 0 && (firstSession === -1 || firstSession > startUpdate), '3a. at start the stub was updated before any session of it began', atStart.slice(0, 4).join(' | '));

    step('4', 'the agent started; then Update on Claude Code’s Toolchain row');
    await cdp.evaluate(`window.genieTest.agents.restart(${JSON.stringify(AGENT)}, "graceful"); true`);
    const running = await until(() => cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(AGENT)}).then((d) => d?.session?.running === true && d.session.starting === false)`), 60_000);
    const sessionsBefore = events(state).filter((l) => / session start/.test(l)).length;
    check(running === true && sessionsBefore >= 1, '4a. CONTROL: the agent runs, on a session of the stub', `running ${running}; ${sessionsBefore} session(s)`);
    await cdp.evaluate(`window.location.hash = '#genie://toolchain'; true`);
    await until(() => cdp.evaluate(`Boolean(document.querySelector('li[data-tool="claude-code"]'))`), 120_000);
    const mark = events(state).length;
    await cdp.evaluate(`(window.genieTest ?? window.genie).features.act({ kind: 'toolchain.update', tool: 'claude-code' }).then((r) => { window.__cliDrain = r?.toolchain ?? r; }, (e) => { window.__cliDrain = { error: String(e) }; }); true`);
    const during = await until(async () => { const c = await card(cdp); return c?.updating && /Updating Claude Code/.test(c.updating) ? c : null; }, 60_000, 250);
    check(Boolean(during), '4b. the row shows the drain’s steps while it runs', during?.updating ?? 'no step shown');
    await shoot(cdp, 'cli-drain-manual-updating');
    const result = await until(() => cdp.evaluate(`window.__cliDrain ?? null`), 300_000, 500);
    const ev = events(state).slice(mark);
    const ended = ev.findIndex((l) => / session end/.test(l));
    const ok = ev.findIndex((l) => / update ok/.test(l));
    const again = ev.findIndex((l, i) => i > ok && / session start/.test(l));
    check(!ev.some((l) => / update refused/.test(l)), '4c. the stub never found a session alive at its update', ev.filter((l) => /refused/.test(l)).join(' | ') || 'none refused');
    check(ended >= 0 && ok > ended && again > ok, '4d. the stub’s order: the session ended, THEN the update, THEN a new session', ev.join(' | '));
    const runningAgain = await until(() => cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(AGENT)}).then((d) => d?.session?.running === true)`), 60_000);
    check(runningAgain === true, '4e. the agent runs again', String(runningAgain));
    check(/Stopped and started again: atlas/.test(String(result?.result ?? '')), '4f. the result names who was started again', String(result?.result ?? JSON.stringify(result)).slice(0, 300));
    const log = readOr(h.lifecycle);
    const order = [/cli drain provider=claude agents=atlas/, /cli drain provider=claude stopped=atlas/, /cli drain provider=claude update=ok/, /cli drain provider=claude restarted=atlas/].map((p) => at(log, p));
    check(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), '4g. the lifecycle log has the drain’s lines in order', order.join(' < '));
    await shoot(cdp, 'cli-drain-manual-done');

    step('5', 'a failing update: the agent is started again all the same, and the row says why');
    writeFileSync(join(state, 'fail-update'), '1');
    await cdp.evaluate(`window.__cliDrain = null; (window.genieTest ?? window.genie).features.act({ kind: 'toolchain.update', tool: 'claude-code' }).then((r) => { window.__cliDrain = r?.toolchain ?? r; }, (e) => { window.__cliDrain = { error: String(e) }; }); true`);
    const failed = await until(() => cdp.evaluate(`window.__cliDrain ?? null`), 300_000, 500);
    const refusal = (failed?.refusals ?? []).find((r) => r.tool === 'claude-code')?.reason ?? '';
    check(/fail this update|exited 1/.test(refusal), '5a. the row says the update failed, and why', refusal || JSON.stringify(failed).slice(0, 300));
    const back = await until(() => cdp.evaluate(`window.genieTest.agentDetail(${JSON.stringify(AGENT)}).then((d) => d?.session?.running === true)`), 60_000);
    check(back === true && /cli drain provider=claude update=failed/.test(readOr(h.lifecycle)), '5b. the agent runs again after the failed update, and the log says it failed', String(back));
    await shoot(cdp, 'cli-drain-manual-failed');
    await cdp.closed(2_000);
    await stopGenie(h, app);
}

let code = 0;
try {
    await partStart();
    await partDrain();
} catch (error) {
    check(false, 'the run did not finish', error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
    for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* bounded */ } }
    code = failures.length > 0 ? 1 : 0;
    console.log(code === 0 ? '\ncli-drain OK' : `\ncli-drain FAILED — ${failures.length} check(s):\n  - ${failures.join('\n  - ')}`);
}
process.exit(code);
