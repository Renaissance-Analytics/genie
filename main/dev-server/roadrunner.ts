/**
 * PURE. RoadRunner's `rr`, as Genie provides it to Octane sites (genie#668).
 *
 * Octane finds `rr` in the project root or on PATH. With neither, it asks to
 * download one, and `vendor/bin/rr get-binary` writes the binary into the user's
 * repo. Genie installs the pinned release into its own toolchain and puts it
 * first on the site's PATH instead, the way it provides FrankenPHP.
 *
 * Facts below were read off the real v2025.1.15 release, not assumed:
 *   assets roadrunner-2025.1.15-{windows-amd64.zip, linux-amd64.tar.gz,
 *   linux-arm64.tar.gz, darwin-amd64.zip, darwin-arm64.tar.gz} — no Windows
 *   arm64 build, and darwin-amd64 alone is a zip;
 *   each nests `roadrunner-2025.1.15-<os>-<arch>/rr[.exe]`;
 *   `rr --version` → "rr version 2025.1.15 (build time: …)", and on Windows
 *   "rr.exe version 2025.1.15 …". Octane's own version check only recognises the
 *   first spelling, so on Windows it logs "Unable to determine the current
 *   RoadRunner binary version" and carries on — a warning, not a failure.
 */

/** The RoadRunner release Genie installs. Octane requires >= 2023.3.0. */
export const ROADRUNNER_VERSION = '2025.1.15';

export interface RoadrunnerAsset {
    url: string;
    artifact: 'zip' | 'tar.gz';
    /** The archive's top directory, which holds the binary. */
    dir: string;
    /** The executable's file name inside {@link dir}. */
    exe: string;
}

/** The official archive for a machine, or undefined where none is published. */
export function roadrunnerAssetFor(ctx: { os: string; arch?: string }): RoadrunnerAsset | undefined {
    const arm = ctx.arch === 'arm64';
    let os: string;
    let artifact: RoadrunnerAsset['artifact'];
    if (ctx.os === 'win32') {
        if (arm) return undefined;
        os = 'windows';
        artifact = 'zip';
    } else if (ctx.os === 'linux') {
        os = 'linux';
        artifact = 'tar.gz';
    } else if (ctx.os === 'darwin') {
        os = 'darwin';
        artifact = arm ? 'tar.gz' : 'zip';
    } else {
        return undefined;
    }
    const dir = `roadrunner-${ROADRUNNER_VERSION}-${os}-${arm ? 'arm64' : 'amd64'}`;
    return {
        url: `https://github.com/roadrunner-server/roadrunner/releases/download/v${ROADRUNNER_VERSION}/${dir}.${artifact}`,
        artifact,
        dir,
        exe: ctx.os === 'win32' ? 'rr.exe' : 'rr',
    };
}

/** The version `rr --version` reports, or null when it does not say. */
export function parseRoadrunnerVersion(stdout: string): string | null {
    const m = /^rr(?:\.exe)? version (\d+\.\d+\.\d+)/m.exec(stdout);
    return m ? m[1]! : null;
}
