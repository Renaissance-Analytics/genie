import { LANG_LABEL } from '../core/toolchain-defaults.js';
import type { RepairOutcome } from '../core/toolchain.js';
import { updateRisk } from '../core/toolchain-risk.js';
import type { FeatureAction, ToolchainRefusal, ToolchainSection } from '../renderer/features.js';
import type { FeaturePorts, FeatureState } from './feature-ipc.js';
import { sitePins, type HostingFeatureServices } from './feature-hosting.js';
import type { SitePin } from './php-versions.js';
import { shouldCheckUpdates } from './toolchain-prober.js';
import type { InstallOutcome } from './toolchain-ops.js';

/** Existing owners used to restart affected work, without constructing a second supervisor. */
export type ToolchainFeatureServices = Pick<HostingFeatureServices, 'sites' | 'supervisor'>;

/** The Toolchain section: the scan, plus each further fact only when there is one (never an empty placeholder). */
export function toolchainSection(state: FeatureState): ToolchainSection | null {
    if (state.toolStatuses === null) return null;
    return {
        tools: state.toolStatuses,
        checkedAt: state.toolchainCheckedAt ?? null,
        ...(state.toolchainInstalls ? { installs: state.toolchainInstalls } : {}),
        ...(state.toolchainBusy ? { busy: state.toolchainBusy } : {}),
        ...(state.toolchainFindings ? { findings: state.toolchainFindings } : {}),
        ...(typeof state.toolchainRepairedAt === 'number' ? { repairedAt: state.toolchainRepairedAt } : {}),
        ...(state.toolchainWarning ? { warning: state.toolchainWarning } : {}),
        ...(state.toolchainUpdating ? { updating: state.toolchainUpdating } : {}),
        ...(state.toolchainUpdated ? { updated: state.toolchainUpdated } : {}),
        ...(state.toolchainResult ? { result: state.toolchainResult } : {}),
        ...(state.toolchainRefusals && state.toolchainRefusals.length > 0 ? { refusals: state.toolchainRefusals } : {}),
        ...(state.toolchainPhp ? { php: state.toolchainPhp } : {}),
        ...(state.toolchainNode ? { node: state.toolchainNode } : {}),
        ...(state.toolchainGo ? { go: state.toolchainGo } : {}),
        ...(state.toolchainPython ? { python: state.toolchainPython } : {}),
        ...(state.toolchainDotnet ? { dotnet: state.toolchainDotnet } : {}),
        ...(state.toolchainRust ? { rust: state.toolchainRust } : {}),
        ...(state.toolchainRuby ? { ruby: state.toolchainRuby } : {}),
        ...(state.toolchainJava ? { java: state.toolchainJava } : {}),
        ...(state.toolchainDefaults ? { defaults: state.toolchainDefaults } : {}),
        ...(state.toolchainMachinePath ? { machinePath: state.toolchainMachinePath } : {}),
    };
}

/** What main keeps of a toolchain action's answer for the next snapshot (the inverse of `toolchainSection`). */
export function toolchainStateFrom(section: ToolchainSection | null): Partial<FeatureState> {
    return {
        toolStatuses: section?.tools ?? null,
        toolchainCheckedAt: section?.checkedAt ?? null,
        toolchainInstalls: section?.installs ?? null,
        toolchainFindings: section?.findings ?? null,
        toolchainRepairedAt: section?.repairedAt ?? null,
        toolchainWarning: section?.warning ?? null,
        toolchainUpdating: null,
        toolchainUpdated: section?.updated ?? null,
        toolchainResult: section?.result ?? null,
        toolchainRefusals: section?.refusals ?? null,
        toolchainPhp: section?.php ?? null,
        toolchainNode: section?.node ?? null,
        toolchainGo: section?.go ?? null,
        toolchainPython: section?.python ?? null,
        toolchainDotnet: section?.dotnet ?? null,
        toolchainRust: section?.rust ?? null,
        toolchainRuby: section?.ruby ?? null,
        toolchainJava: section?.java ?? null,
        toolchainDefaults: section?.defaults ?? null,
        toolchainMachinePath: section?.machinePath ?? null,
    };
}

type ToolchainPort = NonNullable<FeaturePorts['toolchain']>;

