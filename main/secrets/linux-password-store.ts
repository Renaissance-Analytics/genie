import { execFileSync } from 'node:child_process';

/**
 * Which Chromium password store Genie should use on Linux — SELECTED, not
 * inferred (genie#379).
 *
 * Electron's `safeStorage` encrypts through Chromium's OSCrypt, which picks a
 * Linux backend by sniffing `XDG_CURRENT_DESKTOP`. It knows GNOME, KDE and a
 * short list of others; on anything else — Hyprland, sway, river, i3, i.e. a
 * large share of the Linux developer audience — it falls back to the plaintext
 * `basic` store. safeStorage then correctly reports encryption unavailable and
 * Genie correctly refuses to store a token. Every layer behaves properly; the
 * backend was simply never selected.
 *
 * A session bus name is a much better signal than a desktop name: if something
 * OWNS `org.freedesktop.secrets`, there is a working Secret Service to talk to,
 * whatever the window manager calls itself. So Genie probes for it and passes
 * `--password-store=` itself, on EVERY launch.
 *
 * genie#588: that probe is a SUBPROCESS, and it was the only thing selecting a
 * backend. On a machine whose keyring is provably healthy it comes back empty,
 * Genie selects nothing, Chromium falls back to the plaintext store, and the
 * user is told their computer's keychain is unavailable. So the probe is no
 * longer the only opinion: whenever a launch DOES end up on a real backend,
 * Electron's own `safeStorage.getSelectedStorageBackend()` says which one, and
 * that answer is written down (see ./password-store-memo.ts) and re-asserted on
 * every later launch — including the ones that re-exec with an empty argv.
 *
 * The decisions here are PURE and unit-tested; only {@link probeOwnedBusNames}
 * touches a subprocess.
 */

/** The Secret Service bus name — the thing libsecret actually talks to. */
export const SECRET_SERVICE_NAME = 'org.freedesktop.secrets';

/** KWallet's bus names, newest first; each maps to its own Chromium backend. */
const KWALLET_BACKENDS: ReadonlyArray<[name: string, backend: string]> = [
    ['org.kde.kwalletd6', 'kwallet6'],
    ['org.kde.kwalletd5', 'kwallet5'],
    ['org.kde.kwalletd', 'kwallet'],
];

/**
 * The `--password-store` values worth carrying between launches — the four
 * backends that actually encrypt. `basic` is deliberately absent: a memo may
 * only ever pin a WORKING store, never the plaintext fallback that is the whole
 * failure being fixed.
 */
const REMEMBERABLE_STORES: ReadonlySet<string> = new Set([
    'gnome-libsecret',
    ...KWALLET_BACKENDS.map(([, backend]) => backend),
]);

/** PURE: is this a `--password-store` value Genie is willing to pass on? Values
 *  read back off disk go straight onto Chromium's command line, and one it does
 *  not recognise is logged and ignored — i.e. silently back to plaintext. */
export function isRememberablePasswordStore(value: unknown): value is string {
    return typeof value === 'string' && REMEMBERABLE_STORES.has(value);
}

/** PURE: does this argv already carry an explicit `--password-store`? */
export function hasPasswordStoreArg(argv: readonly string[]): boolean {
    return argv.some((a) => a === '--password-store' || a.startsWith('--password-store='));
}

/**
 * PURE: the `--password-store` switch value that reproduces what
 * `safeStorage.getSelectedStorageBackend()` just reported, or null when the
 * report is not a backend worth remembering.
 *
 * The two vocabularies differ: Electron answers `gnome_libsecret`, Chromium's
 * switch takes `gnome-libsecret`. `basic_text` is the failure state and
 * `unknown` only means the question was asked before app-ready — writing either
 * one down would make the bug stick rather than heal.
 */
export function switchValueForSelectedBackend(selected: string | null | undefined): string | null {
    switch (selected) {
        case 'gnome_libsecret':
            return 'gnome-libsecret';
        case 'kwallet':
        case 'kwallet5':
        case 'kwallet6':
            return selected;
        default:
            return null;
    }
}

