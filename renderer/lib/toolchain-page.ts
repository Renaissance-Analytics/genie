import type {
    EngineInstall,
    EngineInstallSource,
    HostToolName,
    LanguageTool,
    ToolUpdate,
    ToolchainPathReport,
    ToolchainSiteUsage,
} from './genie';

/**
 * The Toolchain page's VIEW model — every judgement the page makes, kept out of
 * React so it can be asserted (the renderer test env is Node-only, so a
 * component is not unit-testable and a decision inside one is a decision nobody
 * checks).
 *
 * ## The page separates three things that only LOOK alike
 *
 *  - **Languages** — php / node / python / go / rust. MULTI-version: many
 *    installs side by side, one is the machine default, and Genie owns the ones
 *    it installed (binaries and config) under `<userData>/toolchain`.
 *  - **Dev tools** — git / docker / composer. Single-version, update-to-latest.
 *  - **Agent CLIs** — claude-code / codex. Separated because updating them is
 *    the one thing REFUSED mid-turn, so the rule is stated once in one place.
 *
 * `node`, `npm` and `php` deliberately do NOT appear under Dev tools any more:
 * they are languages, they are managed per version, and showing a single
 * "Node.js 24.19.0 — up to date" row beside a Languages tab that lists three
 * node versions is exactly the confusion this page exists to end.
 *
 * ## Say what changes, before it changes
 *
 * Setting a default is not a silent write. {@link defaultChangeNotice} names the
 * sites that follow the default and says they move on their NEXT START — the
 * same rule as stopping a shared engine: name what you are about to affect.
 */

// --- which tab a tool belongs on -------------------------------------------

/** Single-version host tools: one install, update-to-latest. */
export const DEV_TOOL_TOOLS: readonly HostToolName[] = ['git', 'docker', 'composer'];

/** The agent TUIs. Their own group because their update rule is different. */
export const AGENT_CLI_TOOLS: readonly HostToolName[] = ['claude-code', 'codex'];

/** Keep a tab's rows in the declared order whatever order main answers in — a
 *  settings list that reshuffles between reads reads as broken. */
function inOrder(updates: ToolUpdate[], order: readonly HostToolName[]): ToolUpdate[] {
    return order
        .map((name) => updates.find((u) => u.name === name))
        .filter((u): u is ToolUpdate => u !== undefined);
}

export function devToolRows(updates: ToolUpdate[]): ToolUpdate[] {
    return inOrder(updates, DEV_TOOL_TOOLS);
}

export function agentCliRows(updates: ToolUpdate[]): ToolUpdate[] {
    return inOrder(updates, AGENT_CLI_TOOLS);
}

// --- labels -----------------------------------------------------------------

export const LANGUAGE_LABELS: Record<LanguageTool, string> = {
    php: 'PHP',
    node: 'Node.js',
    python: 'Python',
    go: 'Go',
    rust: 'Rust',
};

const SOURCE_LABELS: Record<EngineInstallSource, string> = {
    genie: 'Genie',
    herd: 'Herd',
    xampp: 'XAMPP',
    nvm: 'nvm',
    system: 'System',
};

export const LANGUAGE_ORDER: readonly LanguageTool[] = ['php', 'node', 'python', 'go', 'rust'];

// --- sizes ------------------------------------------------------------------

/** Bytes at a human scale. A toolchain directory is tens to hundreds of MB, so
 *  the unit is the point and a second decimal is noise. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// --- one install row --------------------------------------------------------

export interface InstallRowView {
    key: string;
    tool: LanguageTool;
    version: string;
    sourceLabel: string;
    /** The DIRECTORY holding the real executables. Shown because "which php is
     *  this?" is the actual question on a machine with Herd + Genie + a system
     *  copy. */
    path: string;
    /** Genie installed it → it is selectable and removable. */
    managed: boolean;
    isDefault: boolean;
    canSetDefault: boolean;
    canRemove: boolean;
    sizeLabel?: string;
    /** Why a foreign row has no actions. Absent on a managed row. */
    note?: string;
}

