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
    }
    return { schedule: cron ? { cron, nextMs: nextCronAfter(cron, nowMs, timezone) } : null, steps };
}
