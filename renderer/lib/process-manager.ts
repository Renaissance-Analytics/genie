import { isSystemWorkspace, processSpecWorkspace, workspaceSurfaceSpecs, type ProcessStatus, type ScheduleInfo, type TerminalSpec, type ViewMeta } from './genie';
import { SCHEDULE_PRESETS, formatLastRun, formatNextRun, isScheduledSpec, lastRunTone } from './schedule-view';

/**
 * THE PROCESSES MODAL — every judgement it renders from.
 *
 * Background processes moved out of an expanding block in the sidebar into a modal
 * built like the Site Manager, with every property a process has available: label,
 * command, where it runs, shell, environment, whether it starts with Genie, whether
 * it restarts when it exits, and a schedule. The renderer has no DOM harness, so
 * each decision the modal makes lives here and is tested
 * (`__tests__/process-manager.test.ts`); `WorkspaceProcessManager.tsx` is wiring.
 *
 * Nothing here parses cron: the Host evaluates schedules and describes them
 * (`ScheduleInfo`), exactly as `schedule-view.ts` already insists.
 */

/** The workspace facts a process is judged against. */
export interface ProcessWorkspace {
    id: string;
    path: string;
}

export type ProcessKind = 'service' | 'scheduled';

export type ProcessTone = 'running' | 'starting' | 'stopped' | 'crashed' | 'armed' | 'disarmed' | 'awaiting';

export type ProcessAction = 'start' | 'stop' | 'restart' | 'run-now' | 'arm' | 'disarm' | 'logs' | 'edit' | 'delete';

export interface ProcessScheduleView {
    kind: 'command' | 'agent-nudge';
    expression: string;
    description: string;
    next: string;
    last: string;
    lastTone: 'ok' | 'failed' | 'skipped' | 'none';
    pendingApproval: boolean;
    nudgePrompt?: string;
}

export interface ProcessCardView {
    id: string;
    label: string;
    command: string;
    kind: ProcessKind;
    tone: ProcessTone;
    statusLabel: string;
    runsIn: string;
    shell: string;
    /** How a service behaves, in words. Empty for a scheduled task. */
    behaviours: string[];
    env: Array<[string, string]>;
    schedule?: ProcessScheduleView;
    actions: ProcessAction[];
}

export const processKind = (spec: Pick<TerminalSpec, 'type' | 'meta'>): ProcessKind =>
    isScheduledSpec(spec) ? 'scheduled' : 'service';

/** Where a process runs, as a person would say it. */
function runsIn(spec: TerminalSpec, ws: ProcessWorkspace): string {
    if (isSystemWorkspace(ws)) return spec.cwd || ws.path;
    const cwd = (spec.cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const root = ws.path.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!cwd || cwd === root) return 'The workspace root';
    const repos = `${root}/repos/`;
    if (cwd.startsWith(repos)) return `repos/${cwd.slice(repos.length)}`;
    return spec.cwd;
}

/** The repo folder a workspace process runs in, or '' for the root. */
function repoOf(spec: TerminalSpec, ws: ProcessWorkspace): string {
    const cwd = (spec.cwd || '').replace(/\\/g, '/');
    const repos = `${ws.path.replace(/\\/g, '/').replace(/\/+$/, '')}/repos/`;
    return cwd.startsWith(repos) ? cwd.slice(repos.length).replace(/\/+$/, '') : '';
}

