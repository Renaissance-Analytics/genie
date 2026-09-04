import { describe, expect, it } from 'vitest';
import { operatorCharter, operatorRoleBrief } from '../os-agent';
import { osAgentBootInstructions } from '../os-lifecycle';

/**
 * THE OPERATOR IS TOLD WHAT IT MUST NOT DO.
 *
 * The owner's complaint, verbatim: *"It keeps trying to do work when it should be
 * there to help setup and diagnose the system."*
 *
 * That is a prompt problem, and a specific one. The operator was handed a job
 * DESCRIPTION — "orient yourself, verify services, guide the owner through
 * setup" — and nothing else. A description of a job leaves "should I take this
 * one on?" open, and an agent that can do a thing, is already in the room, and
 * has been given no boundary answers yes. Every time.
 *
 * So the boundary is stated, not implied, and it is stated in the two places the
 * operator actually reads: the opening turn it is launched with, and the charter
 * its harness loads as memory at the start of EVERY session. One source
 * ({@link operatorRoleBrief}) feeds both, because a boundary that exists in two
 * hand-written copies is a boundary that will disagree with itself.
 */
describe('the operator role brief', () => {
    const brief = operatorRoleBrief();

    it('says the operator OPERATES the machine', () => {
        expect(brief).toMatch(/WORKSTATION OPERATOR/);
        expect(brief).toMatch(/diagnose/i);
        expect(brief).toMatch(/repair/i);
    });

    it('says, explicitly, that it does NOT do project work', () => {
        // The whole point. A brief that only described the job is what shipped,
        // and what the owner is complaining about.
        expect(brief).toMatch(/do NOT do project work/i);
        expect(brief).toMatch(/code/i);
        expect(brief).toMatch(/builds/i);
        expect(brief).toMatch(/tests/i);
    });

    it('names the alternative, so refusing is not a dead end', () => {
        // "Don't do that" with nowhere to put the work produces an agent that
        // either does it anyway or strands the user.
        expect(brief).toMatch(/registerAgent/);
        expect(brief).toMatch(/runAgent start/);
        expect(brief).toMatch(/runAgent diagnose/);
    });

    it('survives the shell that types it: no character quotable() would eat', () => {
        // The boot instruction is delivered as ONE double-quoted argv element
        // (agents/startup.ts). `quotable` STRIPS " ` $ ! % and newlines rather
        // than escaping them, so a brief written with markdown backticks would
        // reach the operator with its tool names silently mangled.
        expect(brief).not.toMatch(/["`$!%]/);
    });
});

/**
 * FIRST BOOT AND RECOVERY ARE DIFFERENT SCRIPTS.
 *
 * genie#352 fixed the DETECTION — for every build up to beta.296 the marker was
 * never written, so a machine with workspaces, memory and a toolchain was told
 * it was new on every single restart. Now that the distinction is real, the two
 * scripts have to actually differ, or the fix bought nothing.
 */
describe('the boot instruction for each mode', () => {
    const firstBoot = osAgentBootInstructions('first-boot');
    const recovery = osAgentBootInstructions('recovery');

    it('carries the role brief in BOTH modes', () => {
        // The boundary is not a first-boot topic. An operator on its ninth
        // restart is exactly the one that starts picking up project work.
        expect(firstBoot).toContain(operatorRoleBrief());
        expect(recovery).toContain(operatorRoleBrief());
    });

    it('tells a first boot that nothing is set up yet', () => {
        expect(firstBoot).toMatch(/FIRST BOOT/);
        expect(firstBoot).toMatch(/nothing is set up/i);
    });

    it('tells a recovery boot NOT to re-run onboarding', () => {
        expect(recovery).toMatch(/RECOVERY boot/);
        expect(recovery).toMatch(/do NOT re-run onboarding/i);
        expect(recovery).toMatch(/already set up/i);
    });

    it('recovery text is NOT first-boot text, and first-boot text is NOT recovery text', () => {
        // Both directions, because a single-direction check passes against a
        // function that returns the same string for everything ONE of the two
        // ways round.
        expect(recovery).not.toBe(firstBoot);
        expect(firstBoot).not.toMatch(/RECOVERY boot/);
        expect(firstBoot).not.toMatch(/do NOT re-run onboarding/i);
        expect(recovery).not.toMatch(/FIRST BOOT/);
        expect(recovery).not.toMatch(/nothing is set up/i);
    });

    it('only the FIRST boot drives the owner through setup', () => {
        // The concrete symptom of the bug: a configured machine being asked to
        // pick a model provider and install a toolchain again, every restart.
        expect(firstBoot).toMatch(/guide the owner through model provider/i);
        expect(recovery).not.toMatch(/guide the owner through model provider/i);
        expect(recovery).toMatch(/do not ask the owner to choose a model provider again/i);
    });

    it('both still end at the one setup-complete signal', () => {
        // POSITIVE CONTROL for the negative assertions above: the two strings
        // differ in the ways that matter WITHOUT having lost the contract they
        // share. "They are different" passes against two strings that are both
        // wrong.
        for (const text of [firstBoot, recovery]) {
            expect(text).toMatch(/thumbsUp with reason boot/);
        }
    });

    it('is typed into a shell, so it stays free of characters quotable() strips', () => {
        for (const text of [firstBoot, recovery]) {
            expect(text).not.toMatch(/["`$!%]/);
        }
    });
});

/**
 * The charter is the DURABLE half. The boot instruction is one argv element
 * typed into a TUI once; this is the file the harness loads as project memory at
 * the start of every session, so it is where the long form belongs — and why the
 * AgentBuilder skill was taken OUT of the opening prompt in the first place.
 */
describe('the operator charter', () => {
    const charter = operatorCharter();

    it('is a markdown document, not a prompt fragment', () => {
        expect(charter).toMatch(/^# /m);
        expect(charter.endsWith('\n')).toBe(true);
    });

    it('contains the same boundary the boot instruction carries', () => {
        expect(charter).toContain(operatorRoleBrief());
    });

    it('spells the refusals out one by one', () => {
        // The compressed boot line has to fit on a command line. This does not,
        // so it is where each refusal gets said plainly.
        expect(charter).toMatch(/Do NOT write, debug/i);
        expect(charter).toMatch(/Do NOT run a project/i);
        expect(charter).toMatch(/Do NOT create, edit or delete files inside a project workspace/i);
        expect(charter).toMatch(/because it looks small/i);
    });

    it('describes the triage it is FOR, so the refusal has somewhere to go', () => {
        expect(charter).toMatch(/runAgent diagnose/);
        expect(charter).toMatch(/restart/i);
        expect(charter).toMatch(/handoff/i);
    });

    it('POSITIVE CONTROL — it is not just a wall of prohibitions', () => {
        // A charter that only forbids produces an operator that does nothing.
        // The DO list is load-bearing and has to be there too.
        expect(charter).toMatch(/## What you do\b/i);
        expect(charter).toMatch(/toolchain/i);
        expect(charter).toMatch(/services/i);
    });
});
