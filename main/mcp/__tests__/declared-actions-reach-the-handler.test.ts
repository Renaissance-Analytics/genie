import { describe, expect, it, vi } from 'vitest';
import { CORE_TOOLS, handleMcpMessage, type McpContext } from '../protocol';

/**
 * EVERY ACTION A TOOL DECLARES MUST SURVIVE THE DISPATCHER.
 *
 * genie#495 and genie#504 are the same defect in two tools: a hand-written
 * `action !== 'a' && action !== 'b' && …` chain sitting behind a JSON-Schema
 * enum that already listed the answer. `manageWorkspaces add` and
 * `runAgent switchTui` were both declared, documented, implemented — and
 * refused, by an error message that did not mention them, so the caller reads
 * it as "I was wrong about the API" and stops.
 *
 * ## Why this test is shaped like a CALL
 *
 * genie#322 fixed the `manageWorkspaces` enum and shipped a regression test
 * that reads `MANAGE_WORKSPACES_TOOL.inputSchema.properties.action.enum` and
 * the tool description, and checks they agree. Its docblock says *"the JSON
 * schema is the half that decides"*. It is not: there are three halves — the
 * schema, this dispatcher, and the argument forwarding — and that test pins the
 * one that was already fixed. It stayed green for `add` and would have been
 * just as green for `switchTui`.
 *
 * So this asserts the only thing that actually matters to a caller: **dispatch
 * the action and see whether it gets through.** A test about a definition
 * cannot catch a gate that lives somewhere else.
 *
 * ## The positive control
 *
 * "No enumerated action is refused" passes beautifully against a dispatcher
 * with no guard at all — delete the check and this suite goes green while every
 * tool accepts garbage. So the same tools must still REFUSE an action they do
 * not declare, in the same run.
 */

/** The `action` enum a tool declares, or null when it takes no action. */
function declaredActions(tool: unknown): string[] | null {
    const schema = (tool as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema;
    const action = schema?.properties?.action as { enum?: unknown } | undefined;
    return Array.isArray(action?.enum) ? (action!.enum as string[]).map(String) : null;
}

const ACTION_TOOLS = CORE_TOOLS.filter((t) => declaredActions(t) !== null);

/**
 * A context whose handlers all answer, so a call that gets PAST the guard fails
 * (if at all) for its own reasons rather than for want of a mock.
 */
function ctx(): McpContext {
    const answer = vi.fn().mockResolvedValue({
        ok: true,
        workspaces: [],
        terminals: [],
        agents: [],
        messages: [],
        items: [],
        results: [],
        processes: [],
        sites: [],
        services: [],
        flows: [],
    });
    return new Proxy(
        {
            terminalId: 'term-1',
            serverName: 'genie',
            serverVersion: '0.7.0-test',
        } as Record<string, unknown>,
        {
            get: (target, prop: string) => target[prop] ?? answer,
        },
    ) as unknown as McpContext;
}

type Dispatched = {
    error?: { code: number; message: string };
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
} | null;

async function dispatch(name: string, action: string): Promise<Dispatched | 'threw'> {
    try {
        return (await handleMcpMessage(
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { action } } },
            ctx(),
        )) as Dispatched;
    } catch {
        // Past the guard and failed for its own reasons, which is all this asks.
        return 'threw';
    }
}

/**
 * Was this call refused BY THE ACTION GUARD?
 *
 * Narrow on purpose: matched on the guard's own phrasing, so a call that fails
 * further in — a missing `name`, an unavailable handler — is not miscounted.
 */
async function guardRefusal(name: string, action: string): Promise<false | string> {
    const res = await dispatch(name, action);
    if (res === 'threw') return false;
    const error = res?.error;
    if (!error || error.code !== -32602) return false;
    return /requires `action`/.test(error.message) ? error.message : false;
}

/**
 * Tools that validate `action` in the HANDLER rather than the dispatcher.
 *
 * `manageFlows` passes `arguments` straight through and refuses an unknown
 * action at `main/flows/mcp.ts:271`, in-band, with a message that lists every
 * action AND explains the one that always refuses. That is BETTER than a bare
 * `-32602`, and this test must not push it toward a worse answer for the sake
 * of looking uniform — demanding a dispatcher guard would be mandating a
 * mechanism where the requirement is behaviour.
 *
 * This harness mocks every handler, so it cannot observe that refusal. The
 * first draft of this file reported `manageFlows` as a third defect on exactly
 * that basis, and it is not one.
 *
 * DECLARED, and asserted in BOTH directions below, so it cannot become a place
 * to hide a tool whose guard quietly went missing.
 */
const HANDLER_VALIDATES_ACTION = new Set(['manageFlows']);

describe('every action a tool declares survives the dispatcher', () => {
    it('finds the tools that take an action', () => {
        // POSITIVE CONTROL for the sweep itself: an empty list would make every
        // `it.each` below vacuous and the suite would report success having
        // asserted nothing.
        expect(ACTION_TOOLS.length).toBeGreaterThanOrEqual(6);
    });

    it('exempts exactly the tools whose handler does the validating', async () => {
        // The exemption asserted in BOTH directions. Without this, adding a name
        // to `HANDLER_VALIDATES_ACTION` would be a way to silence a tool whose
        // guard had genuinely gone missing — and a tool that GAINS a dispatcher
        // guard would keep an exemption it no longer needs.
        const unguarded: string[] = [];
        for (const tool of ACTION_TOOLS) {
            if (!(await guardRefusal(tool.name, '__not_a_real_action__'))) unguarded.push(tool.name);
        }
        expect(unguarded.sort()).toEqual([...HANDLER_VALIDATES_ACTION].sort());
    });

    for (const tool of ACTION_TOOLS) {
        const actions = declaredActions(tool)!;
        describe(tool.name, () => {
            it.each(actions)('accepts `%s`', async (action) => {
                const refusal = await guardRefusal(tool.name, action);
                expect(
                    refusal,
                    `${tool.name} declares \`${action}\` in its schema enum, and its dispatcher ` +
                        `refuses it: "${refusal}". The refusal does not even name the action, so a ` +
                        `caller reads it as "this action does not exist" and stops (genie#495, ` +
                        `genie#504). Derive the guard from the enum instead of restating it.`,
                ).toBe(false);
            });

            if (HANDLER_VALIDATES_ACTION.has(tool.name)) return;

            it('still refuses an action it does not declare', async () => {
                // THE POSITIVE CONTROL. Without it, deleting every guard would
                // make this whole file green while every tool accepted garbage.
                expect(await guardRefusal(tool.name, '__not_a_real_action__')).toBeTruthy();
            });

            it('names every real action when it refuses one', async () => {
                // The refusals behind genie#495 and genie#504 listed only the
                // actions their hand-written chain knew about, so the message
                // actively denied the missing one existed and the caller stopped.
                // A message built from the enum cannot do that.
                const message = await guardRefusal(tool.name, '__not_a_real_action__');
                for (const action of actions) expect(String(message)).toContain(action);
            });
        });
    }
});
