import { nextCronAfter } from './cron.js';

/**
 * WHAT A FLOW WILL DO ONCE ARMED (genie#1204): its schedule and next run, and each command and agent its steps reach.
 * What the Arm confirm says — arming hands the flow to the clock, and it then acts with nobody watching (Genie 1 named
 * what an armed flow could reach before arming it).
 */
export interface FlowReach {
    /** `null` = no schedule: it runs only when started by hand. */
    readonly schedule: { cron: string; nextMs: number | null } | null;
    /** One line per step that acts, in graph order. */
    readonly steps: readonly string[];
    /** A file flow (genie#1204): which added files start it, in words — `null` for any other flow. */
    readonly file: string | null;
}

/** 5 000 000 → "5 MB" (decimal, as a file manager says it). */
function sizeWords(bytes: number): string {
    const units: [number, string][] = [[1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB']];
    for (const [n, unit] of units) if (bytes >= n) return `${Number((bytes / n).toFixed(1))} ${unit}`;
    return `${bytes} bytes`;
}

/** "a file is added to tynn, in uploads, .png or .jpg, 5 MB or more" — what the trigger's filters let through. */
function fileWords(config: Record<string, unknown>): string {
    const text = (key: string) => (typeof config[key] === 'string' ? (config[key] as string).trim() : '');
    const parts = [`a file is added to ${text('workspace')}`];
    const folder = text('folder').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (folder) parts.push(`in ${folder}`);
    const exts = text('extensions').split(',').map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter((e) => e !== '').map((e) => `.${e}`);
    if (exts.length > 0) parts.push(exts.length === 1 ? exts[0]! : `${exts.slice(0, -1).join(', ')} or ${exts.at(-1)}`);
    if (typeof config.minSizeBytes === 'number' && config.minSizeBytes > 0) parts.push(`${sizeWords(config.minSizeBytes)} or more`);
    return parts.join(', ');
}

interface NodeLike { readonly kind?: unknown; readonly config?: Record<string, unknown> }

export function flowReach(document: unknown, nowMs: number): FlowReach {
    const graph = (document as { graph?: { nodes?: unknown } } | null)?.graph;
    const nodes: NodeLike[] = Array.isArray(graph?.nodes) ? (graph!.nodes as NodeLike[]) : [];
    const kindIs = (n: NodeLike, k: string) => typeof n.kind === 'string' && new RegExp(`(^|/)${k}$`).test(n.kind);
    const text = (n: NodeLike, key: string) => (typeof n.config?.[key] === 'string' ? (n.config[key] as string).trim() : '');
    const trigger = nodes.find((n) => kindIs(n, 'schedule_trigger'));
    const cron = trigger ? text(trigger, 'cron') : '';
    const timezone = trigger ? text(trigger, 'timezone') || undefined : undefined;
    const steps: string[] = [];
    for (const n of nodes) {
        if (kindIs(n, 'terminal_run')) steps.push(`runs the command \`${text(n, 'command')}\`${text(n, 'cwd') ? ` in ${text(n, 'cwd')}` : ''}`);
        else if (kindIs(n, 'agent_prompt')) steps.push(`prompts ${text(n, 'agent')}`);
        else if (n.kind === 'genie/file_move') steps.push(`moves the file into ${text(n, 'to')}`);
    }
    const fileTrigger = nodes.find((n) => n.kind === 'genie/file_added');
    return { schedule: cron ? { cron, nextMs: nextCronAfter(cron, nowMs, timezone) } : null, steps, file: fileTrigger ? fileWords(fileTrigger.config ?? {}) : null };
}
