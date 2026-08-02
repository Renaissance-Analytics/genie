import type { ContainerRuntimeKind } from './container-runtime';

/**
 * PURE. The host path of a bind mount, in the notation the chosen runtime wants.
 *
 * This is the one string in the dev server that is not the same on every
 * platform, and getting it wrong fails SILENTLY: the container starts, the mount
 * "succeeds", and `/workspace` is simply an empty directory the runtime created
 * for you. So it is a pure function with a test per (platform, runtime) pair
 * rather than a `path.resolve` at the call site.
 *
 * The three rules:
 *
 *   - **Docker** (Desktop on Windows/macOS, Engine on Linux) takes the host path
 *     as the host writes it. Windows backslashes work, but a backslash inside a
 *     `--mount source=` value is an escape hazard in every log line, error
 *     message and shell command the user will paste it into — so it is
 *     normalised to forward slashes once, here.
 *   - **Podman on Windows** runs the containers inside `podman machine`, a Linux
 *     VM in WSL where the host drives appear under `/mnt/<drive>`. A `C:/...`
 *     source is resolved INSIDE that VM, where it does not exist. This is the
 *     translation that makes podman work at all on Windows.
 *   - **UNC paths** (`\\nas\share\proj`) cannot be bind-mounted by either
 *     runtime. Returning `null` lets the sandbox say so; passing it through
 *     produces an empty mount and a workspace that looks corrupt.
 *
 * Returns `null` for anything unusable, in the house style — the caller turns
 * that into a status the user can act on rather than an exception.
 */

export interface MountSourceOptions {
    platform: NodeJS.Platform | string;
    kind: ContainerRuntimeKind;
}

/**
 * Characters a `--mount type=bind,source=…,target=…` value cannot carry.
 *
 * `--mount` is comma/equals delimited, so either character in a path would be
 * read as the start of another mount option. Both are legal in a Linux directory
 * name, so this is CHECKED rather than assumed.
 *
 * The alternative form, `-v source:target`, breaks on the Windows drive colon
 * instead — which is not an edge case, it is every Windows path. `--mount` plus
 * this check is the pairing with the smaller failure surface.
 */
const UNMOUNTABLE_CHARS = /[,=]/;

/** `C:` / `C:/rest`, after separators are normalised. */
const WINDOWS_DRIVE = /^([A-Za-z]):(\/.*)?$/;

/** Drop trailing separators, but never reduce a root to nothing. */
function trimTrailing(p: string): string {
    if (p.length <= 1) return p;
    return p.replace(/\/+$/, '') || '/';
}

export function toMountSource(hostPath: string, opts: MountSourceOptions): string | null {
    const raw = String(hostPath ?? '').trim();
    if (!raw) return null;

    const normalised = raw.replace(/\\/g, '/');
    // `//server/share` — a UNC path, whichever way it was written.
    if (normalised.startsWith('//')) return null;

    let source: string;
    if (opts.platform === 'win32') {
        const drive = WINDOWS_DRIVE.exec(normalised);
        // A bare `/foo` on Windows is drive-RELATIVE, so it is not an absolute
        // path and must not be mounted as if it were.
        if (!drive) return null;
        const rest = trimTrailing(drive[2] || '/');
        source =
            opts.kind === 'podman'
                ? `/mnt/${drive[1].toLowerCase()}${rest === '/' ? '' : rest}`
                : `${drive[1].toUpperCase()}:${rest}`;
    } else {
        if (!normalised.startsWith('/')) return null;
        source = trimTrailing(normalised);
    }

    return UNMOUNTABLE_CHARS.test(source) ? null : source;
}
