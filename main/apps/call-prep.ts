/**
 * PURE. What an allowed GApp call becomes before it is dispatched (Tynn #250).
 *
 * The page proposes; Genie disposes. A GApp's window holds developer-authored web
 * content, so nothing arriving from it may be trusted to say WHO is calling or
 * WHERE they may act. Those are facts Genie already decided in `decideAppCall`,
 * and this is where the decision is stamped over anything the page said:
 *
 *   - `workspaceId` is FORCED to the resolved workspace, not merged with it.
 *   - `terminalId` is stripped — an app has no terminal identity to assert, and
 *     letting one through would let it act as whichever agent it named.
 *   - Anything the user will read carries the app's name.
 *
 * It also has to survive whatever the page sends. A crash in here would be a
 * denial of service on the main process, triggered from inside a third-party
 * window, so every shape is handled rather than assumed.
 */

import type { AppCallDecision } from './bridge-decision';

export interface AppCallInput {
    tool: string;
    args: unknown;
}

export interface PreparedAppCall {
    jsonrpc: '2.0';
    id: number;
    method: 'tools/call';
    params: { name: string; arguments: Record<string, unknown> };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** `Example Trader (a Genie App)` — the phrase the user reads. */
function attribution(appName: string): string {
    return `${appName} (a Genie App)`;
}

/**
 * Put the app's name on anything the user will read.
 *
 * Adds, never replaces: the app's own words are what the user needs, and a prompt
 * whose text Genie rewrote would be worse than one it merely labelled.
 */
function attribute(tool: string, args: Record<string, unknown>, appName: string): void {
    const who = attribution(appName);

    if (tool === 'ForceTheQuestion' && Array.isArray(args.questions)) {
        args.questions = args.questions.map((q) =>
            isRecord(q) && typeof q.question === 'string'
                ? { ...q, question: `**${who}** asks:\n\n${q.question}` }
                : q,
        );
        return;
    }

    if (tool === 'agentinbox' && typeof args.text === 'string') {
        args.text = `[${who}] ${args.text}`;
    }
}

let nextId = 1;

export function prepareAppToolCall(
    decision: AppCallDecision,
    input: AppCallInput,
): PreparedAppCall {
    const args: Record<string, unknown> = isRecord(input.args) ? { ...input.args } : {};

    // The page does not get to choose either of these.
    args.workspaceId = decision.workspaceId;
    delete args.terminalId;

    if (decision.mustAttribute && decision.appName) {
        attribute(input.tool, args, decision.appName);
    }

    return {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: input.tool, arguments: args },
    };
}
