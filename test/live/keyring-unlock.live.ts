/**
 * KEYRING UNLOCK, MEASURED ON A REAL SESSION (Tynn story #388) — for omarchy-test, never this desktop.
 *
 *   npx tsx test/live/keyring-unlock.live.ts
 *
 * Prints `### key=value` lines, one per measurement:
 *   A. Does @napi-rs/keyring's own read pop the unlock dialog when the default collection is locked? (the coordinator's
 *      question: if it does, reliably, a smaller fix might be to make that read on purpose)
 *   B. Genie's own client (main/secret-service-bus.ts): the dialog appears, and its outcome. With
 *      GENIE_TEST_KEYRING_PASSWORD set and `wtype` installed, the password is typed into the dialog (the unlocked path);
 *      otherwise the dialog is closed (the dismissed path).
 * Each part first LOCKS the default collection with Service.Lock, and waits at most 20 s for the dialog.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { parseBusAddress, unlockDefaultCollection } from '../../src/main/secret-service-bus.js';

const run = promisify(execFile);
const say = (k: string, v: string | number | boolean) => console.log(`### ${k}=${v}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT = '/org/freedesktop/secrets/aliases/default';

async function gdbus(method: string, arg: string): Promise<string> {
    const r = await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets', '--method', `org.freedesktop.Secret.Service.${method}`, arg], { timeout: 10_000 });
    return r.stdout.trim();
}
async function locked(): Promise<boolean | null> {
    try {
        const r = await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', DEFAULT, '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Locked'], { timeout: 10_000 });
        return /true/.test(r.stdout);
    } catch { return null; }
}
async function prompter(): Promise<boolean> {
    try { await run('pgrep', ['-f', 'gcr-prompter|gcr4-ssh-askpass|pinentry']); return true; } catch { return false; }
}
async function waitPrompter(ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (await prompter()) return true; await sleep(250); }
    return false;
}
async function closePrompter(): Promise<void> { await run('pkill', ['-f', 'gcr-prompter']).catch(() => {}); }
async function lockDefault(tag: string): Promise<void> {
    try { await gdbus('Lock', `['${DEFAULT}']`); } catch (e) { say(`${tag}-lock-error`, String((e as Error).message).split('\n')[0]!); }
    say(`${tag}-locked-before`, String(await locked()));
}

async function partA(): Promise<void> {
    await lockDefault('a');
    const child = spawn(process.execPath, ['-e', "const { Entry } = require('@napi-rs/keyring'); try { const v = new Entry('genie-measure', 'probe').getPassword(); console.log('READ', v === null ? 'null' : 'value'); } catch (e) { console.log('ERROR', e.message); }"], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const prompted = await waitPrompter(20_000);
    say('a-napi-read-prompted', prompted);
    if (prompted) await closePrompter();
    await Promise.race([new Promise((r) => child.on('exit', r)), sleep(10_000)]);
    child.kill();
    say('a-napi-read-result', JSON.stringify(out.trim().slice(0, 120)));
    say('a-locked-after', String(await locked()));
}

async function partB(): Promise<void> {
    await lockDefault('b');
    const where = parseBusAddress(process.env['DBUS_SESSION_BUS_ADDRESS']);
    if ('error' in where) { say('b-error', where.error); return; }
    const started = Date.now();
    const unlock = unlockDefaultCollection({ socketPath: where.path, uid: process.getuid!(), stepTimeoutMs: 10_000 });
    const prompted = await waitPrompter(20_000);
    say('b-genie-prompted', prompted);
    const password = process.env['GENIE_TEST_KEYRING_PASSWORD'];
    let typed = false;
    if (prompted && password) {
        try { await sleep(800); await run('wtype', [password]); await run('wtype', ['-k', 'Return']); typed = true; } catch (e) { say('b-type-error', String((e as Error).message).split('\n')[0]!); }
    }
    say('b-typed-password', typed);
    if (prompted && !typed) await closePrompter();
    const r = await Promise.race([unlock, sleep(30_000).then(() => ({ outcome: 'timeout', detail: null }))]);
    say('b-genie-outcome', r.outcome);
    // How it unlocked: `unlock` = Unlock answered with no prompt object (no dialog was needed — a collection with an empty
    // password, or already open); `prompt` = through Prompt.Completed (the desktop's dialog ran). Says what Part B proved.
    say('b-genie-via', 'via' in r && r.via ? r.via : 'none');
    if (r.detail) say('b-genie-detail', JSON.stringify(r.detail));
    say('b-ms', Date.now() - started);
    say('b-locked-after', String(await locked()));
}

say('dbus-address', JSON.stringify(process.env['DBUS_SESSION_BUS_ADDRESS'] ?? null));
await partA().catch((e) => say('a-crash', JSON.stringify(String(e))));
await partB().catch((e) => say('b-crash', JSON.stringify(String(e))));
say('keyring-unlock-live', 'done');
