import { describe, it, expect } from 'vitest';
import {
    SECRET_SERVICE_NAME,
    chooseLinuxPasswordStore,
    classifyKeychainFault,
    keychainUnavailableHint,
    parseBusctlNames,
    parseDbusSendBoolean,
    passwordStoreBusNames,
    probeOwnedBusNames,
    switchValueForSelectedBackend,
} from '../linux-password-store';

/**
 * genie#379 — "OS keychain unavailable — install gnome-keyring / libsecret" on a
 * machine where BOTH are installed, gnome-keyring-daemon is running, and `gh`
 * stores its own token in that same keyring.
 *
 * The real cause is `XDG_CURRENT_DESKTOP=Hyprland`: Chromium's password-store
 * auto-detection knows GNOME, KDE and a short list of others, and falls back to
 * the plaintext `basic` store on anything else — so Electron's safeStorage
 * correctly reports encryption unavailable and Genie correctly refuses to write
 * a token. Every layer behaves; the backend was simply never selected.
 *
 * So Genie selects it: if something owns `org.freedesktop.secrets` on the
 * session bus, that is a far better signal than sniffing a desktop name.
 */

/** The bus names a Hyprland + gnome-keyring session actually publishes. */
const HYPRLAND_BUS = ['org.freedesktop.secrets', 'org.freedesktop.portal.Desktop'];

describe('chooseLinuxPasswordStore', () => {
    it('selects gnome-libsecret when the session bus HAS a secret service', () => {
        expect(
            chooseLinuxPasswordStore({
                platform: 'linux',
                argv: ['/usr/bin/genie'],
                ownedBusNames: HYPRLAND_BUS,
            }),
        ).toBe('gnome-libsecret');
    });

    it('selects nothing when NOTHING owns the secret service', () => {
        // Genie must not force a backend that is not there — that would turn a
        // clear "no keyring on this session" into a confusing failure.
        expect(
            chooseLinuxPasswordStore({
                platform: 'linux',
                argv: [],
                ownedBusNames: ['org.freedesktop.portal.Desktop'],
            }),
        ).toBeNull();
    });

    it('prefers the native KWallet backend when KWallet owns the bus name', () => {
        expect(
            chooseLinuxPasswordStore({
                platform: 'linux',
                argv: [],
                ownedBusNames: ['org.kde.kwalletd6', 'org.freedesktop.secrets'],
            }),
        ).toBe('kwallet6');
        expect(
            chooseLinuxPasswordStore({
                platform: 'linux',
                argv: [],
                ownedBusNames: ['org.kde.kwalletd5', 'org.freedesktop.secrets'],
            }),
        ).toBe('kwallet5');
    });

    it('never overrides a --password-store the user (or a .desktop file) passed', () => {
        for (const argv of [
            ['/usr/bin/genie', '--password-store=basic'],
            ['/usr/bin/genie', '--password-store', 'kwallet6'],
        ]) {
            expect(
                chooseLinuxPasswordStore({ platform: 'linux', argv, ownedBusNames: HYPRLAND_BUS }),
            ).toBeNull();
        }
        // Positive control: the SAME bus state with no such flag does select one,
        // so the nulls above are the override being respected, not a dead probe.
        expect(
            chooseLinuxPasswordStore({
                platform: 'linux',
                argv: ['/usr/bin/genie'],
                ownedBusNames: HYPRLAND_BUS,
            }),
        ).toBe('gnome-libsecret');
    });

    it('is Linux-only — Windows and macOS have their own keystores', () => {
        for (const platform of ['win32', 'darwin'] as const) {
            expect(
                chooseLinuxPasswordStore({ platform, argv: [], ownedBusNames: HYPRLAND_BUS }),
            ).toBeNull();
        }
    });
});

