import { describe, it, expect } from 'vitest';
import {
    SECRET_SERVICE_NAME,
    chooseLinuxPasswordStore,
    keychainUnavailableHint,
    parseBusctlNames,
    parseDbusSendBoolean,
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
