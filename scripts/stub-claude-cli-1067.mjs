#!/usr/bin/env node
/**
 * A STUB CLAUDE CODE THAT CANNOT BE UPDATED WHILE IT RUNS (Tynn #1067's drain row, scripts/cli-drain-real-cdp.mjs).
 *
 * The real Claude Code cannot run a session on a test VM (it has no account there), and the drain is about what happens
 * to a RUNNING session when its CLI is updated. So this is the CLI Genie is pointed at (GENIE2_CLAUDE_BINARY, the way a
 * person with a non-standard install points it), with the one property the drain exists for, made strict: `update` FAILS
 * while any session of it is still running ("in use", as Windows' locked file is), and succeeds only once none is.
 *
 *   --version        `<version> (Claude Code)` from the state folder (STUB_CLI_STATE; 2.0.0 at first)
 *   auth status      exit 0: signed in
 *   update           refused (exit 1, EBUSY) while a session's pid is alive; otherwise the patch version + 1, after
 *                    STUB_CLI_UPDATE_MS (so a screenshot can see the step); `fail-update` in the state folder fails it
 *   anything else    a session: its pid recorded until it exits, then stub-claude.mjs's protocol (initialize, set_model)
 *
 * Every event is a line in <state>/events.log, with its time and pid: the row reads the order from it.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const state = process.env.STUB_CLI_STATE || join(here, 'stub-cli-state');
const sessions = join(state, 'sessions');
mkdirSync(sessions, { recursive: true });
const versionFile = join(state, 'version.txt');
const version = () => (existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '2.0.0');
const event = (line) => appendFileSync(join(state, 'events.log'), `${Date.now()} pid=${process.pid} ${line}\n`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const args = process.argv.slice(2);

if (args[0] === '--version') {
    console.log(`${version()} (Claude Code)`);
    process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
    console.log(JSON.stringify({ loggedIn: true, authMethod: 'stub' }));
    process.exit(0);
}
if (args[0] === 'update') {
    const live = readdirSync(sessions).map((f) => Number(f.replace(/\.pid$/, ''))).filter((pid) => Number.isInteger(pid) && pid !== process.pid && alive(pid));
    if (live.length > 0) {
        event(`update refused in-use=${live.join(',')}`);
        console.error(`Error: EBUSY: resource busy or locked — Claude Code is in use by pid ${live.join(', ')}`);
        process.exit(1);
    }
    const from = version();
    if (existsSync(join(state, 'fail-update'))) {
        event(`update failed from=${from} (fail-update)`);
        console.error('Error: the stub was told to fail this update (fail-update)');
        process.exit(1);
    }
    const wait = Number(process.env.STUB_CLI_UPDATE_MS ?? 0);
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 120_000)));
    const [a, b, c] = from.split('.').map(Number);
    const to = `${a}.${b}.${c + 1}`;
    writeFileSync(versionFile, to);
    event(`update ok from=${from} to=${to}`);
    console.log(`Successfully updated from ${from} to version ${to}`);
    process.exit(0);
}

// A session.
const mine = join(sessions, `${process.pid}.pid`);
writeFileSync(mine, String(process.pid));
event(`session start version=${version()} args=${args.filter((x) => !x.startsWith('{')).join(' ').slice(0, 200)}`);
const end = () => { try { rmSync(mine, { force: true }); } catch { /* gone */ } };
process.on('exit', () => { event('session end'); end(); });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0));
await import('./stub-claude.mjs');
