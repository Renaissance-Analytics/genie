import { describe, expect, it } from 'vitest';
import { decideFlowAdmission } from '../admission';
import { REFUSED_KINDS, refusalFor } from '../refusals';

/**
 * `check` HAS TO NAME THE STEPS THAT WILL NOT RUN.
 *
 * `manageFlows action:'check'` and the editor's canvas both answer through
 * `decideFlowAdmission`, and its documented promise is that it "names every step
 * that would be refused, and why". It did not.
 *
 * Measured before the fix, on a graph holding one `terminal_run` node:
 *
 *     {"allowed":true,"capabilities":[],"refusals":[]}
 *
 * The loop skipped any kind outside Genie's namespace — `if (!isGenieNodeKind
 * (kind)) continue;` — so `refusals.ts`, the table that exists to say "Genie will
 * not run this", was consulted ONLY by the executor, at run time.
 *
 * WHY THAT IS THE WORST VERSION OF THIS BUG. An agent doing the responsible thing
 * — build the graph, call `check`, act on the answer — is told a broken flow is
 * fine. It then arms it, and the flow fails on a schedule with the real reason
 * arriving in a run-history line nobody is reading. Every downstream surface
 * behaved correctly; the one that was asked "will this work?" said yes.
 *
 * Reported from a real attempt: five tries, five causes, an afternoon.
 */
const userAuthority = { kind: 'user', workspaceId: null } as never;

const graphOf = (kind: string, label = 'a step') => ({
    nodes: [{ id: 'n1', data: { kind, label } }],
    edges: [],
});

const admit = (kind: string) => decideFlowAdmission(graphOf(kind) as never, userAuthority);

describe('a kind Genie has refused is refused by check', () => {
    it('refuses terminal_run — the one that started this', () => {
        const decision = admit('terminal_run');

        expect(decision.allowed).toBe(false);
        expect(decision.refusals).toHaveLength(1);
        expect(decision.refusals[0].label).toBe('a step');
    });

    it('carries the stated reason verbatim, so the fix travels with the refusal', () => {
        // `refusals.ts` already names the step to use instead. Restating it here
        // would be the same advice in two places, free to drift.
        const decision = admit('terminal_run');

        expect(decision.refusals[0].reason).toContain(refusalFor('terminal_run') as string);
    });

    it.each(REFUSED_KINDS)('refuses %s, wherever the refusal table names it', (kind) => {
        // THE DRIFT GUARD, and the reason this is a table-driven test. Adding a
        // kind to `refusals.ts` must make `check` refuse it, or the two diverge
        // again exactly as they had — silently, and only visible at run time.
        const decision = admit(kind);

        expect(decision.allowed).toBe(false);
        expect(decision.refusals.length).toBeGreaterThan(0);
    });

    it('refuses the NAMESPACED spelling too', () => {
        // A palette writes `@particle-academy/terminal_run`; `refusalFor` strips
        // the namespace before looking up. Matching only the bare name would let
        // the real graphs through — which are the namespaced ones.
        const decision = admit('@particle-academy/terminal_run');

        expect(decision.allowed).toBe(false);
    });
});

describe('what it must still let through', () => {
    it('allows a Fancy step Genie has NOT refused', () => {
        // THE POSITIVE CONTROL. A guard that refused every non-Genie kind would
        // satisfy every assertion above and break every flow in the app — most
        // steps on a canvas are Fancy builtins that Genie neither runs nor
        // objects to.
        const decision = admit('@particle-academy/delay');

        expect(decision.allowed).toBe(true);
        expect(decision.refusals).toEqual([]);
    });

    it('still allows a Genie step', () => {
        const decision = admit('@genie/manageTerminals');

        expect(decision.allowed).toBe(true);
    });

    it('still refuses a MISSPELT Genie step', () => {
        // The pre-existing behaviour this change must not disturb: a kind inside
        // Genie's namespace resolving to no tool is a broken graph, not somebody
        // else's node.
        const decision = admit('@genie/not_a_real_tool');

        expect(decision.allowed).toBe(false);
    });
});
