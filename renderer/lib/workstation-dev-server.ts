import type { DevEngineInfo, DevRuntimeProbe, DevWorkstationInfo } from './genie';
import type { DevTone } from './dev-server';

/**
 * PURE. Everything the WORKSTATION Dev Server page decides (#234, workstation
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
}

export function engineActionAvailability(
    engine: DevEngineInfo,
    hasRuntime: boolean,
): EngineActions {
    if (!hasRuntime) return { canStart: false, canStop: false, canLogs: false };
    if (engine.state === 'running') {
        return { canStart: false, canStop: true, canLogs: true };
    }
    // Start needs a CONSUMER: with no workspace using it there are no
    // credentials to provision and nothing to serve, so the action would fail
    // every time. A button that always fails is worse than no button.
    return { canStart: engine.configured > 0, canStop: false, canLogs: false };
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
export function engineGroups(engines: DevEngineInfo[]): EngineGroups {
    const groups: EngineGroups = { active: [], installed: [], available: [] };
    for (const engine of engines) {
        if (engine.state === 'running') groups.active.push(engine);
        else if (engine.installed || engine.configured > 0 || engine.state === 'stopped') {
            groups.installed.push(engine);
        } else groups.available.push(engine);
    }
    return groups;
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
            'Install Docker Desktop (or Podman) to run dev servers and services in containers.',
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
