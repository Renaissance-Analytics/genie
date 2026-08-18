import type {
    DevEngineInfo,
    DevRuntimeProbe,
    DevWorkstationInfo,
    HostToolName,
    ToolInstallSource,
    ToolUpdate,
    ToolchainUpdateSource,
} from './genie';
import type { DevTone } from './dev-server';

/**
 * PURE. Everything the WORKSTATION Hosting Manager page decides (workstation
 * half). The renderer test environment has no DOM, so this is the same split
 * `dev-server.ts` uses for the Site Manager: judgements here, wiring in the
 * component.
 *
 * ## The page exists because engines are SHARED
 *
 * One `postgres:16` container serves every workspace pinned to Postgres 16. So
 * "stop" on this page is not "turn my thing off" — it can take five other
 * projects' databases down with it, and the only thing standing between a user
 * and that is a sentence naming who else is on it. {@link stopEngineWarning} is
 * that sentence, and it deliberately returns `null` when a stop is harmless
 * rather than crying wolf on every row.
 *
 * ## Installed, running and used are three different things
 *
 * An image can be on disk with no container (several gigabytes that nothing
 * else in Genie reports). A container can be UP with zero holders — engines
 * carry `restart: unless-stopped`, so a reboot brings them back before Genie
 * opens. A workspace can have an engine configured but disabled. Every pair of
 * those occurs, so the page never collapses them into one "status".
 */

// --- one engine's status ----------------------------------------------------

export function engineStatusTone(engine: DevEngineInfo): DevTone {
    return engine.state === 'running' ? 'running' : 'idle';
}

export function engineStatusLabel(engine: DevEngineInfo): string {
    if (engine.state === 'running') {
        return 'Running on this machine.';
    }
    if (engine.state === 'stopped') {
        return 'Its container exists but is stopped — starting it needs no download.';
    }
    if (engine.installed) {
        // The state nothing else surfaces: pulled once, never running. Usually
        // the answer to "what is taking up my disk".
        return 'Downloaded but not running — the image is on this machine, nothing is using it.';
    }
    return 'Not on this machine. The image is downloaded the first time a workspace asks for it.';
}

/**
 * WHO is using this engine, in words — or `null` when saying anything would be
 * noise.
 *
 * A catalog row nobody uses and nothing runs is an OFFER, not a status; hanging
 * "0 workspaces" off a dozen of them buries the two rows that matter.
 */
export function engineUsageNote(engine: DevEngineInfo): string | null {
    if (engine.state !== 'running' && engine.configured === 0) return null;

    if (engine.state === 'running' && engine.holders === 0) {
        // Worth its own sentence: a database running for nobody. It survives
        // reboots on its own restart policy, so this is a real and common state.
        return engine.configured > 0
            ? `Running, but no workspace is holding it right now (${listNames(engine.workspaces)} ${
                  engine.configured === 1 ? 'has' : 'have'
              } it configured).`
            : 'Running, but no workspace is using it. Nothing will release it — stop it here if you do not want it.';
    }

    if (engine.dedicated) {
        const owner = engine.workspaces[0] ?? 'one workspace';
        return `Dedicated to ${owner} — its own container and its own data, shared with nothing.`;
    }

    if (engine.holders > 0) {
        return `Shared with ${engine.holders} workspace${engine.holders === 1 ? '' : 's'}: ${listNames(
            engine.workspaces,
        )}.`;
    }
    return `Configured by ${listNames(engine.workspaces)}, not running.`;
}

/**
 * What a machine-level STOP would actually do to other people's work — or
 * `null` when it would do nothing to anyone.
 *
 * The shared model's one real hazard. A user who stops "their" Postgres and
 * takes five other projects offline was misled by the button, not by the
 * backend.
 */