/** Re-probe every tool (the snapshot shows the MEASURED state, never a command's word) and how each missing one would install. */
export async function rescanToolchain(next: FeatureState, tc: ToolchainPort, pins: readonly SitePin[] = []): Promise<void> {
    if (tc.php) next.toolchainPhp = await tc.php.list(pins);
    if (tc.node) next.toolchainNode = await tc.node.list();
    if (tc.go) next.toolchainGo = await tc.go.list();
    if (tc.python) next.toolchainPython = await tc.python.list();
    if (tc.dotnet) next.toolchainDotnet = await tc.dotnet.list();
    if (tc.rust) next.toolchainRust = await tc.rust.list();
    if (tc.ruby) next.toolchainRuby = await tc.ruby.list();
    if (tc.java) next.toolchainJava = await tc.java.list();
    if (tc.defaults) next.toolchainDefaults = tc.defaults.list();
    if (tc.machinePath) next.toolchainMachinePath = await tc.machinePath.status();
    const tools = await tc.probe();
    next.toolStatuses = tools;
    next.toolchainCheckedAt = tc.now();
    if (tc.preview) {
        const missing = tools.filter((t) => t.tone === 'not-installed');
        next.toolchainInstalls = Object.fromEntries(await Promise.all(missing.map(async (t) => [t.tool, await tc.preview!(t.tool)] as const)));
    }
}

const sameRow = (r: ToolchainRefusal, tool: string, version: string | undefined): boolean => r.tool === tool && r.version === version;

/** A row's next action starts clean: its old refusal goes; every other row's stays. */
export function clearRefusal(next: FeatureState, tool: string, version?: string): void {
    next.toolchainRefusals = (next.toolchainRefusals ?? []).filter((r) => !sameRow(r, tool, version));
}

/**
 * Say a refused or failed toolchain action ON ITS ROW, verbatim. It used to be thrown, which the renderer could put
 * nowhere but its console: the person clicked Update and nothing happened, with no word of who was busy.
 */
export function refuse(next: FeatureState, tool: string, reason: string, version?: string, retry?: string): void {
    clearRefusal(next, tool, version);
    next.toolchainRefusals = [...(next.toolchainRefusals ?? []), { tool, reason, ...(version !== undefined ? { version } : {}), ...(retry !== undefined ? { retry } : {}) }];
}

const LABELS: Readonly<Record<string, string>> = { php: 'PHP', node: 'Node', python: 'Python', go: 'Go' };

/**
 * AFTER AN UPDATE (genie#1306; Genie 1 told the person what keeps the old version until it restarts — toolchain-page.ts
 * `defaultChangeNotice`, "restart them to pick this up"): restart what ran on the old version — a site through its OWN
 * restart (its php-cgi re-resolved, its dev server started again), any other process by the supervisor — and say what
 * could not be. Agent sessions are never restarted mid-turn: they are named, and take it up when they next start.
 */
function restartAfterUpdate(services: ToolchainFeatureServices, ids: readonly string[]): { restarted: string[]; failed: string[] } {
    const restarted: string[] = [];
    const failed: string[] = [];
    const sitesDone = new Set<string>();
    for (const id of ids) {
        const site = services.sites.list().find((s) => s.processIds.includes(id));
        try {
            if (site) {
                if (sitesDone.has(site.id)) continue;
                sitesDone.add(site.id);
                services.sites.restart(site.id);
                restarted.push(site.host);
            } else {
                const label = services.supervisor.status(id)?.name ?? id;
                if (services.supervisor.restart(id)) restarted.push(label);
                else failed.push(`${label} (it is gone)`);
            }
        } catch (error) {
            failed.push(`${site?.host ?? id} (${error instanceof Error ? error.message : String(error)})`);
        }
    }
    return { restarted, failed };
}

function describeInstall(tool: string, outcome: Exclude<InstallOutcome, { kind: 'refused' }>): string {
    switch (outcome.kind) {
        case 'installed':
            return `${tool}${outcome.version ? ` ${outcome.version}` : ''} is installed.${outcome.note ? ` (${outcome.note})` : ''}`;
        case 'already-installed':
            return `${tool} was already installed${outcome.version ? ` (${outcome.version})` : ''}; nothing was run.`;
        case 'not-installed':
            return `${tool} was not installed: ${outcome.reason}.`;
    }
}

