import path from 'path';
import { ROADRUNNER_VERSION, parseRoadrunnerVersion, roadrunnerAssetFor } from './roadrunner';

/**
 * Getting RoadRunner's `rr` onto a machine (genie#668).
 *
 * Downloaded the first time an Octane site on RoadRunner needs it, into
 * `<toolchain>/roadrunner/<version>`. SUCCESS IS THE BINARY SAYING WHAT IT IS —
 * `rr --version` naming the pinned release — never bytes arriving on disk.
 * Anything short of that is torn down and reported with the binary's output.
 */

export interface RoadrunnerInstallEffects {
    exists(file: string): boolean;
    download(url: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    /** Unpack an archive INTO `dest`, keeping its top directory. */
    extract(archive: string, artifact: 'zip' | 'tar.gz', dest: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** chmod +x — posix only. */
    makeExecutable(file: string): Promise<void>;
    /** Stdout of `<exe> --version`. Throwing is a binary that did not run. */
    version(exe: string): Promise<string>;
    removeDir(dir: string): Promise<void>;
}

export type RoadrunnerResolution = { ok: true; exe: string } | { ok: false; error: string };

async function readVersion(effects: RoadrunnerInstallEffects, exe: string): Promise<{ version: string | null; raw: string }> {
    try {
        const raw = await effects.version(exe);
        return { version: parseRoadrunnerVersion(raw), raw };
    } catch (e) {
        return { version: null, raw: e instanceof Error ? e.message : String(e) };
    }
}

export async function ensureRoadrunner(opts: {
    /** The version-keyed install directory. */
    dir: string;
    platform: string;
    arch: string;
    effects: RoadrunnerInstallEffects;
}): Promise<RoadrunnerResolution> {
    const { dir, platform, arch, effects } = opts;
    const asset = roadrunnerAssetFor({ os: platform, arch });
    if (!asset) {
        return {
            ok: false,
            error: `RoadRunner publishes no binary for ${platform} ${arch}, so Genie cannot run Octane on RoadRunner on this machine. Use Octane on FrankenPHP instead.`,
        };
    }
    const exe = path.join(dir, asset.dir, asset.exe);

    // Already here, and the release Genie pins: use it.
    if (effects.exists(exe)) {
        const { version } = await readVersion(effects, exe);
        if (version === ROADRUNNER_VERSION) return { ok: true, exe };
    }

    const downloaded = await effects.download(asset.url);
    if (!downloaded.ok) {
        return { ok: false, error: `Could not download RoadRunner ${ROADRUNNER_VERSION}: ${downloaded.error}` };
    }

    await effects.removeDir(dir);
    const unpacked = await effects.extract(downloaded.path, asset.artifact, dir);
    if (!unpacked.ok) {
        await effects.removeDir(dir);
        return { ok: false, error: `Could not unpack RoadRunner ${ROADRUNNER_VERSION}: ${unpacked.error}` };
    }
    if (platform !== 'win32') await effects.makeExecutable(exe);

    const { version, raw } = await readVersion(effects, exe);
    if (version !== ROADRUNNER_VERSION) {
        await effects.removeDir(dir);
        return {
            ok: false,
            error: `The downloaded RoadRunner did not run as ${ROADRUNNER_VERSION}: ${raw.trim().slice(0, 300) || 'no output'}`,
        };
    }
    return { ok: true, exe };
}