export function processCard(
    spec: TerminalSpec,
    ws: ProcessWorkspace,
    status: ProcessStatus | undefined,
    info: ScheduleInfo | undefined,
    now: number = Date.now(),
): ProcessCardView {
    const kind = processKind(spec);
    const st = status ?? 'stopped';
    const running = st === 'running';
    const base = {
        id: spec.id,
        label: spec.label,
        command: spec.meta?.command ?? '',
        kind,
        runsIn: runsIn(spec, ws),
        shell: spec.shell || 'Default shell',
        env: Object.entries(spec.env ?? {}),
    };

    if (kind === 'scheduled') {
        const meta = spec.meta ?? {};
        const pendingApproval = meta.schedule_pending_approval === true;
        const armed = spec.enabled !== false;
        const tone: ProcessTone = running
            ? 'running'
            : pendingApproval
              ? 'awaiting'
              : armed
                ? 'armed'
                : 'disarmed';
        const statusLabel = {
            running: 'Running now',
            awaiting: 'Awaiting your approval',
            armed: 'Scheduled',
            disarmed: 'Paused — not firing',
        }[tone as 'running' | 'awaiting' | 'armed' | 'disarmed'];
        return {
            ...base,
            tone,
            statusLabel,
            behaviours: [],
            schedule: {
                kind: meta.schedule_kind ?? 'command',
                expression: meta.schedule ?? '',
                description: info?.description ?? meta.schedule ?? '',
                next: formatNextRun(info?.nextAt ?? null, now),
                last: formatLastRun(meta.last_run_at, meta.last_run_status, now),
                lastTone: lastRunTone(meta.last_run_status),
                pendingApproval,
                ...(meta.nudge_prompt ? { nudgePrompt: meta.nudge_prompt } : {}),
            },
            actions: ['run-now', armed ? 'disarm' : 'arm', 'logs', 'edit', 'delete'],
        };
    }

    const tone: ProcessTone =
        st === 'running' ? 'running' : st === 'restarting' ? 'starting' : st === 'stopped' ? 'stopped' : 'crashed';
    const statusLabel = {
        running: 'Running',
        starting: 'Restarting…',
        stopped: 'Stopped',
        crashed: st === 'failed' ? 'Failed to start' : 'Crashed',
    }[tone as 'running' | 'starting' | 'stopped' | 'crashed'];

    const behaviours: string[] = [];
    if (spec.meta?.autostart) behaviours.push('Starts with Genie');
    if (spec.meta?.restart_on_exit) behaviours.push('Restarts if it exits');
    if (behaviours.length === 0) behaviours.push('Runs only when you start it');

    const actions: ProcessAction[] =
        tone === 'running'
            ? ['stop', 'restart', 'logs', 'edit', 'delete']
            : tone === 'starting'
              ? ['stop', 'logs', 'edit', 'delete']
              : ['start', 'logs', 'edit', 'delete'];

    return { ...base, tone, statusLabel, behaviours, actions };
}

export function splitProcessTabs(specs: TerminalSpec[]): { services: TerminalSpec[]; scheduled: TerminalSpec[] } {
    const services: TerminalSpec[] = [];
    const scheduled: TerminalSpec[] = [];
    for (const s of specs) (processKind(s) === 'scheduled' ? scheduled : services).push(s);
    return { services, scheduled };
}

// --- environment --------------------------------------------------------------

export function formatEnvText(env: Record<string, string> | undefined): string {
    return Object.entries(env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
}

export type ParsedEnv = { ok: true; env: Record<string, string> } | { ok: false; error: string };

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `KEY=value` lines. Everything after the FIRST `=` is the value, so a DSN or a
 * URL with a query string survives. A line that is not a pair is reported by
 * content rather than dropped — a silently lost variable is the bug that makes a
 * process "work on my machine".
 */
export function parseEnvText(text: string): ParsedEnv {
    const env: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        const key = eq > 0 ? line.slice(0, eq).trim() : '';
        if (!key || !ENV_KEY.test(key)) {
            return { ok: false, error: `This environment line is not NAME=value: “${line}”` };
        }
        env[key] = line.slice(eq + 1);
    }
    return { ok: true, env };
}

// --- the form -----------------------------------------------------------------

export interface ProcessDraft {
    label: string;
    command: string;
    /** Workspace process: the repo folder under repos/, or '' for the root. */
    repo: string;
    /** System process: the absolute directory it runs in. */
    dir: string;
    /** '' = the default shell. */
    shell: string;
    envText: string;
    autostart: boolean;
    restartOnExit: boolean;
    /** The dropdown: '' (no schedule), a preset expression, or 'custom'. */
    schedulePreset: string;
    /** The cron expression itself. */
    schedule: string;
}

export function emptyProcessDraft(ws: ProcessWorkspace): ProcessDraft {
    return {
        label: '',
        command: '',
        repo: '',
        dir: isSystemWorkspace(ws) ? ws.path : '',
        shell: '',
        envText: '',
        // The defaults a new process has always had: a service that restarts if
        // it exits, and does not start with Genie until someone asks it to.
        autostart: false,
        restartOnExit: true,
        schedulePreset: '',
        schedule: '',
    };
}

export function draftFromSpec(spec: TerminalSpec, ws: ProcessWorkspace): ProcessDraft {
    const expr = spec.meta?.schedule ?? '';
    return {
        label: spec.label,
        command: spec.meta?.command ?? '',
        repo: isSystemWorkspace(ws) ? '' : repoOf(spec, ws),
        dir: isSystemWorkspace(ws) ? spec.cwd || ws.path : '',
        shell: spec.shell ?? '',
        envText: formatEnvText(spec.env),
        autostart: spec.meta?.autostart === true,
        restartOnExit: spec.meta?.restart_on_exit === true,
        // A hand-written expression opens straight into the custom field.
        schedulePreset: !expr ? '' : SCHEDULE_PRESETS.some((p) => p.value === expr) ? expr : 'custom',
        schedule: expr,
    };
}

