import { GO_RECIPES } from './go-versions.js';
import { NODE_RECIPES } from './node-versions.js';
import { PHP_RECIPES, compareVersionsDesc } from './php-versions.js';
import { PYTHON_RECIPES } from './python-versions.js';
import { langManagedOn, type DefaultsPlatform } from './toolchain-defaults.js';

/**
 * UPDATING A LANGUAGE (genie#1306) — the pure half.
 *
 * Genie 1's rule (v0.7.0-beta.342, `main/dev-server/toolchain-adapters.ts` engineToolFor/buildEngineCommand and
 * `toolchain-perform.ts` performEngine): a LANGUAGE is installed — and so updated — through Genie's own per-version
 * installer, into its own directory, never through a package manager. Genie 2's beta.49 sent every language row to
 * `winget upgrade --id PHP.PHP.8.4` (NodeJS.LTS, Python.Python.3.13, GoLang.Go) whatever had installed it; on the owner's
 * machine every one of them was a Genie-managed install, winget answered 0x8A150014 ("no installed package found"), and
 * nothing updated.
 *
 * So for php, node, python and go — where Genie manages that language on this OS — an update is: install the target
 * version with Genie's installer (checksum-verified), point `current/<lang>` at it, and measure what `<lang>` answers.
 *
 * WHICH VERSION: the PATCH in the installed line first (a security notice's fix is a patch: 8.4.24 → 8.4.27), and
 * another line only as a separate, secondary choice (8.5.12). Only versions this release can install are offered.
 */

export const LANGUAGE_TOOLS = ['php', 'node', 'python', 'go'] as const;
export type LanguageTool = (typeof LANGUAGE_TOOLS)[number];

export function isLanguageTool(tool: string): tool is LanguageTool {
    return (LANGUAGE_TOOLS as readonly string[]).includes(tool);
}

export const LANGUAGE_LABEL: Record<LanguageTool, string> = { php: 'PHP', node: 'Node', python: 'Python', go: 'Go' };

/** The versions this release of Genie installs, per language (each installer's own static list). */
export function installableVersions(tool: LanguageTool): readonly string[] {
    const recipes = tool === 'php' ? PHP_RECIPES : tool === 'node' ? NODE_RECIPES : tool === 'python' ? PYTHON_RECIPES : GO_RECIPES;
    return recipes.map((r) => r.version);
}

/** Whether an update of `tool` here is Genie's own install (never a package manager). */
export function genieUpdates(tool: string, platform: DefaultsPlatform): tool is LanguageTool {
    return isLanguageTool(tool) && langManagedOn(tool, platform);
}

/**
 * A version's LINE — what a patch stays inside. Node's releases are semver (its LTS line is the major: 24.x); PHP,
 * Python and Go ship new features in the minor (8.4 → 8.5, 3.13 → 3.14, 1.25 → 1.26), so their line is major.minor.
 */
export function languageLine(tool: LanguageTool, version: string): string {
    const parts = version.split('.');
    return tool === 'node' ? parts[0]! : parts.slice(0, 2).join('.');
}

export interface UpdateChoices {
    /** The newest installable version in the installed line, newer than it — the primary action. */
    readonly patch: string | null;
    /** The newest installable version on ANOTHER (newer) line — a separate, secondary choice. */
    readonly upgrade: string | null;
}

const newer = (a: string, b: string) => compareVersionsDesc(a, b) < 0;

export function updateChoices(tool: LanguageTool, installed: string, available: readonly string[] = installableVersions(tool)): UpdateChoices {
    const line = languageLine(tool, installed);
    const candidates = [...available].filter((v) => newer(v, installed)).sort(compareVersionsDesc);
    return {
        patch: candidates.find((v) => languageLine(tool, v) === line) ?? null,
        upgrade: candidates.find((v) => languageLine(tool, v) !== line) ?? null,
    };
}
