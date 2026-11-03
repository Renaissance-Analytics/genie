import fs from 'node:fs';
import path from 'node:path';

/**
 * A LINUX SESSION WITH NO KEYRING (the owner, 2026-11-01: "Genie needs to install this if it's not already on the
 * machine … I can't log into tynn"), and the owner's ruling: with no keyring Genie REFUSES to keep a secret and says
 * why — never a weaker plain-text store.
 *
 * Four states a Linux session can be in, each with one action the person can take from Genie's card:
 *
 *  - `not-installed`   nothing serves the Secret Service and no keyring is installed → Install keyring: the distro's
 *                      package (gnome-keyring + libsecret) through `pkexec`, so the SYSTEM asks for the password —
 *                      Genie never does. No pkexec, or no polkit agent to ask: the exact command to run instead.
 *  - `not-running`     installed, but nothing owns `org.freedesktop.secrets` → Start keyring: D-Bus activation (the
 *                      activation file the package installs, the same path libsecret takes), then
 *                      `gnome-keyring-daemon --start --components=secrets` if that fails.
 *  - `restart-needed`  a keyring answers, but this Genie launched on Chromium's plaintext store — Chromium picks its
 *                      store once, at launch (`--password-store`) → Restart Genie.
 *  - `refused`         the keyring is selected and gave no key (a locked collection) → Check again, after the person
 *                      unlocks it with their system's own prompt.
 *
 * NO HYPRLAND AUTOSTART EDIT: gnome-keyring ships a D-Bus activation file for `org.freedesktop.secrets`, so the
 * Secret Service starts on demand in every session, and Genie's launch hook activates it before it picks a store
 * (linux-password-store.ts `activateSecretService`). Nothing in the person's config needs to change to survive a reboot.
 *
 * A SMALL, ELECTRON-FREE MODULE on purpose: the host split's P3.4 (secrets to the OS keychain via `@napi-rs/keyring`,
 * which talks to the same Secret Service over libsecret) reuses the detection, the install plan and the flow. Only the
 * `facts()` port knows about Electron (`safeStorage`'s backend), and P3.4 supplies its own.
 */

export type PackageManager = 'pacman' | 'apt' | 'dnf' | 'zypper';

/** What a session's keyring looks like, read from the session bus, the filesystem and this process. */
export interface KeyringFacts {
    readonly platform: NodeJS.Platform;
    /** A keyring daemon is installed (`gnome-keyring-daemon` found). */
    readonly installed: boolean;
    /** Something OWNS `org.freedesktop.secrets` on the session bus right now. */
    readonly owned: boolean;
    /** `org.freedesktop.secrets` can be D-Bus activated (installed, not yet running). */
    readonly activatable: boolean;
    /** `safeStorage.getSelectedStorageBackend()` for this process on Linux; null elsewhere. */
    readonly backend: string | null;
    /** `safeStorage.isEncryptionAvailable()` for this process. */
    readonly available: boolean;
}

export type KeyringState = 'ready' | 'not-installed' | 'not-running' | 'restart-needed' | 'refused';
export type KeyringStep = 'installing' | 'starting' | 'restarting';

/** The card, as the renderer draws it. `null` from {@link LinuxKeyring.view} = no card (ready, or not Linux). */
export interface KeyringView {
    readonly state: Exclude<KeyringState, 'ready'>;
    /** The step running now; the button is busy and says it. */
    readonly step: KeyringStep | null;
    /** The last step's failure in words; the button says Retry. */
    readonly failure: string | null;
    /** The command to run by hand, when there is one. */
    readonly manual: string | null;
    /** The packages Genie would install, for the card's one line. */
    readonly packages: string;
}

/** How to install the keyring here: `run` is the pkexec argv (null = Genie cannot run it), `manual` the command to type. */
export interface InstallPlan {
    readonly run: readonly string[] | null;
    readonly manual: string | null;
    readonly packages: readonly string[];
}

/** Backends that really encrypt (Electron's spelling). `basic_text` and `unknown` are the plaintext store / not yet known. */
const REAL_BACKENDS: ReadonlySet<string> = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

/** PURE: the state of a session's keyring. `basic_text` is never ready, whatever Electron would encrypt with. */
export function classifyKeyring(f: KeyringFacts): KeyringState {
    if (f.platform !== 'linux') return f.available ? 'ready' : 'refused';
    const realBackend = f.backend !== null && REAL_BACKENDS.has(f.backend);
    if (realBackend && f.available) return 'ready';
    if (!f.owned) return f.installed || f.activatable ? 'not-running' : 'not-installed';
    return realBackend ? 'refused' : 'restart-needed';
}

