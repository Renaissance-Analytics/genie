/**
 * UPDATE CHANNELS — the owner, 2026-10-12: "stable and dev update channels".
 *
 * Two channels, and each is a PAIR with how a release is published:
 *
 * - **dev** sees every build, prereleases included. A tag with a prerelease suffix
 *   (`v2.0.0-beta.20`) publishes as a GitHub prerelease, and only an updater with
 *   `allowPrerelease: true` can see it.
 * - **stable** sees full releases only. A plain tag (`v2.0.0`) publishes as a full release
 *   (`.github/workflows/release.yml` overrides electron-builder.yml's `releaseType: prerelease`
 *   default for it), and an updater with `allowPrerelease: false` sees exactly those.
 *
 * `releaseTypeForTag` states the publish half in code so `test/update-channels.test.ts` can hold
 * the workflow's shell `case` to it; `updaterConfigFor` is the updater half.
 *
 * The setting was `beta | stable` with nothing reading it; `beta` is the dev channel by its old
 * name, and a stored or v1-carried `beta` is MIGRATED to `dev`, never rejected.
 */

export type UpdateChannel = 'stable' | 'dev';

/**
 * The default is DEV, deliberately. Every release Genie has published so far is a prerelease, so
 * a stable default would offer nothing at all — §0.8 again ("the updater could never see a
 * release"), chosen this time instead of forgotten.
 */
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'dev';

/** Old names for a channel. `beta` is what v1 and the setting before 2026-10-12 stored. */
export const LEGACY_CHANNEL_NAMES: Readonly<Record<string, UpdateChannel>> = { beta: 'dev' };

/** Any stored, carried or remote value, read as a channel. Unknown → the default, never a throw. */
export function channelFrom(value: unknown): UpdateChannel {
    if (value === 'stable' || value === 'dev') return value;
    if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_CHANNEL_NAMES, value)) return LEGACY_CHANNEL_NAMES[value]!;
    return DEFAULT_UPDATE_CHANNEL;
}

/** What `electron-updater` is told for a channel. */
export function updaterConfigFor(channel: UpdateChannel): { allowPrerelease: boolean; autoDownload: false } {
    return {
        /**
         * Dev sees prereleases; stable does not.
         *
         * This defaults to FALSE in `electron-updater`, and the previous build never set it while
         * publishing only prereleases — every release it ever shipped was invisible to its own
         * updater (§0.8). On the stable channel `false` is now a CHOICE, paired with full releases.
         */
        allowPrerelease: channel === 'dev',
        /**
         * Never download before a human has said yes — on either channel.
         *
         * An update that downloads itself is an update that applies on next quit, which on a
         * machine running a dozen agents is a surprise rather than a convenience.
         */
        autoDownload: false,
    };
}

/**
 * How a tag publishes: a semver prerelease suffix (`-beta.20`, `-rc.1`) → a GitHub prerelease,
 * which only the dev channel sees; a plain version → a full release, which both channels see.
 * The workflow's `case "$tag" in *-*)` is this function in shell.
 */
export function releaseTypeForTag(tag: string): 'release' | 'prerelease' {
    const version = tag.startsWith('v') ? tag.slice(1) : tag;
    return version.includes('-') ? 'prerelease' : 'release';
}