/**
 * genie#588 — the probe was the ONLY thing selecting a backend, and it is the
 * one impure part of this module. On the reporting machine the keyring is
 * provably healthy (busctl shows the default collection unlocked, secret-tool
 * round-trips, gh keeps its token there) and Genie still lands on the plaintext
 * store on every self-restart — so on that machine the probe finds nothing,
 * whatever the reason, and there is no second opinion.
 *
 * The second opinion is what Electron itself reported on a launch that worked.
 */
describe('chooseLinuxPasswordStore — the remembered backend (genie#588)', () => {
    /** A self-restarted process: no argv flag (electron-updater re-execs the
     *  AppImage with an EMPTY argv), and a probe that came back empty. */
    const RESTARTED = { platform: 'linux' as const, argv: ['/tmp/.mount_Genie/genie'], ownedBusNames: [] };

    it('falls back to the backend that worked last time when the probe finds nothing', () => {
        expect(chooseLinuxPasswordStore({ ...RESTARTED, remembered: 'gnome-libsecret' })).toBe(
            'gnome-libsecret',
        );
        // Negative control: WITHOUT the memo the same launch selects nothing —
        // which is the bug, and proves the memo is what is doing the work here.
        expect(chooseLinuxPasswordStore({ ...RESTARTED, remembered: null })).toBeNull();
    });

    it('lets a live probe overrule a stale memo — the session bus is the truth', () => {
        // Moved from GNOME to KDE: the memo says libsecret, the bus says kwallet.
        expect(
            chooseLinuxPasswordStore({
                platform: 'linux',
                argv: [],
                ownedBusNames: ['org.kde.kwalletd6', SECRET_SERVICE_NAME],
                remembered: 'gnome-libsecret',
            }),
        ).toBe('kwallet6');
    });

    it('still lets an explicit --password-store win over the memo', () => {
        expect(
            chooseLinuxPasswordStore({
                platform: 'linux',
                argv: ['/usr/bin/genie', '--password-store=basic'],
                ownedBusNames: [],
                remembered: 'gnome-libsecret',
            }),
        ).toBeNull();
    });

    it('ignores a memo naming a store Chromium does not know', () => {
        // A value off disk reaches Chromium's command line; an unknown one makes
        // it log "Unknown password store" and fall back to plaintext anyway.
        expect(chooseLinuxPasswordStore({ ...RESTARTED, remembered: 'gnome-libsecret; rm -rf' })).toBeNull();
        expect(chooseLinuxPasswordStore({ ...RESTARTED, remembered: 'basic_text' })).toBeNull();
    });

    it('is still Linux-only, memo or not', () => {
        expect(
            chooseLinuxPasswordStore({
                platform: 'win32',
                argv: [],
                ownedBusNames: [],
                remembered: 'gnome-libsecret',
            }),
        ).toBeNull();
    });
});

describe('switchValueForSelectedBackend — Electron reports it one way, Chromium takes it another', () => {
    it('maps every backend Electron can report to its --password-store value', () => {
        expect(switchValueForSelectedBackend('gnome_libsecret')).toBe('gnome-libsecret');
        expect(switchValueForSelectedBackend('kwallet')).toBe('kwallet');
        expect(switchValueForSelectedBackend('kwallet5')).toBe('kwallet5');
        expect(switchValueForSelectedBackend('kwallet6')).toBe('kwallet6');
    });

    it('maps the "nothing was selected" reports to null', () => {
        // `basic_text` is the FAILURE this whole module exists to prevent, and
        // `unknown` only means we asked before app-ready. Neither is worth
        // remembering, and writing either one down would make the bug sticky.
        expect(switchValueForSelectedBackend('basic_text')).toBeNull();
        expect(switchValueForSelectedBackend('unknown')).toBeNull();
        expect(switchValueForSelectedBackend(null)).toBeNull();
        expect(switchValueForSelectedBackend(undefined)).toBeNull();
        expect(switchValueForSelectedBackend('something-new')).toBeNull();
    });
});

/**
 * genie#588 ask 3: "Do not report 'this computer's keychain is unavailable' when
 * the process simply lacks a backend flag." Three faults wear the same face —
 * `safeStorage.isEncryptionAvailable()` is false — and they have three different
 * remedies, one of which is not the user's problem at all.
 */
