import path from 'node:path';
import { DebugLogger } from 'builder-util';
import type { Configuration } from 'app-builder-lib';
import { getConfig, validateConfiguration } from 'app-builder-lib/out/util/config/config';
import { appimageChecksums } from 'app-builder-lib/out/toolsets/linux';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The Linux AppImage must NOT be built on the legacy FUSE 2 runtime.
 *
 * An AppImage is a self-mounting archive: the runtime stub prepended to the
 * payload has to mount it before a single line of Genie runs. The legacy stub
 * does that by `dlopen`ing `libfuse.so.2`, and modern Arch-based distros ship
 * FUSE 3 only — on Omarchy 4.0.2 there is no `/usr/lib/libfuse.so.2*` at all,
 * so our AppImage died on its first instruction with:
 *
 *     dlopen(): error loading libfuse.so.2
 *     AppImages require FUSE to run.
 *
 * That same build, unpacked (`--appimage-extract` then `./squashfs-root/AppRun`),
 * reached Chromium display init on that machine. Genie was never the problem;
 * only the launcher wrapped around it, which could not start.
 *
 * app-builder-lib picks the runtime from ONE value — `toolsets.appimage` — and
 * the default is the legacy one, so a FUSE 2 build is what you get by saying
 * nothing. That is the failure-that-reports-success shape this repo already
 * treats as worse than a hard stop: the build goes green either way, the
 * release publishes, and the first to discover the AppImage cannot start is a
 * user on a FUSE 3 distro. Nobody building on Ubuntu CI would ever see it,
 * which is why it is asserted here rather than left for a human to notice.
 *
 * These checks drive the INSTALLED app-builder-lib — its real config loader,
 * its real validator, its real toolset table — instead of restating what it
 * does. A dependency bump that renames the key, drops the pinned bundle, or
 * changes the branch condition fails here, not six minutes into a release job.
 */

const root = path.resolve(__dirname, '..', '..');

let config: Configuration;

beforeAll(async () => {
    // The loader electron-builder itself uses, so this is the effective config
    // (electron-builder.yml merged with any `build` key), not a re-parse of it.
    config = await getConfig(root, null, null);
});

/**
 * The exact branch condition from `AppImageTarget.js` in app-builder-lib
 * 26.15.3: `appimageTool == null || appimageTool === "0.0.0"` calls
 * `buildLegacyFuse2AppImage()`; anything else calls
 * `buildStaticRuntimeAppImage()`.
 */
const selectsLegacyFuse2 = (appimage: string | null | undefined) =>
    appimage == null || appimage === '0.0.0';

describe('AppImage runtime toolset', () => {
    it('builds on a static runtime, not the FUSE 2 one users cannot launch', () => {
        expect(selectsLegacyFuse2(config.toolsets?.appimage)).toBe(false);
    });

    it('pins a bundle the INSTALLED app-builder-lib can actually fetch', () => {
        // getAppImageTools() indexes `appimageChecksums[version]` and throws on
        // an unknown one — on the Linux runner, mid-release. A typo, or a
        // version retired by a dependency bump, fails here instead.
        expect(Object.keys(appimageChecksums)).toContain(config.toolsets?.appimage);
    });

    it('passes electron-builder’s own schema validation', () => {
        // `toolsets` is read from the ROOT config (`packager.config.toolsets`),
        // so it must not drift into the `linux:` block despite only affecting
        // the AppImage. The schema marks LinuxConfiguration
        // `additionalProperties: false`, so this catches that move with a clear
        // message — and the first assertion catches it regardless, since a
        // nested key leaves the root value undefined and re-selects FUSE 2.
        return expect(validateConfiguration(config, new DebugLogger(false))).resolves.toBeUndefined();
    });

    it('still targets AppImage at all — the premise of every check above', () => {
        // A negative assertion passes just as well on a corpse: if the Linux
        // target were dropped or renamed, everything above would go green while
        // shipping nothing.
        expect(config.linux?.target).toContain('AppImage');
    });
});
