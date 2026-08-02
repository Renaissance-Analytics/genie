/**
 * The invoking user's POSIX uid/gid — the half of "files written in a container
 * stay editable by their owner" that Genie can supply.
 *
 * The dev image's entrypoint renumbers its `genie` user to `HOST_UID`/`HOST_GID`
 * (see `dev-base/README.md`), so everything a dev server writes into the
 * bind-mounted workspace — a `node_modules`, a build output, a `composer.lock` —
 * comes out owned by the person who owns the workspace instead of by root.
 *
 * Returns `null` where the concept does not exist:
 *
 *   - **Windows** has no uid at all, and Docker Desktop's virtiofs bridge
 *     already presents the mount as the user.
 *   - **macOS** has one, but Docker Desktop's VM does the same translation, and
 *     forcing the host's uid inside the Linux VM breaks more than it fixes.
 *
 * Passing `null` through rather than defaulting to `1000` is deliberate: a wrong
 * uid is worse than none, because the entrypoint would renumber to a user that
 * owns nothing.
 */
export interface HostIds {
    uid: number;
    gid: number;
}

export function detectHostIds(platform: NodeJS.Platform | string = process.platform): HostIds | null {
    if (platform !== 'linux' && platform !== 'freebsd' && platform !== 'openbsd') return null;
    // `getuid`/`getgid` exist only on POSIX, and are absent even there when Node
    // is built without them — hence the optional call rather than a cast.
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (typeof uid !== 'number' || typeof gid !== 'number') return null;
    return { uid, gid };
}
