#!/usr/bin/env node
/**
 * THE KEYCHAIN LIBRARY, MEASURED (host split P3.4 cut a; plan §13) — the real @napi-rs/keyring against the real OS store.
 *
 *   node scripts/perf-lag/keychain-measure.mjs before    # write, round trip, no-keyring failure, the trap; sizes
 *   node scripts/perf-lag/keychain-measure.mjs recheck   # a NEW session, before the reboot: is each entry still there?
 *   node scripts/perf-lag/keychain-measure.mjs after     # after a reboot: what survived, then clean up
 *
 * The claim: an entry PINNED to the Secret Service survives a reboot, and pinned with no Secret Service is a clear failure.
 * THE POSITIVE CONTROL: the UNPINNED default, with no Secret Service reachable, falls back to the kernel keyring: its write and
 * read-back succeed, and it is GONE after the reboot. That is the failure the pin exists to stop, and it proves this gauge can
 * see it. `recheck` proves it was the reboot that took it, not merely a new session or process.
 *
 *   node scripts/perf-lag/keychain-measure.mjs persist-write   # Windows, in a logged-on session; then reboot
 *   node scripts/perf-lag/keychain-measure.mjs persist-read    # after it, in a logged-on session
 *
 * "No Secret Service" is a child process with the session bus pointed nowhere. Windows runs `before` for the round trip and
 * the size limit (the pin means nothing there); there is no reboot phase on Windows.
 *
 * Prints `### keychain <check>=PASS|FAIL`. Every keychain call has a 15 s deadline; the phase is capped at 120 s. Exit 0 only when
 * every check passed. It writes real keychain entries, so it refuses anywhere but a test machine (CI, user `genie`, or
 * KEYCHAIN_MEASURE_ALLOW=1). The values are test words, never a secret.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { secretNote } from '../secret-note.mjs';

const SERVICE = 'GenieKeychainMeasure';
const PINNED_VALUE = 'survives-a-reboot';
const TRAP_VALUE = 'lost-at-reboot';
const PIN = { linux: { store: 'secret-service' } };
const phase = process.argv[2] ?? '';
const LINUX = process.platform === 'linux';

const user = process.env.USER ?? process.env.LOGNAME ?? process.env.USERNAME ?? '';
if (!(process.env.CI === 'true' || process.env.KEYCHAIN_MEASURE_ALLOW === '1' || (LINUX && user === 'genie'))) {
    console.error('keychain-measure: REFUSING: it writes real keychain entries, so only on a test machine');
    process.exit(3);
}
setTimeout(() => { console.log('### keychain phase-deadline=FAIL (120 s)'); process.exit(1); }, 120_000).unref();

const { AsyncEntry } = createRequire(`${process.cwd()}/`)('@napi-rs/keyring');
let failed = 0;
function check(name, ok, detail = '') {
    console.log(`### keychain ${name}=${ok ? 'PASS' : 'FAIL'}${detail ? `  ${detail}` : ''}`);
    if (!ok) failed += 1;
}
const within = (p) => { let t; return Promise.race([p, new Promise((_, no) => { t = setTimeout(() => no(new Error('no answer within 15 s')), 15_000); })]).finally(() => clearTimeout(t)); };
const attempt = async (fn) => { try { return { value: await within(fn()) }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } };
const entry = (name, pinned) => (pinned ? new AsyncEntry(SERVICE, name, PIN) : new AsyncEntry(SERVICE, name));

/** This script again, with no Secret Service reachable: one sub-phase, its checks printed through. */
function withNoBus(sub) {
    const r = spawnSync(process.execPath, [process.argv[1], sub], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/genie-no-bus' } });
    process.stdout.write(r.stdout ?? '');
    if (r.status !== 0) failed += 1;
}

switch (phase) {
    case 'before': {
        console.log(`keychain-measure before: ${process.platform}, node ${process.version}, electron ${process.versions.electron ?? 'none'}`);
        const round = entry('round-trip', true);
        const set = await attempt(() => round.setPassword('round'));
        check('round-trip-set', !set.error, set.error ?? '');
        const got = await attempt(() => round.getPassword());
        check('round-trip-read-back', got.value === 'round', got.error ?? secretNote(got.value));
        const del = await attempt(() => round.deletePassword());
        check('round-trip-delete', !del.error, del.error ?? '');
        const gone = await attempt(() => round.getPassword());
        check('missing-reads-as-null-not-an-error', !gone.error && (gone.value === null || gone.value === undefined), gone.error ?? secretNote(gone.value));
        // How large an entry can be (Windows Credential Manager has a limit; an ed25519 PEM is ~120 bytes).
        for (const size of [128, 512, 1280, 2048, 2560, 4096]) {
            const e = entry('size', true);
            const value = 'x'.repeat(size);
            const s = await attempt(() => e.setPassword(value));
            const r = s.error ? { error: s.error } : await attempt(() => e.getPassword());
            console.log(`keychain size ${size}: ${s.error || r.error ? `refused (${s.error ?? r.error})` : r.value === value ? 'kept, byte for byte' : 'CHANGED on read-back'}`);
            await attempt(() => e.deletePassword());
        }
        if (!LINUX) break;
        const pinned = await attempt(() => entry('pinned', true).setPassword(PINNED_VALUE));
        check('pinned-write', !pinned.error, pinned.error ?? '');
        const listed = spawnSync('secret-tool', ['search', '--all', 'service', SERVICE], { encoding: 'utf8', timeout: 15_000 });
        check('pinned-is-in-the-secret-service', `${listed.stdout}${listed.stderr}`.includes(SERVICE) || `${listed.stdout}${listed.stderr}`.includes('pinned'), (listed.stdout ?? '').split('\n').filter((l) => /label|service|username/.test(l)).join(' | ').slice(0, 200));
        withNoBus('nobus-before');
        break;
    }
    // A value written in one boot and read in the next, on Windows (Credential Manager has no bus and no pin, so this is all a reboot can ask of it).
    case 'persist-write': {
        const w = await attempt(() => entry('persist', true).setPassword(PINNED_VALUE));
        check('persist-write', !w.error, w.error ?? '');
        break;
    }
    case 'persist-read': {
        const r = await attempt(() => entry('persist', true).getPassword());
        check('PERSISTED-THROUGH-THE-REBOOT', r.value === PINNED_VALUE, r.error ?? secretNote(r.value));
        await attempt(() => entry('persist', true).deletePassword());
        break;
    }
    case 'nobus-before': {
        const refused = await attempt(() => entry('pinned-nobus', true).setPassword('never'));
        check('pinned-with-no-secret-service-FAILS-clearly', Boolean(refused.error), refused.error ?? 'it WROTE: the pin did not hold');
        const read = await attempt(() => entry('pinned-nobus', true).getPassword());
        check('pinned-read-with-no-secret-service-FAILS-not-missing', Boolean(read.error), read.error ?? `answered ${secretNote(read.value)}`);
        // THE TRAP. Expected to succeed: this is the silent fallback the pin exists to stop.
        const trap = await attempt(() => entry('trap', false).setPassword(TRAP_VALUE));
        const back = trap.error ? trap : await attempt(() => entry('trap', false).getPassword());
        check('control-unpinned-with-no-secret-service-falls-back-SILENTLY', !trap.error && back.value === TRAP_VALUE, trap.error ?? back.error ?? secretNote(back.value));
        break;
    }
    case 'recheck': {
        const pinned = await attempt(() => entry('pinned', true).getPassword());
        check('pinned-there-in-a-new-session', pinned.value === PINNED_VALUE, pinned.error ?? secretNote(pinned.value));
        withNoBus('nobus-recheck');
        break;
    }
    case 'nobus-recheck': {
        const trap = await attempt(() => entry('trap', false).getPassword());
        check('control-unpinned-still-there-before-the-reboot', trap.value === TRAP_VALUE, trap.error ?? secretNote(trap.value));
        break;
    }
    case 'after': {
        console.log(`keychain-measure after: uptime ${execFileSync('uptime', ['-p'], { encoding: 'utf8', timeout: 5_000 }).trim()}`);
        const pinned = await attempt(() => entry('pinned', true).getPassword());
        check('PINNED-SURVIVED-THE-REBOOT', pinned.value === PINNED_VALUE, pinned.error ?? secretNote(pinned.value));
        withNoBus('nobus-after');
        await attempt(() => entry('pinned', true).deletePassword());
        break;
    }
    case 'nobus-after': {
        const trap = await attempt(() => entry('trap', false).getPassword());
        check('control-UNPINNED-DID-NOT-SURVIVE-THE-REBOOT', !trap.error && (trap.value === null || trap.value === undefined), trap.error ?? `still reads ${secretNote(trap.value)}`);
        break;
    }
    default:
        console.error('usage: keychain-measure.mjs before|recheck|after');
        process.exit(2);
}
console.log(`### keychain phase ${phase}=${failed === 0 ? 'PASS' : `FAIL (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