/** Everything wrong with a draft, in the order the form shows it. Empty = saveable. */
export function draftProblems(draft: ProcessDraft, ws: ProcessWorkspace): string[] {
    const problems: string[] = [];
    if (!draft.command.trim()) problems.push('Enter the command to run.');
    if (isSystemWorkspace(ws) && !draft.dir.trim()) problems.push('Choose the directory this process runs in.');
    if (draft.schedulePreset === 'custom' && draft.schedule.trim().split(/\s+/).filter(Boolean).length !== 5) {
        problems.push('A schedule needs 5 fields: minute, hour, day of month, month, day of week.');
    }
    const env = parseEnvText(draft.envText);
    if (!env.ok) problems.push(env.error);
    return problems;
}

function cwdFor(draft: ProcessDraft, ws: ProcessWorkspace): string {
    if (isSystemWorkspace(ws)) return draft.dir.trim();
    const root = ws.path.replace(/[\\/]+$/, '');
    return draft.repo ? `${root}/repos/${draft.repo}` : ws.path;
}

/** The service behaviours a draft asks for — both OFF for a scheduled task, whose
 *  schedule, not the supervisor, decides when it runs again. */
function behaviourMeta(draft: ProcessDraft): Pick<ViewMeta, 'autostart' | 'restart_on_exit'> {
    const scheduled = draft.schedule.trim() !== '';
    return {
        autostart: scheduled ? false : draft.autostart,
        restart_on_exit: scheduled ? false : draft.restartOnExit,
    };
}

export type ProcessCreate = Pick<TerminalSpec, 'workspace_id' | 'label' | 'cwd' | 'shell' | 'env' | 'type' | 'meta'>;

/** The spec to create, minus the id the caller mints. Call only on a draft with no problems. */
export function draftToCreate(draft: ProcessDraft, ws: ProcessWorkspace): ProcessCreate {
    const system = isSystemWorkspace(ws);
    const command = draft.command.trim();
    const schedule = draft.schedule.trim();
    const env = parseEnvText(draft.envText);
    return {
        workspace_id: system ? null : ws.id,
        label: (draft.label.trim() || command.split(/\s+/).slice(0, 3).join(' ')).slice(0, 60),
        cwd: cwdFor(draft, ws),
        shell: draft.shell.trim() || null,
        env: env.ok ? env.env : {},
        type: 'process',
        meta: {
            command,
            ...behaviourMeta(draft),
            ...(schedule ? { schedule } : {}),
            ...(system ? { system: true } : {}),
        },
    };
}

export type ProcessPatch = Pick<TerminalSpec, 'label' | 'cwd' | 'shell' | 'env' | 'meta'>;

/**
 * The update for an existing process. The meta is MERGED over what is stored, so
 * everything the form does not show survives an edit — run history, an agent-nudge
 * task's target and prompt, the System tag. An empty schedule clears one.
 */
export function draftToPatch(draft: ProcessDraft, spec: TerminalSpec, ws: ProcessWorkspace): ProcessPatch {
    const schedule = draft.schedule.trim();
    const env = parseEnvText(draft.envText);
    return {
        label: (draft.label.trim() || spec.label).slice(0, 60),
        cwd: cwdFor(draft, ws) || spec.cwd,
        shell: draft.shell.trim() || null,
        env: env.ok ? env.env : spec.env,
        meta: {
            ...spec.meta,
            command: draft.command.trim(),
            ...behaviourMeta(draft),
            schedule: schedule || undefined,
        },
    };
}

/**
 * Whether saving restarts the process. Only a RUNNING SERVICE, and only when
 * something it runs WITH changed — the command, directory, shell or environment,
 * which the supervisor reads at start. A rename does not interrupt it, and a
 * scheduled task has nothing running between fires.
 */
export function restartAfterSave(spec: TerminalSpec, patch: ProcessPatch, status: ProcessStatus | undefined): boolean {
    if (status !== 'running') return false;
    if (processKind({ type: spec.type, meta: patch.meta }) === 'scheduled') return false;
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    return (
        !same(patch.meta.command, spec.meta?.command) ||
        !same(patch.cwd, spec.cwd) ||
        !same(patch.shell, spec.shell) ||
        !same(patch.env, spec.env)
    );
}

/**
 * The processes a workspace owns — the same bucketing the sidebar uses, through the
 * same resolver the old Edit menu used (`processSpecWorkspace`), so the modal and the
 * process box cannot count differently. A System process persists unattached and
 * belongs to the System Workspace; an unattached process that is not tagged System
 * belongs to nobody here.
 */
export function processSpecsOf(specs: readonly TerminalSpec[], ws: ProcessWorkspace): TerminalSpec[] {
    return workspaceSurfaceSpecs(specs).filter((s) => s.type === 'process' && processSpecWorkspace(s, [ws]) !== null);
}