describe('classifyKeychainFault', () => {
    it('separates "no service on the bus" from "Genie is on the plaintext store"', () => {
        expect(
            classifyKeychainFault({
                platform: 'linux',
                desktop: 'Hyprland:GNOME',
                secretServiceOwned: false,
                selectedBackend: 'basic_text',
            }),
        ).toBe('no-service');
        expect(
            classifyKeychainFault({
                platform: 'linux',
                desktop: 'Hyprland:GNOME',
                secretServiceOwned: true,
                selectedBackend: 'basic_text',
            }),
        ).toBe('not-selected');
    });

    it('separates "no backend selected" from "backend selected and it REFUSED"', () => {
        // The reported machine: gnome-libsecret is in use and encryption is
        // still unavailable would be a real keyring fault (a locked collection),
        // and must not be described as a store Genie failed to pick.
        expect(
            classifyKeychainFault({
                platform: 'linux',
                desktop: 'Hyprland:GNOME',
                secretServiceOwned: true,
                selectedBackend: 'gnome_libsecret',
            }),
        ).toBe('refused');
    });

    it('treats a missing/unknown backend report as "not selected", not as a refusal', () => {
        for (const selectedBackend of [null, 'unknown']) {
            expect(
                classifyKeychainFault({
                    platform: 'linux',
                    desktop: 'sway',
                    secretServiceOwned: true,
                    selectedBackend,
                }),
            ).toBe('not-selected');
        }
    });

    it('is not a Linux diagnosis off Linux', () => {
        expect(
            classifyKeychainFault({
                platform: 'darwin',
                desktop: undefined,
                secretServiceOwned: false,
                selectedBackend: null,
            }),
        ).toBe('not-linux');
    });
});

describe('parseBusctlNames', () => {
    it('takes the NAME column off `busctl --user list --no-legend`', () => {
        const stdout = [
            'org.freedesktop.DBus            1 systemd  glenn :1.0  init.scope -    -',
            'org.freedesktop.secrets       812 gnome-ke glenn :1.42 -          -    -',
            ':1.42                         812 gnome-ke glenn :1.42 -          -    -',
            '',
        ].join('\n');
        const names = parseBusctlNames(stdout);
        expect(names).toContain(SECRET_SERVICE_NAME);
        // Unique connection names are not service names — they must not be
        // mistaken for one.
        expect(names).not.toContain(':1.42');
    });

    it('returns [] for empty or unparseable output', () => {
        expect(parseBusctlNames('')).toEqual([]);
        expect(parseBusctlNames('   \n  \n')).toEqual([]);
    });
});

describe('parseDbusSendBoolean', () => {
    it('reads the NameHasOwner reply', () => {
        expect(parseDbusSendBoolean('method return time=1.2 sender=org.freedesktop.DBus …\n   boolean true\n')).toBe(
            true,
        );
        expect(parseDbusSendBoolean('method return …\n   boolean false\n')).toBe(false);
        expect(parseDbusSendBoolean('')).toBe(false);
    });
});