function describeUpdate(tool: string, outcome: RepairOutcome): string {
    switch (outcome.kind) {
        case 'repaired':
            return `${tool} updated${outcome.from ? ` from ${outcome.from}` : ''} to ${outcome.to}.${outcome.note ? ` (${outcome.note})` : ''}`;
        case 'unchanged':
        case 'unverified':
            return `${tool}: ${outcome.reason}.`;
    }
}

/** Shared check, install, update, repair, default and PATH rules. Version actions move in their own measured group. */
export async function applyToolchainCoreFeatureAction(services: ToolchainFeatureServices, action: FeatureAction,
    state: FeatureState, next: FeatureState, ports: Pick<FeaturePorts, 'toolchain'>): Promise<boolean> {
    switch (action.kind) {
        case 'toolchain.check': {
            const tc = ports.toolchain;
            if (!tc) throw new Error('no toolchain runner is wired into this Genie; the scan cannot run');
            if (shouldCheckUpdates(state.toolchainCheckedAt ?? null, tc.now(), action.force === true)) {
                await rescanToolchain(next, tc, sitePins(services));
            }
            break;
        }
        case 'toolchain.update': {
            const tc = ports.toolchain;
            if (!tc) throw new Error('no toolchain runner is wired into this Genie; the update cannot run');
            clearRefusal(next, action.tool);
            if (next.toolchainUpdated?.tool === action.tool) next.toolchainUpdated = null;
            // THE UPDATE-RISK GUARD (core/toolchain-risk.ts), read here in main from what is running NOW — never from the
            // renderer, and never optional: a guard that can be left unwired is not one.
            if (!tc.activity) {
                refuse(next, action.tool, 'the update guard is not wired into this Genie, so nothing is updated');
                break;
            }
            const known = (state.toolStatuses ?? []).find((t) => t.tool === action.tool);
            const activity = await tc.activity();
            const risk = updateRisk(action.tool, activity, { installed: known ? known.installed !== null : true });
            if (risk.risk === 'blocked') {
                refuse(next, action.tool, risk.reason);
                break;
            }
            if (risk.risk === 'warn' && action.confirmed !== true) {
                next.toolchainWarning = { tool: action.tool, ...(action.version ? { version: action.version } : {}), reason: risk.reason, affected: risk.affected };
                break;
            }
            next.toolchainWarning = null;
            // What runs on the old version NOW — the ones a restart would move (sessions are never restarted).
            const onOld = risk.risk === 'warn' ? activity.processes.filter((p) => p.id !== undefined && risk.affected.includes(p.label)) : [];
            const row = (step: string) => tc.updating?.({ tool: action.tool, ...(action.version ? { version: action.version } : {}), step });
            let outcome: Awaited<ReturnType<typeof tc.update>>;
            try {
                row('Starting');
                outcome = await tc.update(action.tool, action.version, (step) => { if (step) row(step); });
                if (outcome.kind === 'repaired' && onOld.length > 0 && action.restart !== false) row('Restarting');
            } finally {
                tc.updating?.(null);
            }
            if (outcome.kind === 'refused') {
                refuse(next, action.tool, outcome.reason);
                break;
            }
            next.toolchainResult = describeUpdate(action.tool, outcome);
            // It ran and did not take (the re-probe shows the same version, or nothing): said on the row, with a Retry.
            if (outcome.kind !== 'repaired') refuse(next, action.tool, outcome.reason, undefined, action.version ?? '');
            if (outcome.kind === 'repaired') {
                next.toolchainUpdated = { tool: action.tool, version: outcome.to };
                const label = LABELS[action.tool] ?? action.tool;
                const sessions = risk.risk === 'warn' ? risk.affected.filter((a) => !onOld.some((p) => p.label === a)) : [];
                const notes: string[] = [];
                if (onOld.length > 0 && action.restart !== false) {
                    const { restarted, failed } = restartAfterUpdate(services, onOld.map((p) => p.id!));
                    if (restarted.length > 0) notes.push(`Restarted ${restarted.length}.`);
                    if (failed.length > 0) notes.push(`Not restarted: ${failed.join(', ')}.`);
                } else if (onOld.length > 0) {
                    notes.push(`Restart to use it: ${onOld.map((p) => p.label).join(', ')}.`);
                }
                if (sessions.length > 0) notes.push(`${sessions.join(', ')} ${sessions.length === 1 ? 'picks' : 'pick'} it up when next started.`);
                next.toolchainResult = `${label} ${outcome.from ?? ''}${outcome.from ? ' → ' : ''}${outcome.to}.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}${outcome.note ? ` (${outcome.note})` : ''}`;
            }
            // The snapshot shows the RE-PROBE, never the command's word; and the cache is dropped.
            await rescanToolchain(next, tc, sitePins(services));
            break;
        }
        case 'toolchain.install': {
            clearRefusal(next, action.tool);
            // Consent first, before anything is asked of the machine: no consent, nothing runs.
            if (action.consent !== true) {
                refuse(next, action.tool, `Genie installs nothing without your go-ahead; ${action.tool} was not installed`);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.install) {
                refuse(next, action.tool, 'no installer is wired into this Genie; nothing was installed');
                break;
            }
            const outcome = await tc.install(action.tool, true);
            if (outcome.kind === 'refused') {
                refuse(next, action.tool, outcome.reason);
                break;
            }
            next.toolchainResult = describeInstall(action.tool, outcome);
            if (outcome.kind === 'not-installed') refuse(next, action.tool, outcome.reason);
            // A prerequisite now present is no longer a finding.
            if (outcome.kind !== 'not-installed' && next.toolchainFindings) {
                next.toolchainFindings = next.toolchainFindings.filter((f) => !(f.result.kind === 'needs-install' && f.result.tool === action.tool));
            }
            await rescanToolchain(next, tc, sitePins(services));
            break;
        }
        case 'toolchain.repair': {
            const tc = ports.toolchain;
            if (!tc?.repair) throw new Error('Check and repair is not wired into this Genie; nothing was checked');
            const report = await tc.repair();
            next.toolchainFindings = report.findings;
            next.toolchainRepairedAt = report.checkedAt;
            const repaired = report.findings.filter((f) => f.result.kind === 'repaired').length;
            next.toolchainResult =
                report.findings.length === 0
                    ? "Nothing to repair: each tool runs its newest copy, PHP has a CA bundle, and nothing PHP needs is missing."
                    : `${report.findings.length} problem${report.findings.length === 1 ? '' : 's'} found, ${repaired} repaired.`;
            await rescanToolchain(next, tc, sitePins(services));
            break;
        }
        case 'toolchain.machinePath': {
            const tc = ports.toolchain;
            clearRefusal(next, 'machine-path');
            if (!tc?.machinePath) {
                refuse(next, 'machine-path', 'no machine-PATH switch is wired into this Genie; nothing was changed');
                break;
            }
            const outcome = action.apply ? await tc.machinePath.apply(action.consent === true) : await tc.machinePath.remove();
            if (outcome.kind === 'refused' || outcome.kind === 'not-applied') refuse(next, 'machine-path', outcome.reason);
            else next.toolchainResult = outcome.kind === 'applied'
                ? `Genie's defaults are on your PATH (${outcome.where.join(', ')}): terminals outside Genie use them once they are opened again.`
                : `Genie's defaults are off your PATH again (${outcome.where.join(', ') || 'nothing to remove'}); it is as it was.`;
            next.toolchainMachinePath = await tc.machinePath.status();
            break;
        }
        case 'toolchain.setDefault': {
            const tc = ports.toolchain;
            const lang = action.lang;
            const label = LANG_LABEL[lang];
            clearRefusal(next, `${lang}-default`);
            if (!tc?.defaults) {
                refuse(next, `${lang}-default`, `no default switch is wired into this Genie; ${label}'s default was not changed`);
                break;
            }
            const outcome = tc.defaults.set(lang, action.version);
            if (outcome.kind === 'refused') refuse(next, `${lang}-default`, outcome.reason);
            else next.toolchainResult = outcome.kind === 'set'
                ? `${label} ${outcome.version} is now the default — what \`${lang}\` means for Genie's terminals, processes and agents.`
                : `${label}'s default is the one on your PATH again.`;
            next.toolchainDefaults = tc.defaults.list();
            break;
        }
        case 'toolchain.installNode': {
            clearRefusal(next, 'node', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'node', `Genie installs nothing without your go-ahead; Node ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.node) {
                refuse(next, 'node', 'no Node version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.node.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'node', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Node ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Node ${outcome.version} was already installed; nothing was downloaded.`
                    : `Node ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainNode = await tc.node.list();
            break;
        }
        case 'toolchain.removeNode': {
            {
                const current = ports.toolchain?.defaults?.list()['node'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'node', action.version);
                    refuse(next, 'node', `${LANG_LABEL['node']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'node', action.version);
            if (!tc?.node) {
                refuse(next, 'node', 'no Node version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.node.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'node', outcome.reason, action.version);
            else next.toolchainResult = `Node ${outcome.version} was removed.`;
            next.toolchainNode = await tc.node.list();
            break;
        }
        case 'toolchain.installGo': {
            clearRefusal(next, 'go', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'go', `Genie installs nothing without your go-ahead; Go ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.go) {
                refuse(next, 'go', 'no Go version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.go.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'go', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Go ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Go ${outcome.version} was already installed; nothing was downloaded.`
                    : `Go ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainGo = await tc.go.list();
            break;
        }
        case 'toolchain.removeGo': {
            {
                const current = ports.toolchain?.defaults?.list()['go'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'go', action.version);
                    refuse(next, 'go', `${LANG_LABEL['go']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'go', action.version);
            if (!tc?.go) {
                refuse(next, 'go', 'no Go version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.go.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'go', outcome.reason, action.version);
            else next.toolchainResult = `Go ${outcome.version} was removed.`;
            next.toolchainGo = await tc.go.list();
            break;
        }
        case 'toolchain.installPhp': {
            clearRefusal(next, 'php', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'php', `Genie installs nothing without your go-ahead; PHP ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.php) {
                refuse(next, 'php', 'no PHP version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.php.install(action.version, true);
            if (outcome.kind === 'refused') {
                refuse(next, 'php', outcome.reason, action.version);
                break;
            }
            if (outcome.kind === 'not-installed') refuse(next, 'php', outcome.reason, action.version);
            next.toolchainResult =
                outcome.kind === 'installed' ? `PHP ${outcome.version} is installed; a php site can be pinned to it.`
                : outcome.kind === 'already-installed' ? `PHP ${outcome.version} was already installed; nothing was downloaded.`
                : `PHP ${action.version} was not installed: ${outcome.reason}.`;
            next.toolchainPhp = await tc.php.list(sitePins(services));
            break;
        }
        case 'toolchain.removePhp': {
            {
                const current = ports.toolchain?.defaults?.list()['php'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'php', action.version);
                    refuse(next, 'php', `${LANG_LABEL['php']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'php', action.version);
            if (!tc?.php) {
                refuse(next, 'php', 'no PHP version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.php.remove(action.version, sitePins(services));
            if (outcome.kind === 'refused') {
                refuse(next, 'php', outcome.reason, action.version);
                break;
            }
            next.toolchainResult = `PHP ${outcome.version} was removed.`;
            next.toolchainPhp = await tc.php.list(sitePins(services));
            break;
        }
        case 'toolchain.installPython': {
            clearRefusal(next, 'python', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'python', `Genie installs nothing without your go-ahead; Python ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.python) {
                refuse(next, 'python', 'no Python version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.python.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'python', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Python ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Python ${outcome.version} was already installed; nothing was downloaded.`
                    : `Python ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainPython = await tc.python.list();
            break;
        }
        case 'toolchain.removePython': {
            {
                const current = ports.toolchain?.defaults?.list()['python'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'python', action.version);
                    refuse(next, 'python', `${LANG_LABEL['python']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'python', action.version);
            if (!tc?.python) {
                refuse(next, 'python', 'no Python version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.python.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'python', outcome.reason, action.version);
            else next.toolchainResult = `Python ${outcome.version} was removed.`;
            next.toolchainPython = await tc.python.list();
            break;
        }
        case 'toolchain.installDotnet': {
            clearRefusal(next, 'dotnet', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'dotnet', `Genie installs nothing without your go-ahead; .NET SDK ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.dotnet) {
                refuse(next, 'dotnet', 'no .NET version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.dotnet.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'dotnet', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `.NET SDK ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `.NET SDK ${outcome.version} was already installed; nothing was downloaded.`
                    : `.NET SDK ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainDotnet = await tc.dotnet.list();
            break;
        }
        case 'toolchain.removeDotnet': {
            {
                const current = ports.toolchain?.defaults?.list()['dotnet'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'dotnet', action.version);
                    refuse(next, 'dotnet', `${LANG_LABEL['dotnet']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'dotnet', action.version);
            if (!tc?.dotnet) {
                refuse(next, 'dotnet', 'no .NET version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = await tc.dotnet.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'dotnet', outcome.reason, action.version);
            else next.toolchainResult = `.NET SDK ${outcome.version} was removed.`;
            next.toolchainDotnet = await tc.dotnet.list();
            break;
        }
        case 'toolchain.installRust': {
            clearRefusal(next, 'rust', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'rust', `Genie installs nothing without your go-ahead; Rust ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.rust) {
                refuse(next, 'rust', 'no Rust version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.rust.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'rust', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Rust ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Rust ${outcome.version} was already installed; nothing was downloaded.`
                    : `Rust ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainRust = await tc.rust.list();
            break;
        }
        case 'toolchain.removeRust': {
            {
                const current = ports.toolchain?.defaults?.list()['rust'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'rust', action.version);
                    refuse(next, 'rust', `${LANG_LABEL['rust']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'rust', action.version);
            if (!tc?.rust) {
                refuse(next, 'rust', 'no Rust version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.rust.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'rust', outcome.reason, action.version);
            else next.toolchainResult = `Rust ${outcome.version} was removed.`;
            next.toolchainRust = await tc.rust.list();
            break;
        }
        case 'toolchain.installRuby': {
            clearRefusal(next, 'ruby', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'ruby', `Genie installs nothing without your go-ahead; Ruby ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.ruby) {
                refuse(next, 'ruby', 'no Ruby version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.ruby.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'ruby', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Ruby ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Ruby ${outcome.version} was already installed; nothing was downloaded.`
                    : `Ruby ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainRuby = await tc.ruby.list();
            break;
        }
        case 'toolchain.removeRuby': {
            {
                const current = ports.toolchain?.defaults?.list()['ruby'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'ruby', action.version);
                    refuse(next, 'ruby', `${LANG_LABEL['ruby']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'ruby', action.version);
            if (!tc?.ruby) {
                refuse(next, 'ruby', 'no Ruby version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.ruby.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'ruby', outcome.reason, action.version);
            else next.toolchainResult = `Ruby ${outcome.version} was removed.`;
            next.toolchainRuby = await tc.ruby.list();
            break;
        }
        case 'toolchain.installJava': {
            clearRefusal(next, 'java', action.version);
            // Consent first: no consent, nothing is downloaded.
            if (action.consent !== true) {
                refuse(next, 'java', `Genie installs nothing without your go-ahead; Java ${action.version} was not installed`, action.version);
                break;
            }
            const tc = ports.toolchain;
            if (!tc?.java) {
                refuse(next, 'java', 'no Java version manager is wired into this Genie; nothing was installed', action.version);
                break;
            }
            const outcome = await tc.java.install(action.version, true);
            if (outcome.kind === 'refused' || outcome.kind === 'not-installed') refuse(next, 'java', outcome.reason, action.version);
            if (outcome.kind !== 'refused') {
                next.toolchainResult =
                    outcome.kind === 'installed' ? `Java ${outcome.version} is installed in Genie's toolchain.`
                    : outcome.kind === 'already-installed' ? `Java ${outcome.version} was already installed; nothing was downloaded.`
                    : `Java ${action.version} was not installed: ${outcome.reason}.`;
            }
            next.toolchainJava = await tc.java.list();
            break;
        }
        case 'toolchain.removeJava': {
            {
                const current = ports.toolchain?.defaults?.list()['java'] ?? null;
                if (current !== null && current === action.version) {
                    clearRefusal(next, 'java', action.version);
                    refuse(next, 'java', `${LANG_LABEL['java']} ${action.version} is the default; make another version the default (or use the system's) first, then remove it`, action.version);
                    break;
                }
            }
            const tc = ports.toolchain;
            clearRefusal(next, 'java', action.version);
            if (!tc?.java) {
                refuse(next, 'java', 'no Java version manager is wired into this Genie; nothing was removed', action.version);
                break;
            }
            const outcome = tc.java.remove(action.version);
            if (outcome.kind === 'refused') refuse(next, 'java', outcome.reason, action.version);
            else next.toolchainResult = `Java ${outcome.version} was removed.`;
            next.toolchainJava = await tc.java.list();
            break;
        }
        default: return false;
    }
    return true;
}
