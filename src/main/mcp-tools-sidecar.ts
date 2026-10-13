import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import type { AgentId, AgentRecord } from '../core/identity.js';

type AcpProvider = AgentRecord['provider'];
import { sidecarPlan } from '../core/sidecar.js';
import { MIRRORED_TERMINAL_ID, type Caller, type Registration, type ToolContext } from './mcp-tools.js';

/**
 * `runAgent {action:"sidecar", agent}` (§6.2): the caller's review partner. Registers `<driver>-slave` in
 * the caller's workspace with `sidecarOf` the caller, starts it at the caller's cwd, and answers with its
 * id and AgentInbox address. A second call rejoins the existing one (no second start). A sidecar asking
 * for a sidecar is refused. Nothing here stops anything: Genie never stops a sidecar for you.
 */

export interface SidecarToolsDeps {
    readonly resolveCaller: (terminalId: string) => Caller | null;
    readonly roster: () => readonly AgentRecord[];
    readonly register: (input: { workspaceId: string; provider: AcpProvider; name: string; sidecarOf: AgentId }) => Promise<AgentRecord>;
    readonly start: (record: AgentRecord, cwd: string) => { ok: true } | { ok: false; reason: string };
    readonly running: (agentId: string) => boolean;
    readonly addressOf: (record: AgentRecord) => string;
}

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });

function callerOf(deps: SidecarToolsDeps, args: JsonObject, context: ToolContext): Caller | string {
    const fromArgs = typeof args.terminalId === 'string' ? args.terminalId : undefined;
    const fromHeader = context.headers['mcp-param-terminalid'] ?? context.headers['Mcp-Param-TerminalId'];
    const terminalId = fromArgs ?? (typeof fromHeader === 'string' ? fromHeader : undefined);
    if (!terminalId) return 'terminalId is required: pass GENIE_TERMINAL_ID; Genie does not guess which terminal is calling';
    return deps.resolveCaller(terminalId) ?? `no agent is registered for terminal ${terminalId}`;
}

export function sidecarTools(deps: SidecarToolsDeps): Registration[] {
    const runAgent: Registration = {
        definition: new ToolDefinition(
            'runAgent',
            'Run your sidecar: action "sidecar" with agent "claude" or "codex" registers <agent>-slave in your workspace (your own review partner, its own identity and context), starts it beside you and answers with its AgentInbox address. Calling again rejoins the same one. Genie never stops a sidecar for you.',
            {
                type: 'object',
                properties: {
                    terminalId: MIRRORED_TERMINAL_ID,
                    action: { type: 'string', enum: ['sidecar'] },
                    agent: { type: 'string', enum: ['claude', 'codex'], description: 'The driver of the sidecar.' },
                },
                required: ['terminalId', 'action', 'agent'],
            },
            'Run agent',
        ),
        handler: async (args, context) => {
            const caller = callerOf(deps, args, context);
            if (typeof caller === 'string') return err(caller);
            if (args.action !== 'sidecar') return err('action is "sidecar" — the only agent runAgent runs is your own sidecar');
            const driver = args.agent;
            if (driver !== 'claude' && driver !== 'codex') return err('agent is claude or codex');
            const plan = sidecarPlan({ caller: { id: caller.agentId, name: caller.agentName, workspaceId: caller.workspaceId }, driver, existing: deps.roster() });
            if (plan.kind === 'refused') return err(plan.reason);
            const record = plan.kind === 'existing' ? plan.record : await deps.register({ workspaceId: plan.workspaceId, provider: plan.provider, name: plan.name, sidecarOf: plan.sidecarOf as AgentId });
            let started = false;
            if (!deps.running(record.id)) {
                const result = deps.start(record, caller.workspacePath);
                if (!result.ok) return err(`${record.name} could not start: ${result.reason}`);
                started = true;
            }
            return ok({ ok: true, agentId: record.id, name: record.name, address: deps.addressOf(record), started, rejoined: plan.kind === 'existing' });
        },
    };
    return [runAgent];
}
