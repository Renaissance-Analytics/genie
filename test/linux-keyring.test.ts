import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    KEYRING_PACKAGES,
    LinuxKeyring,
    START_DAEMON_ARGV,
    START_SECRET_SERVICE_ARGV,
    classifyKeyring,
    detectPackageManager,
    installArgv,
    installPlan,
    parseSecretServiceListing,
    takeResumeSignIn,
    markResumeSignIn,
    type InstallPlan,
    type KeyringFacts,
    type KeyringPorts,
} from '../src/main/linux-keyring.js';

/**
 * A LINUX SESSION WITH NO KEYRING (the owner, 2026-11-01: "Genie needs to install this if it's not already on the
 * machine. I am having this problem with both of my omarchy machines and it's annoying because I can't log into tynn").
 * With nothing serving the Secret Service, Chromium falls back to its plaintext store and Genie (rightly) refuses to keep a
 * sign-in. Genie now says so in a card with ONE obvious button, installs and starts the keyring with the person's consent
 * (the system's own password prompt, pkexec), and never falls back to a weaker store (the owner's ruling).
 */

const HEALTHY: Omit<KeyringFacts, 'platform'> = { installed: true, owned: true, activatable: true, backend: 'gnome_libsecret', available: true };
const linux = (f: Partial<KeyringFacts>): KeyringFacts => ({ platform: 'linux', ...HEALTHY, ...f });

describe('classifyKeyring — detection', () => {
    it('owned by a running keyring, and this process encrypts with it: ready', () => {
        expect(classifyKeyring(linux({}))).toBe('ready');
    });

    it('NOT INSTALLED: no daemon, nothing owns or can activate the Secret Service', () => {
        expect(classifyKeyring(linux({ installed: false, owned: false, activatable: false, backend: 'basic_text', available: false }))).toBe('not-installed');
    });

    it('INSTALLED but NOT OWNED (not running, activatable or not): not-running, never "not installed"', () => {
        expect(classifyKeyring(linux({ owned: false, activatable: true, backend: 'basic_text', available: false }))).toBe('not-running');
        expect(classifyKeyring(linux({ owned: false, activatable: false, backend: 'basic_text', available: false }))).toBe('not-running');
        // A Secret Service from another provider (KWallet's compat) counts as installed even with no gnome-keyring binary.
        expect(classifyKeyring(linux({ installed: false, owned: false, activatable: true, backend: 'basic_text', available: false }))).toBe('not-running');
    });

    it('OWNED, but this process started on the plaintext store: restart-needed (Chromium picks its store at launch)', () => {
        expect(classifyKeyring(linux({ backend: 'basic_text', available: false }))).toBe('restart-needed');
        expect(classifyKeyring(linux({ backend: 'unknown', available: false }))).toBe('restart-needed');
    });

    it('OWNED and selected, but no key was given (a locked collection): refused', () => {
        expect(classifyKeyring(linux({ available: false }))).toBe('refused');
    });

    it('basic_text is NEVER ready, even if Electron would encrypt with its built-in key', () => {
        expect(classifyKeyring(linux({ backend: 'basic_text', available: true }))).toBe('restart-needed');
        expect(classifyKeyring(linux({ owned: false, installed: false, activatable: false, backend: 'basic_text', available: true }))).toBe('not-installed');
    });

    it('off Linux there is no card: the OS keystore is always there (ready), or refused', () => {
        expect(classifyKeyring({ ...HEALTHY, platform: 'win32', backend: null })).toBe('ready');
        expect(classifyKeyring({ ...HEALTHY, platform: 'win32', backend: null, available: false })).toBe('refused');
    });
});

describe('parseSecretServiceListing — busctl --user list', () => {
    it('owned (a PID) vs activatable (PID -, "(activatable)") vs absent', () => {
        expect(parseSecretServiceListing('org.freedesktop.secrets 710 gnome-keyring-d genie :1.3 user@1000.service - -')).toEqual({ owned: true, activatable: false });
        expect(parseSecretServiceListing('org.freedesktop.secrets - - - (activatable) - - -')).toEqual({ owned: false, activatable: true });
        expect(parseSecretServiceListing('org.freedesktop.DBus 1 systemd genie :1.0 init.scope - -\norg.kde.kwalletd6 - - - (activatable) - - -')).toEqual({ owned: false, activatable: false });
        expect(parseSecretServiceListing('')).toEqual({ owned: false, activatable: false });
    });
});

