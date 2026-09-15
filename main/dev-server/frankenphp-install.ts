import path from 'path';
import { FRANKENPHP_VERSION, frankenphpAssetFor, parseFrankenphpVersion } from './frankenphp';
import { phpIniContents } from './toolchain-versions';

/**
 * Getting FrankenPHP onto a machine (genie#668).
 *
 * The official binaries are 150–180 MB each, so the one for this machine is
 * downloaded the first time a site needs it rather than shipped three times in
 * every installer. The effects are injected so every branch below is asserted
 * rather than discovered on someone's first start.
 *
 * SUCCESS IS THE BINARY SAYING WHAT IT IS — `frankenphp version` naming the
 * pinned release — never bytes arriving on disk. Anything short of that is torn
 * down and reported with the binary's own output.
 */

export interface FrankenphpInstallEffects {
    exists(file: string): boolean;
    download(url: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
    /** Unpack a zip INTO `dest` (the Windows release is flat). */
    unzip(archive: string, dest: string): Promise<{ ok: true } | { ok: false; error: string }>;
    /** Move a downloaded single binary to `to` and make it executable. */
    placeBinary(from: string, to: string): Promise<void>;
    writeFile(file: string, body: string): Promise<void>;
    /** Stdout of `<exe> version`. Throwing is a binary that did not run. */
    version(exe: string): Promise<string>;
    removeDir(dir: string): Promise<void>;
    /** Install a machine prerequisite if missing. Idempotent. */
    ensurePrerequisite(name: 'vcredist'): Promise<{ ok: boolean; error?: string }>;
    /** A CA bundle file PHP's curl/openssl can use, or null (Windows ships none). */
    caBundle(dir: string): Promise<string | null>;
}

export type FrankenphpResolution =
    | { ok: true; exe: string; phpVersion: string }
    | { ok: false; error: string };

async function readVersion(
    effects: FrankenphpInstallEffects,
    exe: string,
): Promise<{ parsed: ReturnType<typeof parseFrankenphpVersion>; raw: string }> {
    try {
        const raw = await effects.version(exe);
        return { parsed: parseFrankenphpVersion(raw), raw };
    } catch (e) {
        return { parsed: null, raw: e instanceof Error ? e.message : String(e) };
    }
}

export async function ensureFrankenphp(opts: {
    /** The version-keyed install directory. */
    dir: string;
    platform: string;
    arch: string;
    effects: FrankenphpInstallEffects;
}): Promise<FrankenphpResolution> {
    const { dir, platform, arch, effects } = opts;
    const asset = frankenphpAssetFor({ os: platform, arch });
    if (!asset) {
        return {
            ok: false,
            error: `FrankenPHP publishes no binary for ${platform} ${arch}, so Genie cannot serve PHP with it on this machine. Serve the site with the \`php\` mode instead.`,
        };
    }
    const exe = path.join(dir, asset.exe);

    // Already here, and the release Genie pins: use it.
    if (effects.exists(exe)) {
        const { parsed } = await readVersion(effects, exe);
        if (parsed && parsed.frankenphp === FRANKENPHP_VERSION) {
            // The ini is Genie's to keep current — rewritten, not trusted from before.
            if (platform === 'win32') await writeIni(effects, dir);
            return { ok: true, exe, phpVersion: parsed.php };
        }
    }

    // PHP on Windows will not start without the Visual C++ runtime; Genie
    // installs it rather than naming it.
    if (platform === 'win32') {
        const prereq = await effects.ensurePrerequisite('vcredist');
        if (!prereq.ok) {
            return {
                ok: false,
                error: `FrankenPHP needs the Microsoft Visual C++ runtime, and Genie could not install it: ${prereq.error ?? 'unknown error'}`,
            };
        }
    }

    const downloaded = await effects.download(asset.url);
    if (!downloaded.ok) {
        return { ok: false, error: `Could not download FrankenPHP ${FRANKENPHP_VERSION}: ${downloaded.error}` };
    }

    await effects.removeDir(dir);
    if (asset.artifact === 'zip') {
        const unpacked = await effects.unzip(downloaded.path, dir);
        if (!unpacked.ok) {
            await effects.removeDir(dir);
            return { ok: false, error: `Could not unpack FrankenPHP ${FRANKENPHP_VERSION}: ${unpacked.error}` };
        }
        // The Windows zip is an official PHP layout that loads NO php.ini — measured
        // on the real 1.12.7 release: without one, mbstring, openssl and pdo are
        // simply absent. The same ini Genie writes for its own PHP installs.
        await writeIni(effects, dir);
    } else {
        await effects.placeBinary(downloaded.path, exe);
    }

    const { parsed, raw } = await readVersion(effects, exe);
    if (!parsed || parsed.frankenphp !== FRANKENPHP_VERSION) {
        await effects.removeDir(dir);
        return {
            ok: false,
            error: `The downloaded FrankenPHP did not run as ${FRANKENPHP_VERSION}: ${raw.trim().slice(0, 300) || 'no output'}`,
        };
    }
    return { ok: true, exe, phpVersion: parsed.php };
}

async function writeIni(effects: FrankenphpInstallEffects, dir: string): Promise<void> {
    const ca = await effects.caBundle(dir).catch(() => null);
    await effects.writeFile(path.join(dir, 'php.ini'), phpIniContents(dir, 'win32', ca));
}
