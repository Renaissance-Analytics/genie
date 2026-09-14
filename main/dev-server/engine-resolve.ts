import {
    LANGUAGE_LABELS,
    SOURCE_LABELS,
    compareVersionsDesc,
    defaultVersionFor,
    engineBinFileName,
    enginePrimaryBin,
    joinFor,
    selectableInstalls,
    type EngineInstall,
    type LanguageTool,
    type ToolchainDefaults,
} from './toolchain-versions';
import { pickComposerPhp, type ComposerPhp } from './composer-php';

/**
 * PURE. WHICH runtime a site spawns — the half of the Toolchain page that was
 * missing (genie#207).
 *
 * The page already installs PHPs into `<userData>/toolchain/<lang>/<version>`,
 * lets a machine hold several, and lets one be the DEFAULT. Nothing read that at
 * spawn time: `serve-config.ts` handed back a bare `php-cgi` and PATH decided. On
 * the reporting machine PATH held only Herd's `php.bat` shim — the real
 * `php-cgi.exe` was one directory down in `bin/php84` — so the FastCGI worker
 * died the instant it started while the card said "Serving." (genie#206). A UI
 * that promises a choice it does not make is a bug, not a missing feature.
 *
 * ## The order, and why there is no fourth step
 *
 *   1. the site's PIN, when it has one;
 *   2. otherwise what the REPO requires (genie#668) — its `composer.json`, read
 *      as the machine default when that satisfies it, else the newest managed
 *      version that does, else a failure naming the requirement;
 *   3. otherwise the MACHINE DEFAULT (`defaultVersionFor`, which already drops a
 *      stale default rather than pointing at something that was removed);
 *   4. otherwise FAIL, naming what to install.
 *
 * There is deliberately no "…or whatever PATH says", and no "…or the default"
 * after a requirement nothing satisfies. A site quietly running on a
 * different runtime than the one it names is the failure this whole feature
 * exists to prevent — it produces a bug report about the APP, days later, from
 * someone with no reason to suspect the PHP version.
 *
 * ## Only Genie's own installs are selectable
 *
 * Herd/XAMPP/nvm installs are detected for AWARENESS and never resolved to. A
 * runtime another app can upgrade, reconfigure or uninstall underneath a running
 * site is not one a site can depend on — see `.ai/design/genie-toolchain-page.md`
 * (the owner's decision) and `toolchain-versions.ts`. They still appear in the
 * failure text, because "but I HAVE php installed" is the first thing anyone
 * seeing that failure thinks.
 */

export type EngineResolution =
    | { ok: true; install: EngineInstall; exe: string; version: string }
    | { ok: false; error: string };

export interface ResolveEngineOptions {
    tool: LanguageTool;
    /** Which binary inside the install to spawn — `php-cgi` for the FastCGI
     *  worker. Defaults to the language's primary binary. */
    bin?: string;
    /** The site's pinned version. Absent ⇒ what the repo requires, else the machine default. */
    pinned?: string;
    /** What the repo's own manifest requires (`composer.json`), when it says. */
    requires?: ComposerPhp;
    /** Everything on the machine, from `scanToolchain`. */
    installs: EngineInstall[];
    defaults: ToolchainDefaults;
    platform: string;
}

/** The directory the install's binaries actually sit in. NOT `install.dir`: that
 *  is the version directory Remove deletes, and a posix tarball puts the
 *  executables in its `bin/` subdirectory. Companions sit beside the exe. */
function binDirOf(install: EngineInstall): string {
    const cut = Math.max(install.exe.lastIndexOf('\\'), install.exe.lastIndexOf('/'));
    return cut > 0 ? install.exe.slice(0, cut) : install.dir;
}

/**
 * Does an install satisfy this pin?
 *
 * An exact version wins. Otherwise the pin is read as a LINE — `8.3` means the
 * newest 8.3.x, `24` means the newest Node 24 — because that is how humans and
 * agents write a version, while the installs carry the full patch (`8.3.33`).
 * The boundary is a dot, so `8.3` never matches `8.30`.
 */
function satisfiesPin(version: string, pinned: string): boolean {
    return version === pinned || version.startsWith(`${pinned}.`);
}

/** What else is on the machine, said once, so the failure answers "but I have
 *  PHP installed" instead of provoking it. */
function foreignNote(tool: LanguageTool, installs: EngineInstall[]): string {
    const others = installs.filter((i) => i.tool === tool && i.source !== 'genie');
    if (others.length === 0) return '';
    const named = others
        .slice(0, 3)
        .map((i) => `${SOURCE_LABELS[i.source]} ${i.version}`)
        .join(', ');
    return ` This machine also has ${named}, which Genie does not manage — a runtime another app can upgrade or remove underneath a running site cannot be one a site depends on.`;
}

const WHERE = 'Settings → Toolchain → Languages';

export function resolveEngineExe(opts: ResolveEngineOptions): EngineResolution {
    const { tool, installs, defaults, platform } = opts;
    const label = LANGUAGE_LABELS[tool];
    const bin = opts.bin ?? enginePrimaryBin(tool);
    const fileName = engineBinFileName(tool, bin, platform);
    if (!fileName) {
        return { ok: false, error: `Genie does not manage a ${JSON.stringify(bin)} binary for ${label}.` };
    }

    const mine = selectableInstalls(installs.filter((i) => i.tool === tool));

    if (!opts.pinned && opts.requires) {
        const { constraint, source } = opts.requires;
        const picked = pickComposerPhp(
            constraint,
            mine.map((i) => i.version),
            defaultVersionFor(tool, installs, defaults),
        );
        const install = picked ? mine.find((i) => i.version === picked) : undefined;
        if (!install) {
            const choices = [...mine]
                .sort((a, b) => compareVersionsDesc(a.version, b.version))
                .map((i) => i.version);
            return {
                ok: false,
                error:
                    `This repo's composer.json requires ${label} ${constraint} (\`${source}\`), and Genie manages no ${label} on this machine that satisfies it.` +
                    foreignNote(tool, installs) +
                    (choices.length
                        ? ` Genie manages ${choices.join(', ')}. Add a version that satisfies it in ${WHERE}, then start the site again.`
                        : ` Add a version that satisfies it in ${WHERE}, then start the site again.`),
            };
        }
        return { ok: true, install, version: install.version, exe: joinFor(platform, binDirOf(install), fileName) };
    }

    const found = opts.pinned
        ? [...mine].sort((a, b) => compareVersionsDesc(a.version, b.version)).find((i) =>
              satisfiesPin(i.version, opts.pinned!),
          )
        : mine.find((i) => i.version === defaultVersionFor(tool, installs, defaults));

    if (!found) {
        if (opts.pinned) {
            const choices = [...mine]
                .sort((a, b) => compareVersionsDesc(a.version, b.version))
                .map((i) => i.version);
            return {
                ok: false,
                error:
                    `This site is pinned to ${label} ${opts.pinned}, which Genie does not manage on this machine.` +
                    foreignNote(tool, installs) +
                    (choices.length
                        ? ` Add it in ${WHERE}, or pin the site to one Genie manages: ${choices.join(', ')}.`
                        : ` Add it in ${WHERE}, then start the site again.`),
            };
        }
        return {
            ok: false,
            error:
                `Genie manages no ${label} on this machine, so this site cannot run.` +
                foreignNote(tool, installs) +
                ` Add a ${label} version in ${WHERE}, then start the site again.`,
        };
    }

    return {
        ok: true,
        install: found,
        version: found.version,
        exe: joinFor(platform, binDirOf(found), fileName),
    };
}