export function installRowView(
    install: EngineInstall,
    defaultVersion: string | undefined,
): InstallRowView {
    const managed = install.source === 'genie';
    const isDefault = managed && install.version === defaultVersion;
    return {
        key: `${install.tool}|${install.version}|${install.dir}`,
        tool: install.tool,
        version: install.version,
        sourceLabel: SOURCE_LABELS[install.source] ?? install.source,
        path: install.dir,
        managed,
        isDefault,
        canSetDefault: managed && !isDefault,
        // Removing the DEFAULT is allowed; main names what takes over.
        canRemove: managed && install.removable,
        ...(install.sizeBytes !== undefined ? { sizeLabel: formatBytes(install.sizeBytes) } : {}),
        ...(managed
            ? {}
            : {
                  note: `Installed by ${SOURCE_LABELS[install.source]} — not managed by Genie, so a site cannot use it.`,
              }),
    };
}

// --- the Languages tab ------------------------------------------------------

export type ToolchainSiteUse = ToolchainSiteUsage;

/** The sites that follow the machine default for a language — the ones a
 *  default change actually moves. A site that PINNED a version does not. */
export function sitesFollowingDefault(
    sites: ToolchainSiteUse[],
    tool: LanguageTool,
): ToolchainSiteUse[] {
    return sites.filter((s) => s.tool === tool && !s.version);
}

export interface LanguageSection {
    tool: LanguageTool;
    label: string;
    defaultVersion?: string;
    rows: InstallRowView[];
    /** Versions this release can install here that the machine does not have. */
    addable: string[];
    canAdd: boolean;
    /** Shown instead of the table when nothing is installed. */
    emptyNote?: string;
    /** "Used by 2 sites: web.tynn.gen (default), api.tynn.gen (8.2.33)". */
    usedBy?: string;
}

export interface LanguageSectionsInput {
    installs: EngineInstall[];
    defaults: Partial<Record<LanguageTool, string>>;
    addable: Partial<Record<LanguageTool, string[]>>;
    sites: ToolchainSiteUse[];
}

/**
 * One section per language, ALWAYS all five.
 *
 * An empty section is not noise — "Genie manages Python versions and you have
 * none" is the answer to "where is the UX for my toolchain", and hiding the
 * languages you have not installed yet is how a page ends up looking like it
 * only knows about PHP.
 */
export function languageSections(input: LanguageSectionsInput): LanguageSection[] {
    return LANGUAGE_ORDER.map((tool) => {
        const defaultVersion = input.defaults[tool];
        const rows = input.installs
            .filter((i) => i.tool === tool)
            .map((i) => installRowView(i, defaultVersion));
        const addable = input.addable[tool] ?? [];
        const consumers = input.sites.filter((s) => s.tool === tool);
        return {
            tool,
            label: LANGUAGE_LABELS[tool],
            ...(defaultVersion ? { defaultVersion } : {}),
            rows,
            addable,
            canAdd: addable.length > 0,
            ...(rows.length === 0 ? { emptyNote: emptyNoteFor(tool, addable.length > 0) } : {}),
            ...(consumers.length > 0 ? { usedBy: usedByLine(consumers) } : {}),
        };
    });
}

function emptyNoteFor(tool: LanguageTool, canAdd: boolean): string {
    const label = LANGUAGE_LABELS[tool];
    return canAdd
        ? `No ${label} installed by Genie yet. Add a version to let sites use it.`
        : `Genie has no installer for ${label} on this machine yet. Any ${label} already here is listed for reference only.`;
}

