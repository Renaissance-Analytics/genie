/**
 * How Genie relaunches ITSELF (genie#379, part 2).
 *
 * Two things went wrong on the reporting Omarchy machine:
 *
 *  1. A self-restart dropped every launch flag. The `.desktop` file still
 *     carried `--password-store=gnome-libsecret`, so the configuration looked
 *     correct while the running process contradicted it — and secrets written
 *     under `gnome-libsecret` cannot be decrypted by the `basic` store, so a
 *     GitHub token appeared to vanish after a restart.
 *  2. On an AppImage, `process.execPath` is inside the temporary `/tmp/.mount_*`
 *     squashfs, which is unmounted when this process exits. `$APPIMAGE` is the
 *     durable path, and it is the one to relaunch.
 *
 * genie#588 added a third: carrying argv forward only preserves a flag that is
 * still THERE. Genie's relaunches are not the only ones — an update re-execs
 * through electron-updater, whose AppImage install spawns the new binary with an
 * EMPTY argv — so once a `--password-store` is lost it stays lost, and every
 * relaunch after that faithfully carries nothing. When Genie knows which backend
 * this machine uses (see ./secrets/password-store-memo.ts), it puts the flag
 * back rather than propagating the loss.
 *
 * PURE, so all of it is unit-tested without an AppImage.
 */
import { hasPasswordStoreArg, isRememberablePasswordStore } from './secrets/linux-password-store';

export interface RelaunchInput {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    /** `process.argv` — argv[0] is the executable. */
    argv: string[];
    execPath: string;
    /** The `--password-store` value Genie has seen working here, when there is
     *  one. Re-asserted only when argv carries no choice of its own. */
    passwordStore?: string | null;
}

export interface RelaunchOptions {
    /** Set only when it must differ from Electron's own `process.execPath`. */
    execPath?: string;
    args: string[];
}

/**
 * Arguments that describe THIS launch and must not be replayed into the next:
 *  - `--autostart` means "the OS started me at sign-in" (see autostart.ts), and
 *    carrying it forward would make a user-triggered restart come back hidden.
 *  - a `genie://` URL is a one-shot protocol activation (an auth callback).
 */
function isOneShotArg(arg: string): boolean {
    return arg === '--autostart' || /^genie:\/\//i.test(arg);
}

/**
 * The `app.relaunch()` options that bring this process's OWN launch flags
 * forward. Electron's default already reuses argv, but not on an AppImage,
 * where the default `execPath` points at a mount that is about to disappear.
 */
export function relaunchOptions(input: RelaunchInput): RelaunchOptions {
    const args = input.argv.slice(1).filter((a) => !isOneShotArg(a));
    // Put back a keychain backend an earlier re-exec dropped — but never over a
    // choice this launch was actually given, which is the user's.
    if (
        input.platform === 'linux' &&
        !hasPasswordStoreArg(args) &&
        isRememberablePasswordStore(input.passwordStore)
    ) {
        args.push(`--password-store=${input.passwordStore}`);
    }
    const appImage = input.platform === 'linux' ? input.env.APPIMAGE?.trim() : undefined;
    return appImage ? { execPath: appImage, args } : { args };
}