describe('detectPackageManager', () => {
    const none = () => false;
    it('reads /etc/os-release ID and ID_LIKE: Arch/Omarchy, Debian/Ubuntu, Fedora, openSUSE', () => {
        expect(detectPackageManager('NAME="Arch Linux"\nID=arch\n', none)).toBe('pacman');
        expect(detectPackageManager('ID=omarchy\nID_LIKE=arch\n', none)).toBe('pacman');
        expect(detectPackageManager('ID=ubuntu\nID_LIKE=debian\n', none)).toBe('apt');
        expect(detectPackageManager('ID=linuxmint\nID_LIKE="ubuntu debian"\n', none)).toBe('apt');
        expect(detectPackageManager('ID=fedora\n', none)).toBe('dnf');
        expect(detectPackageManager('ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n', none)).toBe('zypper');
    });

    it('an unknown distro falls back to the package manager on PATH, else null', () => {
        expect(detectPackageManager('ID=mystery\n', (b) => b === 'dnf')).toBe('dnf');
        expect(detectPackageManager('ID=mystery\n', (b) => b === 'pacman')).toBe('pacman');
        expect(detectPackageManager('ID=mystery\n', none)).toBeNull();
        expect(detectPackageManager('', none)).toBeNull();
    });
});

describe('the install command, per package manager', () => {
    it('the packages are gnome-keyring plus libsecret, named the way each distro names them', () => {
        expect(KEYRING_PACKAGES.pacman).toEqual(['gnome-keyring', 'libsecret']);
        expect(KEYRING_PACKAGES.apt).toEqual(['gnome-keyring', 'libsecret-1-0']);
        expect(KEYRING_PACKAGES.dnf).toEqual(['gnome-keyring', 'libsecret']);
        expect(KEYRING_PACKAGES.zypper).toEqual(['gnome-keyring', 'libsecret-1-0']);
    });

    it('non-interactive, already-installed packages left alone', () => {
        expect(installArgv('pacman')).toEqual(['pacman', '-S', '--needed', '--noconfirm', 'gnome-keyring', 'libsecret']);
        expect(installArgv('apt')).toEqual(['apt-get', 'install', '-y', 'gnome-keyring', 'libsecret-1-0']);
        expect(installArgv('dnf')).toEqual(['dnf', 'install', '-y', 'gnome-keyring', 'libsecret']);
        expect(installArgv('zypper')).toEqual(['zypper', '--non-interactive', 'install', 'gnome-keyring', 'libsecret-1-0']);
    });
});

describe('installPlan — pkexec, and its fallback', () => {
    it('with pkexec: the system asks for the password (pkexec), Genie never does; the command is shown too', () => {
        const plan = installPlan('pacman', '/usr/bin/pkexec');
        expect(plan.run).toEqual(['/usr/bin/pkexec', 'pacman', '-S', '--needed', '--noconfirm', 'gnome-keyring', 'libsecret']);
        expect(plan.manual).toBe('sudo pacman -S --needed --noconfirm gnome-keyring libsecret');
    });

    it('without pkexec: nothing to run, the exact command to type', () => {
        const plan = installPlan('apt', null);
        expect(plan.run).toBeNull();
        expect(plan.manual).toBe('sudo apt-get install -y gnome-keyring libsecret-1-0');
    });

    it('unknown package manager: nothing to run and no invented command', () => {
        expect(installPlan(null, '/usr/bin/pkexec')).toEqual({ run: null, manual: null, packages: ['gnome-keyring', 'libsecret'] });
    });
});