/** PURE: `org.freedesktop.secrets` in `busctl --user list --no-legend` — owned (a PID) or activatable (PID `-`). */
export function parseSecretServiceListing(stdout: string): { owned: boolean; activatable: boolean } {
    for (const line of (stdout ?? '').split(/\r?\n/)) {
        const [name = '', pid = ''] = line.trim().split(/\s+/);
        if (name !== 'org.freedesktop.secrets') continue;
        if (/^\d+$/.test(pid)) return { owned: true, activatable: false };
        if (pid === '-' && line.includes('(activatable)')) return { owned: false, activatable: true };
    }
    return { owned: false, activatable: false };
}

/** The packages per distro family: the Secret Service daemon and the library clients (Chromium, `secret-tool`) use. */
export const KEYRING_PACKAGES: Readonly<Record<PackageManager, readonly string[]>> = {
    pacman: ['gnome-keyring', 'libsecret'],
    apt: ['gnome-keyring', 'libsecret-1-0'],
    dnf: ['gnome-keyring', 'libsecret'],
    zypper: ['gnome-keyring', 'libsecret-1-0'],
};

/** PURE: the package manager, from `/etc/os-release` (ID, then ID_LIKE), else the first one on PATH; null if unknown. */
export function detectPackageManager(osRelease: string, has: (bin: string) => boolean): PackageManager | null {
    const field = (key: string) => {
        const m = new RegExp(`^${key}=(.*)$`, 'm').exec(osRelease ?? '');
        return (m?.[1] ?? '').replace(/^["']|["']$/g, '').toLowerCase().split(/\s+/).filter(Boolean);
    };
    const families: Array<[PackageManager, RegExp]> = [
        ['pacman', /^(arch|archarm|manjaro|endeavouros|cachyos|omarchy|garuda|artix)$/],
        ['apt', /^(debian|ubuntu|linuxmint|pop|elementary|raspbian|kali|zorin|neon)$/],
        ['dnf', /^(fedora|rhel|centos|rocky|almalinux|nobara)$/],
        ['zypper', /^(suse|opensuse|opensuse-leap|opensuse-tumbleweed|sles)$/],
    ];
    for (const id of [...field('ID'), ...field('ID_LIKE')]) {
        for (const [pm, re] of families) if (re.test(id)) return pm;
    }
    for (const [pm, bin] of [['pacman', 'pacman'], ['apt', 'apt-get'], ['dnf', 'dnf'], ['zypper', 'zypper']] as const) {
        if (has(bin)) return pm;
    }
    return null;
}

/** PURE: the install command, non-interactive, leaving already-installed packages alone. */
export function installArgv(pm: PackageManager): string[] {
    const pkgs = [...KEYRING_PACKAGES[pm]];
    switch (pm) {
        case 'pacman': return ['pacman', '-S', '--needed', '--noconfirm', ...pkgs];
        case 'apt': return ['apt-get', 'install', '-y', ...pkgs];
        case 'dnf': return ['dnf', 'install', '-y', ...pkgs];
        case 'zypper': return ['zypper', '--non-interactive', 'install', ...pkgs];
    }
}

/** PURE: run it through pkexec (the system's own password prompt) when there is one; always show the command to type. */
export function installPlan(pm: PackageManager | null, pkexec: string | null): InstallPlan {
    if (pm === null) return { run: null, manual: null, packages: KEYRING_PACKAGES.pacman };
    const argv = installArgv(pm);
    return { run: pkexec ? [pkexec, ...argv] : null, manual: `sudo ${argv.join(' ')}`, packages: KEYRING_PACKAGES[pm] };
}

/** Ask the session bus to activate the Secret Service — what libsecret itself does on first use. */
export const START_SECRET_SERVICE_ARGV: readonly string[] = [
    'dbus-send', '--session', '--dest=org.freedesktop.DBus', '--print-reply', '--type=method_call',
    '/org/freedesktop/DBus', 'org.freedesktop.DBus.StartServiceByName', 'string:org.freedesktop.secrets', 'uint32:0',
];
/** The fallback when activation fails: start (or connect to) gnome-keyring's secrets component for this session. */
export const START_DAEMON_ARGV: readonly string[] = ['gnome-keyring-daemon', '--start', '--components=secrets'];

/** pkexec's documented exit codes: 126 = the person dismissed the prompt / not authorised; 127 = could not authenticate (no agent). */
const PKEXEC_DISMISSED = 126;
const PKEXEC_NO_AGENT = 127;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 10_000;

export interface KeyringPorts {
    readonly platform: NodeJS.Platform;
    /** Read the session now (bus, filesystem, this process's backend). */
    facts(): Promise<Omit<KeyringFacts, 'platform'>>;
    /** How to install here (package manager, pkexec). */
    plan(): Promise<InstallPlan>;
    /** Run a command; never a shell. A spawn failure is a non-zero code, not a throw. */
    exec(argv: readonly string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stderr: string }>;
    /** Restart Genie (main: remember the store, relaunch, quit). */
    relaunch(): void;
    /** The view changed (main pushes the snapshot). */
    onChange?(): void;
}

const lastLine = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';

/** The keyring card's state and its one button (feature-ipc `keyring.fix`). One step at a time; every step is shown. */
export class LinuxKeyring {
    readonly #ports: KeyringPorts;
    #facts: KeyringFacts;
    #plan: InstallPlan | null = null;
    #step: KeyringStep | null = null;
    #failure: string | null = null;
    #manualOnFailure: string | null = null;
    #work: Promise<void> | null = null;
    readonly #listeners = new Set<() => void>();

    private constructor(ports: KeyringPorts, facts: KeyringFacts) { this.#ports = ports; this.#facts = facts; }

    static async open(ports: KeyringPorts): Promise<LinuxKeyring> {
        const k = new LinuxKeyring(ports, { platform: ports.platform, ...(await ports.facts()) });
        if (k.state() === 'not-installed') k.#plan = await ports.plan();
        return k;
    }

    state(): KeyringState { return classifyKeyring(this.#facts); }
    canKeepSecrets(): boolean { return this.state() === 'ready'; }

    view(): KeyringView | null {
        const state = this.state();
        if (state === 'ready' || this.#facts.platform !== 'linux') return null;
        const plan = this.#plan;
        return {
            state,
            step: this.#step,
            failure: this.#failure,
            manual: this.#manualOnFailure ?? plan?.manual ?? null,
            packages: (plan?.packages ?? KEYRING_PACKAGES.pacman).join(', '),
        };
    }

    onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
    #changed(): void {
        for (const l of this.#listeners) l();
        this.#ports.onChange?.();
    }
    #set(step: KeyringStep | null, failure: string | null = null, manual: string | null = null): void {
        this.#step = step; this.#failure = failure; this.#manualOnFailure = manual; this.#changed();
    }
    async #reread(): Promise<void> {
        this.#facts = { platform: this.#ports.platform, ...(await this.#ports.facts()) };
        if (this.state() === 'not-installed' && !this.#plan) this.#plan = await this.#ports.plan();
    }

    /**
     * THE KEYCHAIN'S ANSWER CHANGED (host-keychain.ts): read the session again, and say so if the card changed. A running step decides for itself when it ends, and several
     * changes while one read runs are that one read.
     */
    recheck(): Promise<void> {
        if (this.#work) return this.#work;
        const before = JSON.stringify(this.view());
        const work = this.#reread()
            .then(() => {
                if (this.state() === 'ready') { this.#step = null; this.#failure = null; this.#manualOnFailure = null; }
                if (JSON.stringify(this.view()) !== before) this.#changed();
            })
            .finally(() => { this.#work = null; });
        this.#work = work;
        return work;
    }

    /** The card's button: the next step for the state the session is in. A click while one runs joins it. */
    fix(): Promise<void> {
        if (this.#work) return this.#work;
        const work = this.#fix().finally(() => { this.#work = null; });
        this.#work = work;
        return work;
    }

    async #fix(): Promise<void> {
        await this.#reread();
        switch (this.state()) {
            case 'ready': this.#set(null); return;
            case 'not-installed': if (!(await this.#install())) return; await this.#start(); return;
            case 'not-running': await this.#start(); return;
            case 'restart-needed': this.#set('restarting'); this.#ports.relaunch(); return;
            case 'refused': this.#set(null, 'Your keyring is running but gave Genie no key — it is probably locked. Unlock it, then Check again.'); return;
        }
    }

    async #install(): Promise<boolean> {
        const plan = this.#plan ?? (this.#plan = await this.#ports.plan());
        if (!plan.run) {
            this.#set(null, plan.manual
                ? 'Genie cannot ask for your password here (pkexec is not installed). Run this in a terminal, then Check again.'
                : `Genie does not know this system’s package manager. Install ${plan.packages.join(' and ')} with it, then Check again.`, plan.manual);
            return false;
        }
        this.#set('installing');
        const r = await this.#ports.exec(plan.run, { timeoutMs: INSTALL_TIMEOUT_MS });
        if (r.code === PKEXEC_DISMISSED) { this.#set(null, 'Cancelled: nothing was installed.'); return false; }
        if (r.code === PKEXEC_NO_AGENT) { this.#set(null, 'Your system could not ask for your password (no authentication agent is running). Run this in a terminal instead, then Check again.', plan.manual); return false; }
        if (r.code !== 0) {
            const said = lastLine(r.stderr);
            this.#set(null, `The install failed (exit ${r.code})${said ? `: ${said}` : ''}.`, plan.manual);
            return false;
        }
        await this.#reread();
        return true;
    }

    async #start(): Promise<void> {
        this.#set('starting');
        await this.#ports.exec(START_SECRET_SERVICE_ARGV, { timeoutMs: START_TIMEOUT_MS });
        await this.#reread();
        if (!this.#facts.owned) {
            await this.#ports.exec(START_DAEMON_ARGV, { timeoutMs: START_TIMEOUT_MS });
            await this.#reread();
        }
        if (!this.#facts.owned) { this.#set(null, 'The keyring is installed but would not start. Retry, or sign out of your desktop and back in.'); return; }
        this.#set(null);
    }
}

export interface RealKeyringDeps {
    /** Run a program (never a shell). May throw for a missing program (ENOENT). */
    run(binary: string, args: readonly string[], timeoutMs?: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    /** This process's store: `safeStorage.getSelectedStorageBackend()` and `isEncryptionAvailable()` in Electron. */
    storage(): { backend: string | null; available: boolean };
    relaunch(): void;
    onChange?(): void;
    readFile?(file: string): string | null;
    exists?(file: string): boolean;
    pathEnv?: string;
}

/** The ports over a real machine; every probe failure reads as "not there", never a throw. */
export function realKeyringPorts(deps: RealKeyringDeps): KeyringPorts {
    const exists = deps.exists ?? ((file: string) => fs.existsSync(file));
    const readFile = deps.readFile ?? ((file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } });
    const dirs = (deps.pathEnv ?? process.env['PATH'] ?? '').split(':').filter(Boolean);
    const onPath = (bin: string): string | null => {
        for (const dir of [...dirs, '/usr/bin', '/usr/local/bin']) {
            const candidate = path.posix.join(dir, bin);
            if (exists(candidate)) return candidate;
        }
        return null;
    };
    const secretService = async (): Promise<{ owned: boolean; activatable: boolean }> => {
        try {
            const r = await deps.run('busctl', ['--user', 'list', '--no-legend', '--no-pager'], 3_000);
            if (r.exitCode === 0) return parseSecretServiceListing(r.stdout);
        } catch { /* no busctl (non-systemd): ask D-Bus directly */ }
        try {
            const r = await deps.run('dbus-send', ['--session', '--dest=org.freedesktop.DBus', '--print-reply', '--type=method_call', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.secrets'], 3_000);
            return { owned: r.exitCode === 0 && /\bboolean\s+true\b/.test(r.stdout), activatable: false };
        } catch {
            return { owned: false, activatable: false };
        }
    };
    return {
        platform: 'linux',
        facts: async () => ({ installed: onPath('gnome-keyring-daemon') !== null, ...(await secretService()), ...deps.storage() }),
        plan: async () => installPlan(detectPackageManager(readFile('/etc/os-release') ?? '', (bin) => onPath(bin) !== null), onPath('pkexec')),
        exec: async (argv, opts) => {
            try {
                const r = await deps.run(argv[0]!, argv.slice(1), opts?.timeoutMs);
                return { code: r.exitCode, stderr: r.stderr };
            } catch (error) {
                return { code: -1, stderr: error instanceof Error ? error.message : String(error) };
            }
        },
        relaunch: () => deps.relaunch(),
        ...(deps.onChange ? { onChange: deps.onChange } : {}),
    };
}

/** The non-secret note that a sign-in was waiting for the keyring, so the relaunched Genie reopens it. */
const RESUME_FILE = 'keyring-resume.json';
export type ResumeSignIn = 'tynn';

/** Write it before a keyring restart. Only WHICH sign-in — never a code or a token. */
export function markResumeSignIn(dir: string, which: ResumeSignIn): void {
    try { fs.writeFileSync(path.join(dir, RESUME_FILE), JSON.stringify({ resume: which }), 'utf8'); } catch { /* the person signs in again by hand */ }
}

/** Read it once, at launch; it is gone after. */
export function takeResumeSignIn(dir: string): ResumeSignIn | null {
    const file = path.join(dir, RESUME_FILE);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { resume?: unknown };
        fs.rmSync(file, { force: true });
        return parsed?.resume === 'tynn' ? 'tynn' : null;
    } catch {
        return null;
    }
}
