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
 * PURE, so both branches are unit-tested without an AppImage.
 */

export interface RelaunchInput {
    platform: NodeJS.Platform;
    env: Record<string, string | undefined>;
    /** `process.argv` — argv[0] is the executable. */
    argv: string[];
    execPath: string;
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
    const appImage = input.platform === 'linux' ? input.env.APPIMAGE?.trim() : undefined;
    return appImage ? { execPath: appImage, args } : { args };
}