export interface PasswordStoreChoice {
    platform: NodeJS.Platform;
    /** This process's argv — an explicit `--password-store` wins over us. */
    argv: string[];
    /** Bus names with an owner on the session bus (see {@link probeOwnedBusNames}). */
    ownedBusNames: string[];
    /** The backend a previous launch was seen using, as a switch value — the
     *  fallback for when the probe answers nothing (genie#588). */
    remembered?: string | null;
}

/**
 * PURE: the `--password-store` value to pass on this launch, or null to leave
 * Chromium's own detection alone (nothing to select, or the user already chose).
 */
export function chooseLinuxPasswordStore(input: PasswordStoreChoice): string | null {
    if (input.platform !== 'linux') return null;
    // An explicit choice — from the user, a wrapper script, or a `.desktop`
    // Exec= line — is the user's decision, not ours to override.
    if (hasPasswordStoreArg(input.argv)) return null;
    const owned = new Set(input.ownedBusNames);
    // KWallet also publishes org.freedesktop.secrets, so prefer its native
    // backend when it is the thing answering.
    for (const [name, backend] of KWALLET_BACKENDS) {
        if (owned.has(name)) return backend;
    }
    if (owned.has(SECRET_SERVICE_NAME)) return 'gnome-libsecret';
    // The bus said nothing. That is either a machine with no keyring — where
    // selecting one would be wrong — or a probe that could not run, which looks
    // exactly the same from here. What a working launch was actually SEEN using
    // breaks the tie; a live probe above still overrules it.
    return isRememberablePasswordStore(input.remembered) ? input.remembered : null;
}

/**
 * PURE: the NAME column of `busctl --user list --no-legend`. Unique connection
 * names (`:1.42`) are not services and are dropped.
 */
export function parseBusctlNames(stdout: string): string[] {
    const names: string[] = [];
    for (const line of (stdout ?? '').split(/\r?\n/)) {
        const name = line.trim().split(/\s+/)[0] ?? '';
        if (!name || name.startsWith(':')) continue;
        names.push(name);
    }
    return names;
}

/** PURE: the boolean in a `dbus-send --print-reply` NameHasOwner reply. */
export function parseDbusSendBoolean(stdout: string): boolean {
    return /\bboolean\s+true\b/.test(stdout ?? '');
}

type Run = (cmd: string, args: string[]) => string;

const defaultRun: Run = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] });

/** True for the "that program is not installed" spawn failure. */
function isMissingTool(e: unknown): boolean {
    const code = (e as { code?: unknown })?.code;
    return code === 'ENOENT' || code === 'EACCES';
}

/**
 * Impure probe: which of `names` currently have an owner on the SESSION bus.
 *
 * Runs BEFORE `app.whenReady()` (Chromium reads `--password-store` when OSCrypt
 * initialises), so it is synchronous and short-timeout, and every failure —
 * no tool, no bus, a hang — resolves to "nothing owned", i.e. today's behaviour.
 * `busctl` answers for every name in ONE call and is present wherever systemd
 * is; `dbus-send` is the fallback and must be asked per name, so it stops at
 * the first hit and gives up entirely when the tool isn't there. Boot must
 * never wait on a dead bus for longer than a blink.
 */
export function probeOwnedBusNames(names: string[], run: Run = defaultRun): string[] {
    try {
        const listed = new Set(
            parseBusctlNames(run('busctl', ['--user', 'list', '--no-legend', '--no-pager'])),
        );
        return names.filter((n) => listed.has(n));
    } catch {
        /* busctl absent (non-systemd) or no session bus — try dbus-send */
    }
    for (const name of names) {
        try {
            const out = run('dbus-send', [
                '--session',
                '--dest=org.freedesktop.DBus',
                '--print-reply',
                '--type=method_call',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus.NameHasOwner',
                `string:${name}`,
            ]);
            // Callers rank `names` in the order they'd pick them, so the first
            // owned one settles it — no reason to keep asking.
            if (parseDbusSendBoolean(out)) return [name];
        } catch (e) {
            if (isMissingTool(e)) return [];
            /* a per-name failure (bus refused, timed out) → not owned */
        }
    }
    return [];
}

