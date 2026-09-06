import type { CommandRunner } from './container-runtime';
import type { HostToolName } from './toolchain-detect';
import type { LatestFor, UpdateSource } from './toolchain-updates';
import { pmPackageFor } from './toolchain-packages';
import type { PackageManager } from './toolchain-packages';
import { NPM_UPDATE_PACKAGES } from './toolchain-adapters';
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
    /**
     * npm global prefixes to consult IN ADDITION to npm's configured one.
     *
     * A real machine has two (genie#470): Genie installs agent CLIs into its own
     * prefix (`npm install -g --prefix <userData>/toolchain/npm-global`), while a
     * bare `npm outdated -g` reads whatever npm is configured with. Measured on
     * the owner's machine, those hold different things — `@openai/codex` in the
     * configured one, `@genie/tui` in Genie's — so a single-prefix check is
     * blind to half of what is installed, and the half it was blind to is
     * everything GENIE installed.
     *
     * Empty (the default) is exactly the previous behaviour: one bare run.
     */
    npmPrefixes?: readonly string[];
}

export function createLatestFor(deps: LatestForDeps): LatestFor {
    // One cached promise per outdated command — resolved on first use, reused
    // after, so each command runs at most once for the whole update pass.
    let npmMap: Promise<Record<string, string>> | undefined;
    let pmMap: Promise<Record<string, string>> | undefined;

    /**
     * Run one outdated command and parse whatever it printed — WITHOUT gating on
     * the exit code.
     *
     * The gate used to be `res.code === 0 ? parse(res.stdout) : {}`, and it made
     * the npm half of this module dead code. `npm outdated` exits 1 when it
     * finds something outdated: that is its documented contract, and it is the
     * only case where the command has anything to report. So the one exit status
     * that carried an answer was the one that discarded it, and no agent CLI
     * could ever show an update. From the owner's machine:
     *
     *     6 verbose title npm outdated
     *     7 verbose argv "outdated" "--global" "--json"
     *     20 verbose exit 1
     *
     * Dropping the gate is safe because of the contract `toolchain-outdated`
     * already holds itself to: every parser is TOTAL — malformed, empty or
     * unrelated input yields `{}`, and a line it cannot judge is dropped rather
     * than guessed at. A genuinely failed command prints an error message, which
     * is not valid JSON and does not match the apt/winget row shapes, so it
     * parses to "nothing known to be out of date" — the same answer the gate
     * gave, for the cases the gate was actually right about.
     */
    const runParse = async (
        bin: string,
        argv: string[],
        parse: (out: string) => Record<string, string>,
    ): Promise<Record<string, string>> => {
        try {
            return parse((await deps.runner.run(bin, argv)).stdout);
        } catch {
            return {};
        }
    };

    /**
     * Every npm prefix's outdated list, merged into one `{package -> latest}`.
     *
     * MERGING NEEDS NO WINNER RULE, and that is what makes consulting both
     * prefixes a read widening rather than a policy decision:
     *
     *   - the update decision is `isUpdateAvailable(probe.version, latest)`;
     *   - `probe.version` comes from running THE BINARY PATH RESOLVES, so "which
     *     of the two installs is this?" is already answered by evidence rather
     *     than by this map;
     *   - `latest` is a property of the package ON THE REGISTRY and is identical
     *     whichever prefix reported it;
     *   - `current` from the outdated output is never read at all.
     *
     * So two entries for one package agree on the only field anything uses. The
     * merge is still FIRST-WINS rather than last, so the answer cannot depend on
     * which subprocess happened to return first — they can only disagree if a
     * publish lands between two calls seconds apart, and either reading is then
     * a correct "latest" for the moment it was taken.
     */
    const npmOutdated = async (): Promise<Record<string, string>> => {
        const runs = [
            runParse(NPM_OUTDATED.bin, NPM_OUTDATED.argv, NPM_OUTDATED.parse),
            ...(deps.npmPrefixes ?? []).map((prefix) =>
                runParse(
                    NPM_OUTDATED.bin,
                    ['outdated', '-g', '--prefix', prefix, '--json'],
                    NPM_OUTDATED.parse,
                ),
            ),
        ];
        const merged: Record<string, string> = {};
        for (const map of await Promise.all(runs)) {
            for (const [pkg, version] of Object.entries(map)) {
                merged[pkg] ??= version;
            }
        }
        return merged;
    };

    return async (tool: HostToolName): Promise<{ version?: string; source?: UpdateSource } | null> => {
        // Agent TUIs — npm-global, independent of any system package manager.
        // Keyed by the REGISTRY NAME, which is not always the install spec: the
        // Genie TUI installs from a release-tarball URL, and asking `npm
        // outdated` for a URL is a category error that happens to miss.
        const npmPkg = NPM_UPDATE_PACKAGES[tool];
        if (npmPkg) {
            npmMap ??= npmOutdated();
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