export function stopEngineWarning(engine: DevEngineInfo): string | null {
    if (engine.state !== 'running' || engine.holders === 0) return null;
    if (engine.dedicated) {
        const owner = engine.workspaces[0] ?? 'its workspace';
        return `${owner} is using this engine right now — stopping it takes that workspace's database down until it is started again.`;
    }
    return (
        `${engine.holders} workspace${engine.holders === 1 ? '' : 's'} ` +
        `(${listNames(engine.workspaces)}) ${engine.holders === 1 ? 'is' : 'are'} using this engine right now. ` +
        'Stopping it here stops it for all of them — this is not a per-workspace release.'
    );
}

/** Which machine-level actions a row can offer. */
export interface EngineActions {
    canStart: boolean;
    canStop: boolean;
    canLogs: boolean;
    /** Pre-download this version's image (#242 P3, multi-version). */
    canInstall: boolean;
}

export function engineActionAvailability(
    engine: DevEngineInfo,
    hasRuntime: boolean,
): EngineActions {
    if (!hasRuntime) {
        return { canStart: false, canStop: false, canLogs: false, canInstall: false };
    }
    // Install is the one action that does NOT need a consumer — holding several
    // majors ready is the whole point of multi-version, and each (engine,
    // version) is its own image. Nothing to pull once it is here, or for a
    // `custom` engine whose image no workspace has named yet.
    const canInstall = !engine.installed && !!engine.image;
    if (engine.state === 'running') {
        return { canStart: false, canStop: true, canLogs: true, canInstall };
    }
    // Start needs a CONSUMER: with no workspace using it there are no
    // credentials to provision and nothing to serve, so the action would fail
    // every time. A button that always fails is worse than no button.
    return { canStart: engine.configured > 0, canStop: false, canLogs: false, canInstall };
}

// --- grouping ---------------------------------------------------------------

export interface EngineGroups {
    /** Up right now. */
    active: DevEngineInfo[];
    /** On this machine (image pulled, or a workspace has it configured) but not
     *  running. */
    installed: DevEngineInfo[];
    /** Catalog rows: nothing here yet, offered so the page can say what is
     *  possible. */
    available: DevEngineInfo[];
}

/**
 * Three groups, because a flat list of a dozen catalog rows buries the two that
 * are actually running. Order within each group is preserved from the backend,
 * which already ranks running → installed → absent.
 */
export type EngineGroupId = keyof EngineGroups;

/**
 * Which group ONE row belongs to.
 *
 * Split out of {@link engineGroups} so the page can FOLLOW a row after an action
 * that changes its state — installing a version moves it out of the tab it was
 * clicked in, and a row that silently vanishes reads as "nothing happened".
 * Deriving both the grouping and the follow-to destination from this one
 * function is what stops the tab a row is IN and the tab we send you to from
 * ever disagreeing.
 */
export function engineGroupOf(engine: DevEngineInfo): EngineGroupId {
    if (engine.state === 'running') return 'active';
    if (engine.installed || engine.configured > 0 || engine.state === 'stopped') return 'installed';
    return 'available';
}

export function engineGroups(engines: DevEngineInfo[]): EngineGroups {
    const groups: EngineGroups = { active: [], installed: [], available: [] };
    for (const engine of engines) groups[engineGroupOf(engine)].push(engine);
    return groups;
}

/** The human label of each group tab — one source of truth for the tab and for
 *  the sentence that tells you where a row went. */
export const ENGINE_GROUP_LABELS: Readonly<Record<EngineGroupId, string>> = {
    active: 'Running',
    installed: 'On this machine',
    available: 'Available',
};

/** An engine's display name — `custom` has no meaningful version to append. */
function engineDisplayName(engine: DevEngineInfo): string {
    return engine.engine === 'custom' ? engine.label : `${engine.label} ${engine.version}`;
}

/**
 * The confirmation after a version is pre-downloaded.
 *
 * Says the three things the screen alone no longer can: WHAT finished, WHERE the
 * row went (it changed tabs), and that the image being here does NOT mean
 * anything is running — the distinction this page keeps everywhere else, and a
 * claim the very next glance would otherwise disprove.
 */