/** Every bus name {@link chooseLinuxPasswordStore} can act on. */
export function passwordStoreBusNames(): string[] {
    return [...KWALLET_BACKENDS.map(([name]) => name), SECRET_SERVICE_NAME];
}

export interface KeychainHintInput {
    platform: NodeJS.Platform;
    /** `XDG_CURRENT_DESKTOP`, when there is one. */
    desktop: string | undefined;
    /** Does anything own {@link SECRET_SERVICE_NAME} right now? */
    secretServiceOwned: boolean;
    /** `safeStorage.getSelectedStorageBackend()` on Linux; null elsewhere. */
    selectedBackend: string | null;
}

/**
 * WHICH fault is behind "encryption is unavailable". Three Linux causes wear the
 * same face and have three different remedies — one of which is not the user's
 * to apply.
 *
 *  - `no-service`   nothing owns the Secret Service bus name. A keyring really
 *                   is missing, and package advice is finally appropriate.
 *  - `not-selected` a keyring IS answering and this process is on the plaintext
 *                   store. Genie's fault, not the machine's (genie#588).
 *  - `refused`      a real backend is selected and would not produce a key —
 *                   a locked collection, typically. Only this one is the
 *                   keychain being unavailable in the sense the word implies.
 */
export type KeychainFault = 'not-linux' | 'no-service' | 'not-selected' | 'refused';

/** PURE: {@link KeychainFault} for the state described by `input`. */
export function classifyKeychainFault(input: KeychainHintInput): KeychainFault {
    if (input.platform !== 'linux') return 'not-linux';
    if (!input.secretServiceOwned) return 'no-service';
    return switchValueForSelectedBackend(input.selectedBackend) ? 'refused' : 'not-selected';
}

/**
 * PURE: why can this machine not encrypt a secret at rest?
 *
 * genie#379: the old text — "On Linux: install gnome-keyring / libsecret" —
 * was confidently incorrect on a machine where both were installed and the
 * keyring was serving `gh`. A wrong cause is worse than none: the user installs
 * two packages, nothing changes, and there is no next step. Blame packages ONLY
 * when nothing is actually answering on the bus.
 */
export function keychainUnavailableHint(input: KeychainHintInput): string {
    const desktop = input.desktop?.trim();
    switch (classifyKeychainFault(input)) {
        case 'not-linux':
            return (
                'Genie could not reach this machine’s OS keystore, so it will not store a token ' +
                'unencrypted. Sign out and back in, or restart Genie, and try again.'
            );
        case 'no-service':
            return (
                `Nothing on this session bus owns ${SECRET_SERVICE_NAME}, so there is no keyring to ` +
                'encrypt with. Start a secret service — gnome-keyring-daemon (--components=secrets) ' +
                'or KWallet — then reopen Genie.'
            );
        case 'refused':
            // NOT "restart Genie": the backend is already the right one, so the
            // next launch would select exactly the same thing and fail the same
            // way. The key is what is missing, and only the keyring has it.
            return (
                `A secret service is running and Genie is using the ${input.selectedBackend} store, ` +
                'but it would not hand over an encryption key — the keyring collection is most ' +
                'likely locked. Unlock your login keyring, then try again.'
            );
        case 'not-selected':
        default:
            // Genie's own fault, and it says so: nothing here asks the user to
            // install a keyring they already have (genie#379, genie#588).
            return (
                `A secret service is running, but this process is using the ${
                    input.selectedBackend ?? 'plaintext'
                } store, so nothing can be encrypted at rest` +
                (desktop ? ` (desktop: ${desktop})` : '') +
                '. Restart Genie — it records the backend that works on this machine and ' +
                'selects it on every launch from then on.'
            );
    }
}