describe('starting the keyring for this session', () => {
    it('asks D-Bus to activate the Secret Service (the activation file the package installs), daemon as the fallback', () => {
        expect(START_SECRET_SERVICE_ARGV).toEqual(['dbus-send', '--session', '--dest=org.freedesktop.DBus', '--print-reply', '--type=method_call', '/org/freedesktop/DBus', 'org.freedesktop.DBus.StartServiceByName', 'string:org.freedesktop.secrets', 'uint32:0']);
        expect(START_DAEMON_ARGV).toEqual(['gnome-keyring-daemon', '--start', '--components=secrets']);
    });
});

/** A machine in a state, and the commands Genie ran against it; each command may change the state. */
function machine(start: Omit<KeyringFacts, 'platform'>, plan: InstallPlan, effects: Record<string, { code: number; stderr?: string; then?: Partial<KeyringFacts> }> = {}) {
    let facts = { ...start };
    const ran: string[] = [];
    let relaunched = 0;
    let changes = 0;
    const ports: KeyringPorts = {
        platform: 'linux',
        facts: async () => ({ ...facts }),
        plan: async () => plan,
        exec: async (argv) => {
            const key = argv.join(' ');
            ran.push(key);
            const effect = Object.entries(effects).find(([k]) => key.startsWith(k))?.[1] ?? { code: 0 };
            if (effect.then) facts = { ...facts, ...effect.then };
            return { code: effect.code, stderr: effect.stderr ?? '' };
        },
        relaunch: () => { relaunched += 1; },
        onChange: () => { changes += 1; },
    };
    return { ports, ran, relaunched: () => relaunched, changes: () => changes };
}

const NOTHING: Omit<KeyringFacts, 'platform'> = { installed: false, owned: false, activatable: false, backend: 'basic_text', available: false };
const PACMAN = installPlan('pacman', '/usr/bin/pkexec');