describe('keychainUnavailableHint — say what is ACTUALLY wrong (genie#379)', () => {
    it('does NOT blame missing packages when the secret service is running', () => {
        const hint = keychainUnavailableHint({
            platform: 'linux',
            desktop: 'Hyprland',
            secretServiceOwned: true,
            selectedBackend: 'basic',
        });
        expect(hint).not.toMatch(/install/i);
        expect(hint).not.toMatch(/gnome-keyring/);
        // It names the real situation instead: a live secret service that the
        // running process is not using.
        expect(hint).toMatch(/Hyprland/);
        expect(hint).toMatch(/plain ?text|basic/i);
        expect(hint).toMatch(/restart/i);
    });

    it('DOES point at a keyring when nothing owns the secret service', () => {
        const hint = keychainUnavailableHint({
            platform: 'linux',
            desktop: 'Hyprland',
            secretServiceOwned: false,
            selectedBackend: 'basic',
        });
        expect(hint).toMatch(/gnome-keyring|KWallet/);
        // …and says how it knows, so the user can check the same thing.
        expect(hint).toContain(SECRET_SERVICE_NAME);
    });

    it('does NOT tell the user to restart when the backend WAS selected and refused (genie#588)', () => {
        // Same "encryption unavailable", different fault: gnome-libsecret is in
        // use, so the remedy is the keyring (a locked collection), not a
        // relaunch that would select exactly the same backend again.
        const refused = keychainUnavailableHint({
            platform: 'linux',
            desktop: 'Hyprland:GNOME',
            secretServiceOwned: true,
            selectedBackend: 'gnome_libsecret',
        });
        const notSelected = keychainUnavailableHint({
            platform: 'linux',
            desktop: 'Hyprland:GNOME',
            secretServiceOwned: true,
            selectedBackend: 'basic_text',
        });
        // The two must not be the same sentence — that conflation is the bug.
        expect(refused).not.toBe(notSelected);
        expect(refused).toContain('gnome_libsecret');
        expect(refused).toMatch(/unlock|locked/i);
        expect(refused).not.toMatch(/restart Genie/i);
        // And the not-selected one still names the store it is stuck on.
        expect(notSelected).toContain('basic_text');
    });

    it('says something sane off Linux rather than Linux package advice', () => {
        const hint = keychainUnavailableHint({
            platform: 'win32',
            desktop: undefined,
            secretServiceOwned: false,
            selectedBackend: null,
        });
        expect(hint).not.toMatch(/gnome-keyring|libsecret|org\.freedesktop/);
        expect(hint.length).toBeGreaterThan(10);
    });
});

describe('probeOwnedBusNames — boot must not wait on a dead bus', () => {
    const BUSCTL_OK = [
        'org.freedesktop.DBus     1 systemd  glenn :1.0  init.scope - -',
        'org.freedesktop.secrets 812 gnome-ke glenn :1.42 -          - -',
    ].join('\n');

    it('answers for every name in ONE busctl call', () => {
        const calls: string[][] = [];
        const owned = probeOwnedBusNames(passwordStoreBusNames(), (cmd, args) => {
            calls.push([cmd, ...args]);
            return BUSCTL_OK;
        });
        expect(owned).toEqual([SECRET_SERVICE_NAME]);
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('busctl');
    });

    it('falls back to dbus-send and STOPS at the first owned name', () => {
        const asked: string[] = [];
        const owned = probeOwnedBusNames(['org.kde.kwalletd6', SECRET_SERVICE_NAME, 'org.x.later'], (cmd, args) => {
            if (cmd === 'busctl') throw Object.assign(new Error('spawn busctl ENOENT'), { code: 'ENOENT' });
            asked.push(args[args.length - 1]);
            return args[args.length - 1].includes('secrets')
                ? 'method return …\n   boolean true\n'
                : 'method return …\n   boolean false\n';
        });
        expect(owned).toEqual([SECRET_SERVICE_NAME]);
        // Asked for kwallet, then secrets, and then stopped — `org.x.later`
        // was never asked for.
        expect(asked).toEqual(['string:org.kde.kwalletd6', `string:${SECRET_SERVICE_NAME}`]);
    });

    it('gives up immediately when neither tool is installed', () => {
        let calls = 0;
        const owned = probeOwnedBusNames(passwordStoreBusNames(), () => {
            calls += 1;
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });
        expect(owned).toEqual([]);
        // busctl once, dbus-send once — NOT once per name.
        expect(calls).toBe(2);
    });

    it('treats a hung / refusing bus as "nothing owned" rather than throwing', () => {
        expect(() =>
            probeOwnedBusNames([SECRET_SERVICE_NAME], () => {
                throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
            }),
        ).not.toThrow();
        expect(
            probeOwnedBusNames([SECRET_SERVICE_NAME], () => {
                throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
            }),
        ).toEqual([]);
    });
});