export function engineInstalledNote(engine: DevEngineInfo): string {
    return (
        `${engineDisplayName(engine)} is downloaded — it moved to “${ENGINE_GROUP_LABELS.installed}”. ` +
        'Nothing is running yet; it starts when a workspace uses it.'
    );
}

// --- the container runtime --------------------------------------------------

export interface RuntimeProbeView {
    kind: string;
    label: string;
    detail?: string;
    tone: DevTone;
}

export interface RuntimeDiagnostics {
    /** Can this machine run containers at all right now? */
    usable: boolean;
    headline: string;
    /** What to do about it, when there is something to do. */
    guidance: string | null;
    /** Every candidate that was probed — "docker: found, engine unreachable" is
     *  the sentence that ends a support thread. */
    probes: RuntimeProbeView[];
}

const RUNTIME_LABELS: Readonly<Record<string, string>> = { docker: 'Docker', podman: 'Podman' };

export function runtimeDiagnostics(info: DevWorkstationInfo): RuntimeDiagnostics {
    const { runtime } = info;
    const probes = runtime.probes.map(probeView);

    if (runtime.kind && runtime.kind !== 'none') {
        const name = RUNTIME_LABELS[runtime.kind] ?? runtime.kind;
        return {
            usable: true,
            headline: runtime.version ? `${name} ${runtime.version}` : name,
            guidance: null,
            probes,
        };
    }

    // INSTALLED-but-stopped and NOT-INSTALLED need opposite advice. Flattening
    // them tells someone to install what they already have.
    const headline =
        runtime.reason === 'not-running'
            ? 'A container runtime is installed but not running'
            : 'No container runtime on this machine';
    return {
        usable: false,
        headline,
        guidance:
            runtime.installHint ??
            'Install Docker Desktop (or Podman) to build and serve sites, and to run their services, in containers.',
        probes,
    };
}

function probeView(probe: DevRuntimeProbe): RuntimeProbeView {
    const name = RUNTIME_LABELS[probe.kind] ?? probe.kind;
    if (probe.running) {
        return {
            kind: probe.kind,
            label: probe.version ? `${name} ${probe.version} — running` : `${name} — running`,
            tone: 'running',
            ...(probe.detail ? { detail: probe.detail } : {}),
        };
    }
    return {
        kind: probe.kind,
        label: probe.installed
            ? `${name} — installed, engine not running`
            : `${name} — not installed`,
        tone: 'idle',
        ...(probe.detail ? { detail: probe.detail } : {}),
    };
}

// --- small helpers ----------------------------------------------------------

/** `a`, `a and b`, `a, b and c` — and a cap, because a machine can genuinely
 *  have twenty workspaces on one engine and the sentence still has to read. */