function usedByLine(consumers: ToolchainSiteUse[]): string {
    const parts = consumers.map((s) => `${s.genName} (${s.version ?? 'default'})`);
    return `Used by ${consumers.length} site${consumers.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

// --- the confirmations ------------------------------------------------------

/** `a`, `a and b`, `a, b and c`, with a cap so a machine with twenty sites still
 *  produces a sentence. */
function listNames(names: string[]): string {
    if (names.length === 1) return names[0]!;
    if (names.length <= 4) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/**
 * What changed, and what it moves. Never a bare "saved": the whole reason
 * "default" is a live link rather than a snapshot is that it CAN move a running
 * site, so the moment it moves is the moment to name them.
 */
export function defaultChangeNotice(
    tool: LanguageTool,
    version: string,
    sites: ToolchainSiteUse[],
): string {
    const label = LANGUAGE_LABELS[tool];
    const affected = sitesFollowingDefault(sites, tool).map((s) => s.genName);
    if (affected.length === 0) {
        return `${label} ${version} is now the default. No site follows the ${label} default yet, so nothing changed.`;
    }
    return `${label} ${version} is now the default — ${listNames(affected)} follow${
        affected.length === 1 ? 's' : ''
    } the default and will change on ${affected.length === 1 ? 'its' : 'their'} next start.`;
}

/** The Remove dialog's sentence: what goes, what it frees, what takes over. */
export function removeConfirmation(
    install: EngineInstall,
    outcome: { nextDefault?: string | null; freedBytes?: number },
): string {
    const label = LANGUAGE_LABELS[install.tool];
    const freed =
        outcome.freedBytes !== undefined ? ` and free ${formatBytes(outcome.freedBytes)}` : '';
    const head = `Delete ${label} ${install.version} from ${install.dir}${freed}.`;
    if (outcome.nextDefault === null) {
        return `${head} This is the last one Genie manages — afterwards there is no managed ${label}, and sites that need it will not start until you add a version.`;
    }
    if (outcome.nextDefault) {
        return `${head} It is the current default, so ${label} ${outcome.nextDefault} takes over and sites following the default change on their next start.`;
    }
    return head;
}

/**
 * What the repair found and what it changed.
 *
 * Never a bare "repaired". The owner's machine had Herd uninstalled with its
 * binaries and PATH entry left behind, so `php` answered from a directory the
 * uninstaller had walked away from — and, because Windows PHP reads `php.ini`
 * from the binary's own directory, so did its config. The only checkable report
 * names the TOOLS: "php was answering from somewhere else, now it isn't" is
 * something the user can verify in a second, and "PATH was wrong" is not.
 *
 * Three cases it must not conflate:
 *   - nothing was wrong → say so, and do not claim a fix;
 *   - fixed → name what had been shadowed, and admit which processes keep the
 *     old environment, or the next question is "why is it still broken";
 *   - reordered but STILL shadowed → say still. This is the honest answer when
 *     Genie manages no version of that tool at all, and calling it a repair is
 *     how a green button stops meaning anything.
 */
export function repairNotice(result: {
    before: ToolchainPathReport;
    after: ToolchainPathReport;
    changed: boolean;
    /** Genie-owned `php.ini` files rewritten because they no longer matched what
     *  Genie writes today — a stale one printed a startup warning into every
     *  composer run and every site log. */
    inis?: string[];
}): string {
    const iniNote =
        result.inis && result.inis.length > 0
            ? ` Genie also brought ${result.inis.length} of its own php.ini file${
                  result.inis.length === 1 ? '' : 's'
              } up to date.`
            : '';

    const staleNote =
        result.after.stale.length > 0
            ? ` PATH still lists ${listNames(result.after.stale)}, which no longer exist${
                  result.after.stale.length === 1 ? 's' : ''
              } — left behind by an uninstall. Harmless now that Genie's own tools come first, and Genie does not edit entries it did not create.`
            : '';

    const fixed = result.before.shadowed.filter((t) => !result.after.shadowed.includes(t));

    if (result.after.shadowed.length > 0) {
        const still = listNames(result.after.shadowed);
        const head =
            fixed.length > 0
                ? `Genie's toolchain now comes first on PATH, and ${listNames(fixed)} resolve${
                      fixed.length === 1 ? 's' : ''
                  } to it.`
                : `Genie's toolchain now comes first on PATH.`;
        return `${head} ${still} still resolve${
            result.after.shadowed.length === 1 ? 's' : ''
        } to an install Genie does not manage — Genie has no version of ${
            result.after.shadowed.length === 1 ? 'it' : 'them'
        } to offer, so add one under Languages.${staleNote}`;
    }

    if (!result.changed && result.before.toolsFirst) {
        return `Nothing needed changing — Genie's own toolchain was already first on PATH.${iniNote}${staleNote}`;
    }

    const named =
        fixed.length > 0
            ? ` ${listNames(fixed)} now resolve${fixed.length === 1 ? 's' : ''} to the version Genie manages.`
            : '';
    return `Genie's toolchain now comes first on PATH.${named}${iniNote} Terminals, sites and agents already running keep the environment they started with — restart them to pick this up.${staleNote}`;
}