describe('LinuxKeyring — the card and its flow', () => {
    it('ready: no card at all', async () => {
        const m = machine(HEALTHY, PACMAN);
        const k = await LinuxKeyring.open(m.ports);
        expect(k.view()).toBeNull();
        expect(k.canKeepSecrets()).toBe(true);
    });

    it('not installed: the card offers Install, says which packages, and shows no step or failure yet', async () => {
        const k = await LinuxKeyring.open(machine(NOTHING, PACMAN).ports);
        expect(k.canKeepSecrets()).toBe(false);
        expect(k.view()).toEqual({ state: 'not-installed', step: null, failure: null, manual: 'sudo pacman -S --needed --noconfirm gnome-keyring libsecret', packages: 'gnome-keyring, libsecret' });
    });

    it('Install → pkexec install → start → keyring answers → restart-needed; every step shown on the way', async () => {
        const m = machine(NOTHING, PACMAN, {
            '/usr/bin/pkexec pacman': { code: 0, then: { installed: true, activatable: true } },
            'dbus-send': { code: 0, then: { owned: true } },
        });
        const k = await LinuxKeyring.open(m.ports);
        const steps: Array<string | null> = [];
        const unsubscribe = k.onChange(() => steps.push(k.view()?.step ?? null));
        await k.fix();
        unsubscribe();
        expect(m.ran).toEqual([PACMAN.run!.join(' '), START_SECRET_SERVICE_ARGV.join(' ')]);
        expect(steps).toContain('installing');
        expect(steps).toContain('starting');
        // Chromium chose the plaintext store when this Genie launched: only a restart picks the keyring up.
        expect(k.view()).toMatchObject({ state: 'restart-needed', step: null, failure: null });
        expect(m.relaunched()).toBe(0);
    });

    it('Restart Genie relaunches (and only when asked)', async () => {
        const m = machine({ ...HEALTHY, backend: 'basic_text', available: false }, PACMAN);
        const k = await LinuxKeyring.open(m.ports);
        expect(k.view()?.state).toBe('restart-needed');
        await k.fix();
        expect(m.relaunched()).toBe(1);
        expect(k.view()?.step).toBe('restarting');
    });

    it('the person dismisses the password prompt (pkexec 126): Cancelled, nothing changed, Retry', async () => {
        const m = machine(NOTHING, PACMAN, { '/usr/bin/pkexec': { code: 126 } });
        const k = await LinuxKeyring.open(m.ports);
        await k.fix();
        expect(k.view()).toMatchObject({ state: 'not-installed', step: null });
        expect(k.view()?.failure).toMatch(/Cancelled/);
        expect(m.ran).toHaveLength(1);
    });

    it('no polkit agent to ask (pkexec 127): says so and shows the command to run', async () => {
        const m = machine(NOTHING, PACMAN, { '/usr/bin/pkexec': { code: 127, stderr: 'Error executing command as another user: No authentication agent found.' } });
        const k = await LinuxKeyring.open(m.ports);
        await k.fix();
        expect(k.view()?.failure).toMatch(/could not ask for your password/i);
        expect(k.view()?.manual).toBe('sudo pacman -S --needed --noconfirm gnome-keyring libsecret');
    });

    it('the package manager fails: its own last words, the command, Retry', async () => {
        const m = machine(NOTHING, PACMAN, { '/usr/bin/pkexec': { code: 1, stderr: 'error: failed to synchronize all databases\nerror: target not found: gnome-keyring' } });
        const k = await LinuxKeyring.open(m.ports);
        await k.fix();
        expect(k.view()?.failure).toMatch(/exit 1/);
        expect(k.view()?.failure).toMatch(/target not found: gnome-keyring/);
        // Retry runs the install again.
        await k.fix();
        expect(m.ran).toHaveLength(2);
    });

    it('no pkexec: nothing is run; the card shows the command to type, and Check again re-reads the machine', async () => {
        const m = machine(NOTHING, installPlan('pacman', null));
        const k = await LinuxKeyring.open(m.ports);
        await k.fix();
        expect(m.ran).toEqual([]);
        expect(k.view()?.failure).toMatch(/terminal/);
        expect(k.view()?.manual).toBe('sudo pacman -S --needed --noconfirm gnome-keyring libsecret');
    });

    it('unknown distro: no command is invented; the packages are named', async () => {
        const m = machine(NOTHING, installPlan(null, '/usr/bin/pkexec'));
        const k = await LinuxKeyring.open(m.ports);
        await k.fix();
        expect(m.ran).toEqual([]);
        expect(k.view()?.manual).toBeNull();
        expect(k.view()?.failure).toMatch(/gnome-keyring/);
    });

    it('installed, not running: Start activates it; D-Bus activation failing falls back to gnome-keyring-daemon --start', async () => {
        const m = machine({ ...NOTHING, installed: true }, PACMAN, {
            'dbus-send': { code: 1, stderr: 'Error org.freedesktop.DBus.Error.ServiceUnknown' },
            'gnome-keyring-daemon': { code: 0, then: { owned: true } },
        });
        const k = await LinuxKeyring.open(m.ports);
        expect(k.view()?.state).toBe('not-running');
        await k.fix();
        expect(m.ran).toEqual([START_SECRET_SERVICE_ARGV.join(' '), START_DAEMON_ARGV.join(' ')]);
        expect(k.view()?.state).toBe('restart-needed');
    });

    it('a keyring that will not start: says so, Retry', async () => {
        const m = machine({ ...NOTHING, installed: true }, PACMAN, { 'dbus-send': { code: 1 }, 'gnome-keyring-daemon': { code: 1, stderr: 'gnome-keyring-daemon: no' } });
        const k = await LinuxKeyring.open(m.ports);
        await k.fix();
        expect(k.view()).toMatchObject({ state: 'not-running', step: null });
        expect(k.view()?.failure).toMatch(/would not start/);
    });

    it('refused (locked): the button re-checks; an unlocked keyring clears the card', async () => {
        const m = machine({ ...HEALTHY, available: false }, PACMAN);
        const k = await LinuxKeyring.open(m.ports);
        expect(k.view()?.state).toBe('refused');
        // The person unlocks it with their system's own prompt; Check again sees it.
        (m.ports as { facts: KeyringPorts['facts'] }).facts = async () => ({ ...HEALTHY });
        await k.fix();
        expect(k.view()).toBeNull();
    });

    it('a click while a step is running starts nothing twice', async () => {
        const gate: { release?: () => void; execs: number } = { execs: 0 };
        const m = machine(NOTHING, PACMAN);
        const slow: KeyringPorts = { ...m.ports, exec: () => new Promise((r) => { gate.execs += 1; gate.release = () => r({ code: 126, stderr: '' }); }) };
        const k = await LinuxKeyring.open(slow);
        const first = k.fix();
        const second = k.fix();
        expect(second).toBe(first);
        while (!gate.release) await new Promise((r) => setTimeout(r, 0));
        expect(k.view()?.step).toBe('installing');
        gate.release();
        await Promise.all([first, second]);
        expect(gate.execs).toBe(1);
        expect(k.view()?.failure).toMatch(/Cancelled/);
    });
});

