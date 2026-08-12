import type { CommandRunner } from './container-runtime';
import type { HostToolName } from './toolchain-detect';
import type { LatestFor, UpdateSource } from './toolchain-updates';
import { pmPackageFor } from './toolchain-packages';
import type { PackageManager } from './toolchain-packages';
import { NPM_PACKAGES } from './toolchain-adapters';
import { parseAptUpgradable, parseBrewOutdated, parseNpmOutdated, parseWingetUpgrade } from './toolchain-outdated';

/**
 * The real {@link LatestFor} behind P0's update check (#242 P1).
 *
 * It answers "what's the newest version of this tool?" by asking the manager
 * that owns it — `npm outdated` for the agent TUIs, the system package manager's
 * outdated list for everything it installs — and reading the tool's package out
 * of the parsed result. Two things make it correct AND cheap:
 *
 *   - **run once, not per tool.** The outdated command for a manager is fired the
 *     first time any of its tools is asked and CACHED for the rest of the poll —
 *     `detectToolUpdates` walks eight tools, and we do not want eight `brew
 *     outdated` calls.
 *   - **single source of truth for the mapping.** `pmPackageFor`/`NPM_PACKAGES`
 *     are the same maps the installer uses, so "what package is this tool" can
 *     never disagree between installing and update-checking.
 *
 * Never throws: a failed command yields `null` ("no update known"), which the
 * detector renders as simply no badge.
 */

/** How to list outdated packages per manager, and the parser for its output.
 *  dnf has no parser yet, so it is omitted — its tools report no update rather
 *  than a fabricated one. */
const PM_OUTDATED: Partial<
    Record<PackageManager, { bin: string; argv: string[]; parse: (out: string) => Record<string, string> }>
> = {
    winget: { bin: 'winget', argv: ['upgrade'], parse: parseWingetUpgrade },
    brew: { bin: 'brew', argv: ['outdated', '--json=v2'], parse: parseBrewOutdated },
    apt: { bin: 'apt', argv: ['list', '--upgradable'], parse: parseAptUpgradable },
};

const NPM_OUTDATED = { bin: 'npm', argv: ['outdated', '-g', '--json'], parse: parseNpmOutdated };

export interface LatestForDeps {
    runner: CommandRunner;
    /** The package manager to consult for its installed tools, or undefined when
     *  the machine has none (agent TUIs still resolve via npm). */
    pm?: PackageManager;
}

export function createLatestFor(deps: LatestForDeps): LatestFor {
    // One cached promise per outdated command — resolved on first use, reused
    // after, so the command runs at most once for the whole update pass.
    let npmMap: Promise<Record<string, string>> | undefined;
    let pmMap: Promise<Record<string, string>> | undefined;

    const runParse = async (
        bin: string,
        argv: string[],
        parse: (out: string) => Record<string, string>,
    ): Promise<Record<string, string>> => {
        try {
            const res = await deps.runner.run(bin, argv);
            return res.code === 0 ? parse(res.stdout) : {};
        } catch {
            return {};
        }
    };

    return async (tool: HostToolName): Promise<{ version?: string; source?: UpdateSource } | null> => {
        // Agent TUIs — npm-global, independent of any system package manager.
        const npmPkg = NPM_PACKAGES[tool];
        if (npmPkg) {
            npmMap ??= runParse(NPM_OUTDATED.bin, NPM_OUTDATED.argv, NPM_OUTDATED.parse);
            const version = (await npmMap)[npmPkg];
            return version ? { version, source: 'npm-global' } : null;
        }

        // Everything else — the chosen system package manager's outdated list.
        const spec = deps.pm ? PM_OUTDATED[deps.pm] : undefined;
        const pkg = deps.pm ? pmPackageFor(deps.pm, tool)?.id : undefined;
        if (spec && pkg) {
            pmMap ??= runParse(spec.bin, spec.argv, spec.parse);
            const version = (await pmMap)[pkg];
            return version ? { version, source: 'package-manager' } : null;
        }

        return null;
    };
}
