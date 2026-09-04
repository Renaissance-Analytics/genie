import { describe, expect, it } from 'vitest';
import { agentUpgradeGuide } from '../upgrade-guide';

/**
 * `agentUpgrade` must ESTABLISH that its caller can execute step 1 (genie#372).
 *
 * The beta.297 upgrade notice tells every pre-AMS terminal to *"call
 * `agentUpgrade` and follow its ordered migration guide"*. The tool answered
 * with the same five steps for every caller, and for the workstation operator
 * step 1 is refused twice over:
 *
 *   - `GENIE_OS_AGENT` is *"intentionally not persisted as a workspace agent"*
 *     (`main/agents/os-agent.ts:1`) — registering it is not a step it skipped,
 *     it is a thing that must never happen; and
 *   - its stable name is `genie`, which `reservedNameRefusal` blocks unless the
 *     owning workspace carries that `sacred_name`, and the `__system__` row is
 *     written with `sacred_name` NULL (`main/db.ts:2977`).
 *
 * Steps 2 and 5 hang off step 1, so the whole guide was unreachable — and it was
 * re-delivered on every upgrade, which the operator takes more often than any
 * other agent. That is the same class of defect beta.297 set out to remove:
 * *"ten places said done, ready or sent without establishing it"*.
 *
 * Pure, and separate from the DB read that gathers the facts, because each of
 * these outcomes is a claim about the caller and asserting them must not need an
 * MCP server, a database, or a live operator terminal.
 */

const ORDINARY = {
    workspaceId: 'ws-1',
    isWorkstationOperator: false,
    registeredAs: null,
} as const;

/**
 * The contract is "never ISSUES the instruction", not "never says the word".
 *
 * Each non-migratable answer names `registerAgent` while explaining that it
 * would be refused — which is the sentence that stops the agent trying again on
 * the next upgrade, so it earns its place. What must never appear is the
 * imperative: the numbered step that sends the caller off to run it.
 */
const REGISTER_INSTRUCTION = /1\.\s*Call `registerAgent`/;

describe('the AMS migration guide', () => {
    /**
     * POSITIVE CONTROL for every "does not mention registerAgent" assertion
     * below. Each of those passes just as well against a guide that says
     * nothing at all, so the caller the guide is FOR has to be shown getting it.
     */
    it('still hands an ordinary pre-AMS agent the ordered five steps', () => {
        const outcome = agentUpgradeGuide(ORDINARY);
        expect(outcome.status).toBe('migrate');
        expect(outcome.text).toMatch(REGISTER_INSTRUCTION);
        expect(outcome.text).toContain('registerSession');
        expect(outcome.text).toContain('thumbsUp');
        expect(outcome.text).toContain('runAgent start');
        // Ordered: registration must be read before the session is bound to it.
        expect(outcome.text.indexOf('registerAgent')).toBeLessThan(
            outcome.text.indexOf('registerSession'),
        );
    });

    it('never tells the workstation operator to register itself', () => {
        const outcome = agentUpgradeGuide({ ...ORDINARY, isWorkstationOperator: true });
        expect(outcome.status).toBe('operator');
        expect(outcome.text).not.toMatch(REGISTER_INSTRUCTION);
        expect(outcome.text).not.toContain('registerSession');
    });

    it('tells the operator WHY, so it stops trying on the next upgrade', () => {
        const outcome = agentUpgradeGuide({ ...ORDINARY, isWorkstationOperator: true });
        expect(outcome.text).toMatch(/not (a|an) .*workspace agent|never registered/i);
        expect(outcome.text).toContain('#372');
    });

    /**
     * The operator branch wins over `registeredAs`, and over the missing
     * workspace it used to have: it is a statement about WHAT the caller is, not
     * about a row it happens to be missing.
     */
    it('answers as the operator whatever else is true of the terminal', () => {
        expect(
            agentUpgradeGuide({ workspaceId: null, isWorkstationOperator: true, registeredAs: null })
                .status,
        ).toBe('operator');
        expect(
            agentUpgradeGuide({
                workspaceId: '__system__',
                isWorkstationOperator: true,
                registeredAs: 'genie',
            }).status,
        ).toBe('operator');
    });

    it('does not hand the steps to a terminal attached to no workspace', () => {
        const outcome = agentUpgradeGuide({ ...ORDINARY, workspaceId: null });
        expect(outcome.status).toBe('unattached');
        expect(outcome.text).not.toMatch(REGISTER_INSTRUCTION);
        expect(outcome.text).toMatch(/not attached to a Genie workspace/i);
    });

    it('tells an agent that is already registered that there is nothing to do', () => {
        const outcome = agentUpgradeGuide({ ...ORDINARY, registeredAs: 'ripple' });
        expect(outcome.status).toBe('registered');
        expect(outcome.text).toContain('ripple');
        expect(outcome.text).not.toMatch(REGISTER_INSTRUCTION);
    });

    /** A blank name is not a registration — it must not swallow the guide. */
    it('treats an empty registered name as unregistered', () => {
        expect(agentUpgradeGuide({ ...ORDINARY, registeredAs: '   ' }).status).toBe('migrate');
    });
});