describe('resume the sign-in after the restart (no secret is written)', () => {
    it('a marker that is taken once', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-keyring-resume-'));
        try {
            expect(takeResumeSignIn(dir)).toBeNull();
            markResumeSignIn(dir, 'tynn');
            const text = fs.readFileSync(path.join(dir, 'keyring-resume.json'), 'utf8');
            // Only which sign-in to reopen — never a code or token.
            expect(JSON.parse(text)).toEqual({ resume: 'tynn' });
            expect(takeResumeSignIn(dir)).toBe('tynn');
            expect(takeResumeSignIn(dir)).toBeNull();
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});

/** The real ports, over an injected runner and filesystem: what main.ts wires (and what the host split reuses). */
import { realKeyringPorts } from '../src/main/linux-keyring.js';

describe('realKeyringPorts — reading the session', () => {
    const enoent = () => Promise.reject(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const base = {
        storage: () => ({ backend: 'basic_text', available: false }),
        relaunch: () => {},
        pathEnv: '/usr/local/bin:/usr/bin',
    };

    it('facts: busctl says activatable, gnome-keyring-daemon on PATH, this process on basic_text', async () => {
        const ports = realKeyringPorts({
            ...base,
            run: async (bin) => (bin === 'busctl' ? { exitCode: 0, stdout: 'org.freedesktop.secrets - - - (activatable) - - -\n', stderr: '' } : enoent()),
            exists: (p) => p === '/usr/bin/gnome-keyring-daemon',
            readFile: () => null,
        });
        expect(await ports.facts()).toEqual({ installed: true, owned: false, activatable: true, backend: 'basic_text', available: false });
    });

    it('facts: no busctl (non-systemd) → dbus-send NameHasOwner; nothing installed', async () => {
        const ports = realKeyringPorts({
            ...base,
            run: async (bin, args) => (bin === 'dbus-send' && args.includes('string:org.freedesktop.secrets') ? { exitCode: 0, stdout: 'method return\n   boolean false\n', stderr: '' } : enoent()),
            exists: () => false,
            readFile: () => null,
        });
        expect(await ports.facts()).toEqual({ installed: false, owned: false, activatable: false, backend: 'basic_text', available: false });
    });

    it('plan: /etc/os-release + pkexec on PATH', async () => {
        const ports = realKeyringPorts({
            ...base,
            run: enoent,
            exists: (p) => p === '/usr/bin/pkexec' || p === '/usr/bin/pacman',
            readFile: (p) => (p === '/etc/os-release' ? 'NAME="Arch Linux"\nID=arch\n' : null),
        });
        expect((await ports.plan()).run).toEqual(['/usr/bin/pkexec', 'pacman', '-S', '--needed', '--noconfirm', 'gnome-keyring', 'libsecret']);
        const noPkexec = realKeyringPorts({ ...base, run: enoent, exists: () => false, readFile: () => 'ID=ubuntu\n' });
        expect(await noPkexec.plan()).toEqual({ run: null, manual: 'sudo apt-get install -y gnome-keyring libsecret-1-0', packages: ['gnome-keyring', 'libsecret-1-0'] });
    });

    it('exec: a missing program is a failed step with its words, never a throw', async () => {
        const ports = realKeyringPorts({ ...base, run: enoent, exists: () => false, readFile: () => null });
        const r = await ports.exec(['pkexec', 'pacman']);
        expect(r.code).not.toBe(0);
        expect(r.code).not.toBe(126);
        expect(r.stderr).toMatch(/ENOENT/);
    });
});