function listNames(names: string[]): string {
    if (names.length === 0) return 'no workspace';
    if (names.length === 1) return names[0]!;
    if (names.length <= 4) {
        return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    }
    return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

// --- host tool updates (Toolchain Manager, #242 P2, the Dev Tools section) ---
//
// The read side (`devServer.toolchainUpdates`) already decides whether a newer
// version exists per tool (main/dev-server/toolchain-updates.ts). This is the
// VIEW model the Dev Tools section renders from: a human label, the badge tone,
// and whether an Update action is offered. INSTALL is deliberately absent — the
// first-run wizard (#240) owns getting a missing tool onto the machine; this
// section manages what is already here.

export type ToolUpdateTone = 'update-available' | 'up-to-date' | 'not-installed' | 'unknown';
export type ToolRowAction = 'install' | 'update' | 'none';

export interface ToolUpdateRow {
    name: HostToolName;
    /** Human label, e.g. `Claude Code` for `claude-code`. */
    label: string;
    installed?: string;
    latest?: string;
    updateAvailable: boolean;
    tone: ToolUpdateTone;
    action: ToolRowAction;
    source: ToolchainUpdateSource;
    /** Display name of WHO installed it, when the path said so (genie#213).
     *  Absent for `unknown` — a row that cannot name the installer says nothing
     *  rather than printing the word "unknown" at the user. */
    originLabel?: string;
    /** The DIRECTORY holding the binary that answered. Shown even when the
     *  installer is unknown: "which git answered?" is the question, and WHERE
     *  answers most of it. */
    directory?: string;
    /** Genie installed it, so Genie may update it. FALSE whenever the origin is
     *  unknown — claiming ownership of a tool another installer put there is the
     *  one answer that causes harm. */
    managed: boolean;
}

const TOOL_LABELS: Record<HostToolName, string> = {
    git: 'Git',
    node: 'Node.js',
    npm: 'npm',
    php: 'PHP',
    composer: 'Composer',
    docker: 'Docker',
    // Carried for completeness only. The VC++ runtime is a setup-time
    // prerequisite, not a tool this page manages or updates — it is absent from
    // DEFAULT_TOOLCHAIN, so no update row is ever built for it.
    vcredist: 'Visual C++ runtime (for PHP)',
    'claude-code': 'Claude Code',
    codex: 'Codex',
};

/** The display name for a tool — never its internal id in the UI. */
export function toolLabel(name: HostToolName): string {
    return TOOL_LABELS[name] ?? name;
}

/**
 * The badge tone for a tool row. Four genuinely different states: a newer version
 * is out (act), it is current (reassure), it is here but no source could say what
 * the latest is (honest "unknown", not a false "up to date"), or it is not
 * installed at all.
 */
export function toolUpdateTone(u: ToolUpdate): ToolUpdateTone {
    if (!u.installed) return 'not-installed';
    if (u.updateAvailable) return 'update-available';
    if (u.latest) return 'up-to-date';
    return 'unknown';
}

/**
 * What this row lets you DO.
 *
 * Update when a newer version is known and the tool is here to update; INSTALL
 * when it is not on the machine at all.
 *
 * Install used to be deliberately absent — the first-run wizard owned getting a
 * tool onto the machine, and this section managed what was already here. That
 * split stopped being defensible the moment this page began REPORTING that
 * something was missing: it left a row saying "not installed" with no way to act
 * on it, and the owner reported precisely that about docker, git and the agent
 * CLIs. Both surfaces now install through the same path (genie#212), so there is
 * no longer a reason for one of them to withhold the button.
 */
export function toolRowAction(u: ToolUpdate): ToolRowAction {
    if (!u.installed) return 'install';
    return u.updateAvailable ? 'update' : 'none';
}

/** How each installer is written on screen. `unknown` is deliberately absent:
 *  it is the "we could not tell" case, and the row omits the label entirely
 *  rather than printing a non-answer. */
const INSTALL_SOURCE_LABELS: Partial<Record<ToolInstallSource, string>> = {
    genie: 'Genie',
    winget: 'winget',
    'program-files': 'Program Files',
    homebrew: 'Homebrew',
    'npm-global': 'npm (global)',
    system: 'System',
};

/** One tool's row: the version pair, badge tone and action folded together. */
export function toolUpdateRow(u: ToolUpdate): ToolUpdateRow {
    const originLabel = u.origin ? INSTALL_SOURCE_LABELS[u.origin.source] : undefined;
    return {
        name: u.name,
        label: toolLabel(u.name),
        ...(u.installed !== undefined ? { installed: u.installed } : {}),
        ...(u.latest !== undefined ? { latest: u.latest } : {}),
        updateAvailable: u.updateAvailable,
        tone: toolUpdateTone(u),
        action: toolRowAction(u),
        source: u.source,
        ...(originLabel ? { originLabel } : {}),
        ...(u.origin?.directory ? { directory: u.origin.directory } : {}),
        managed: u.origin?.managedByGenie === true,
    };
}

/** The whole Dev Tools table, order preserved. */
export function toolUpdateRows(updates: ToolUpdate[]): ToolUpdateRow[] {
    return updates.map(toolUpdateRow);
}

/** How many installed tools have an update available — drives the section (and,
 *  in #242 P4, the entry-point) badge. */
export function toolUpdateCount(updates: ToolUpdate[]): number {
    return updates.filter((u) => u.updateAvailable).length;
}
