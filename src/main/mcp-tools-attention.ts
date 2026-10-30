import { callerFrom } from './mcp-callers.js';
import { relative, resolve } from 'node:path';
import { confinePath, OutsideWorkspaceError } from './workspace-confine.js';
import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import { MIRRORED_TERMINAL_ID, type Caller, type Registration, type ToolContext, type ToolHandler } from './mcp-tools.js';

/**
 * THE ATTENTION TOOL (§6.3). `openFileForUser` puts a file in front of the person: the path is CONFINED to the caller's
 * workspace by the shared check (workspace-confine.ts — after links too, genie#1354), so an agent cannot open the host's own files through it, and a refusal names whose workspace.
 * (`submitFeedback` was removed — the owner, 2026-10-18; the person's Feedback window files to Tynn, Tynn #760.)
 */

export interface AttentionToolsDeps {
    readonly resolveCaller: (terminalId: string) => Caller | null;
    /**
     * Put the file in front of the person — in GENIE, that workspace's own file panel (genie#922): main is handed the
     * workspace and the path RELATIVE to it, never just an absolute path the OS's default app would take.
     */
    readonly openFile: (target: { workspaceId: string; path: string; absolutePath: string; line: number | null }) => Promise<{ ok: true } | { ok: false; reason: string }>;
    /** Hand the caller's plan to its session (`SessionHost.reportPlan`); `false` = it has no running session. Absent = refused. */
    readonly reportPlan?: (agentId: string, steps: readonly { content: string; status: string }[]) => boolean;
    /** The caller's KEPT plan (identity.ts `plan`), running or not; `null` = it has reported none. Absent = cannot read. */
    readonly readPlan?: (agentId: string) => readonly { content: string; status: string }[] | null;
}

/** The statuses a plan step may have — the ones ACP plan entries use, and the column draws (✓ ◐ ○). */
const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const;

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function attentionTools(deps: AttentionToolsDeps): Registration[] {
    const withCaller = (body: (caller: Caller, args: JsonObject, context: ToolContext) => McpToolResult | Promise<McpToolResult>): ToolHandler => async (args, context) => {
        const caller = callerFrom(args, context.headers, deps.resolveCaller);
        if (typeof caller === 'string') return err(caller);
        try {
            return await body(caller, args, context);
        } catch (error) {
            return err((error as Error).message);
        }
    };

    const openFileForUser: Registration = {
        definition: new ToolDefinition(
            'openFileForUser',
            'Open a file from your workspace for the person in your workspace’s file panel, optionally at a line. It never moves their view or keyboard: your workspace’s row pulses, and the file is open when they go there. The path must be inside your workspace; anything outside is refused.',
            { type: 'object', properties: { terminalId: MIRRORED_TERMINAL_ID, path: { type: 'string' }, line: { type: 'number' } }, required: ['path'] },
            'Open file for user',
        ),
        handler: withCaller(async (caller, args) => {
            const requested = str(args.path);
            if (!requested) return err('openFileForUser needs `path`');
            // The SHARED check (genie#1354, workspace-confine.ts): lexical, then after links — a symlink or junction inside the
            // workspace that leads out of it is refused, and a name that only starts with two dots (`..config`) is inside.
            let abs: string;
            try {
                abs = await confinePath(caller.workspacePath, requested, 'Genie opens nothing there');
            } catch (error) {
                if (error instanceof OutsideWorkspaceError) return err(`${requested} is outside ${caller.agentName}’s workspace (${caller.workspacePath}); Genie opens nothing there`);
                throw error;
            }
            const line = typeof args.line === 'number' && args.line > 0 ? Math.floor(args.line) : null;
            const rel = relative(resolve(caller.workspacePath), abs).split(/[\\/]/).join('/');
            const r = await deps.openFile({ workspaceId: caller.workspaceId, path: rel, absolutePath: abs, line });
            return r.ok ? ok({ ok: true, path: abs, line }) : err(r.reason);
        }),
    };

    /*
     * THE PLAN (the owner, 2026-10-20: "why would you build an ActivePlan column and feature but then not include any way
     * for you to use it?"). The caller's whole plan, every call: what it shows replaces what it showed. The steps reach
     * the caller's OWN session as a plan event, so the Active Plan column and the Stream show them for any provider.
     *
     * READ BACK without `steps` (the owner, 2026-10-21: "The plan loaded in genie should survive a restart, how else will
     * agents know what to pick up on."): the plan Genie keeps for the caller, across relaunches and fresh conversations.
     */
    const plan: Registration = {
        definition: new ToolDefinition(
            'plan',
            'Show your plan in your Active Plan column: the WHOLE list each time, every step with a status — pending, in_progress (the one you are on) or completed. Call it when you start work with more than one step, and again as each step starts or finishes. Genie keeps your latest plan across restarts and new conversations: call it without `steps` to read that plan back — do this when you start, to pick up where you left off.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    steps: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: [...PLAN_STATUSES] } }, required: ['content', 'status'] } },
                },
            },
            'Plan',
        ),
        handler: withCaller(async (caller, args) => {
            // No `steps` at all: a READ of the kept plan. An empty or malformed `steps` is still a write, and refused below.
            if (args.steps === undefined) {
                if (!deps.readPlan) return err('this Genie cannot read plans back');
                const kept = deps.readPlan(caller.agentId);
                if (!kept || kept.length === 0) return ok({ ok: true, steps: null, note: `${caller.agentName} has no plan kept; report one with steps` });
                return ok({ ok: true, steps: kept.map((s) => ({ content: s.content, status: s.status })), step: kept.filter((s) => s.status === 'completed').length, of: kept.length });
            }
            const raw = Array.isArray(args.steps) ? args.steps : null;
            if (!raw || raw.length === 0) return err('plan needs `steps`: the whole list, each { content, status }');
            const steps: Array<{ content: string; status: string }> = [];
            for (const [i, s] of raw.entries()) {
                const r = (typeof s === 'object' && s !== null ? s : {}) as Record<string, unknown>;
                const content = typeof r.content === 'string' ? r.content.trim() : '';
                const status = typeof r.status === 'string' ? r.status : '';
                if (content === '') return err(`step ${i + 1} has no content`);
                if (!(PLAN_STATUSES as readonly string[]).includes(status)) return err(`step ${i + 1}: status "${status}" is not one of ${PLAN_STATUSES.join(', ')}`);
                steps.push({ content, status });
            }
            if (!deps.reportPlan) return err('this Genie cannot show plans');
            if (!deps.reportPlan(caller.agentId, steps)) return err(`${caller.agentName} has no running session to show a plan in`);
            return ok({ ok: true, step: steps.filter((s) => s.status === 'completed').length, of: steps.length });
        }),
    };

    return [openFileForUser, plan];
}
