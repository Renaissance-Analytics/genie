import { isAbsolute, relative, resolve } from 'node:path';
import { ToolDefinition, type JsonObject, type McpToolResult } from '@particle-academy/prism-mcp';
import type { FeedbackKind, FeedbackStore } from './feedback-store.js';
import { MIRRORED_TERMINAL_ID, type Caller, type Registration, type ToolContext, type ToolHandler } from './mcp-tools.js';

/**
 * THE TWO ATTENTION TOOLS THAT WERE MISSING (§6.3). `openFileForUser` puts a file in front of the
 * person: the path is CONFINED to the caller's workspace, so an agent cannot open the host's own files
 * through it, and a refusal names whose workspace. `submitFeedback` records what the agent thinks of
 * Genie, durably, saying plainly that it stays on this machine until Tynn is connected.
 */

export interface AttentionToolsDeps {
    readonly resolveCaller: (terminalId: string) => Caller | null;
    /** Put the file in front of the person (the host's own opener, or the files panel). */
    readonly openFile: (absolutePath: string, line: number | null) => Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly feedback: FeedbackStore;
}

const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false });
const err = (message: string): McpToolResult => ({ text: JSON.stringify({ ok: false, error: message }), isError: true });
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The absolute path when it lies inside the workspace, else `null`. `..` and absolute escapes both fail here. */
export function confineToWorkspace(workspacePath: string, requested: string): string | null {
    const abs = isAbsolute(requested) ? resolve(requested) : resolve(workspacePath, requested);
    const rel = relative(resolve(workspacePath), abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return rel === '' ? abs : null;
    return abs;
}

export function attentionTools(deps: AttentionToolsDeps): Registration[] {
    const withCaller = (body: (caller: Caller, args: JsonObject, context: ToolContext) => McpToolResult | Promise<McpToolResult>): ToolHandler => async (args, context) => {
        const headerValue = Object.entries(context.headers).find(([k]) => k.toLowerCase() === 'mcp-param-terminalid')?.[1];
        const terminalId = str(args.terminalId) ?? headerValue;
        if (!terminalId) return err('terminalId is required — pass the value of GENIE_TERMINAL_ID; Genie will not guess which terminal is calling');
        const caller = deps.resolveCaller(terminalId);
        if (!caller) return err(`terminal ${terminalId} is not one Genie knows; nothing was done`);
        try {
            return await body(caller, args, context);
        } catch (error) {
            return err((error as Error).message);
        }
    };

    const openFileForUser: Registration = {
        definition: new ToolDefinition(
            'openFileForUser',
            'Put a file from your workspace in front of the person, optionally at a line. The path must be inside your workspace; anything outside is refused.',
            { type: 'object', properties: { terminalId: MIRRORED_TERMINAL_ID, path: { type: 'string' }, line: { type: 'number' } }, required: ['terminalId', 'path'] },
            'Open file for user',
        ),
        handler: withCaller(async (caller, args) => {
            const requested = str(args.path);
            if (!requested) return err('openFileForUser needs `path`');
            const abs = confineToWorkspace(caller.workspacePath, requested);
            if (abs === null) return err(`${requested} is outside ${caller.agentName}’s workspace (${caller.workspacePath}); Genie opens nothing there`);
            const line = typeof args.line === 'number' && args.line > 0 ? Math.floor(args.line) : null;
            const r = await deps.openFile(abs, line);
            return r.ok ? ok({ ok: true, path: abs, line }) : err(r.reason);
        }),
    };

    const submitFeedback: Registration = {
        definition: new ToolDefinition(
            'submitFeedback',
            'Tell Genie’s makers something about Genie itself — a bug, an idea, or praise. Kept on this machine until Tynn is connected; the answer says so.',
            { type: 'object', properties: { terminalId: MIRRORED_TERMINAL_ID, kind: { type: 'string', enum: ['bug', 'idea', 'praise'] }, text: { type: 'string' } }, required: ['terminalId', 'kind', 'text'] },
            'Submit feedback',
        ),
        handler: withCaller((caller, args) => {
            const item = deps.feedback.add({ workspaceId: caller.workspaceId, agentName: caller.agentName, kind: (str(args.kind) ?? '') as FeedbackKind, text: str(args.text) ?? '' });
            return ok({ ok: true, id: item.id, kept: 'on this machine; Tynn is not connected, so nothing was sent' });
        }),
    };

    return [openFileForUser, submitFeedback];
}
