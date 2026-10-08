import { describe, expect, it } from 'vitest';
import {
    canStartFirstAgent,
    readinessNotes,
    workstationReadiness,
    type ReadinessInput,
} from '../workstation-readiness';

/**
 * FIRST RUN REPORTS, IT DOES NOT GATE.
 *
 * Owner direction: *"on a fresh workstation with no workspaces, genie is just making sure the
 * toolchain and environment is ready for development"*, and *"Tynn MUST be optional — but that also
 * gates all of the tynn provided services."*
 *
 * Paperclip's onboarding, read at the owner's request, is the shape: one question, everything else
 * derived and then SAID — including what it ignored and why — and nothing blocked. A failed
 * database connection there prints *"you can fix this later with `paperclipai doctor`"* and carries
 * on. The seven gates Genie had are what this replaces.
 *
 * So the assertions that matter here are the REFUSALS to gate: Tynn missing is not a fault, GitHub
 * missing is not a fault, and the only thing that stops a first agent is a machine with no agent
 * CLI on it.
 */

const ready: ReadinessInput = {
    installedDrivers: ['claude'],
    gitPresent: true,
    tynnUser: 'wishborn',
    githubConnected: true,
};

const lines = (over: Partial<ReadinessInput> = {}) => workstationReadiness({ ...ready, ...over });

describe('workstationReadiness', () => {
    it('reports four things, always the same four, in the same order', () => {
        // A report whose shape changes with its content cannot be read at a glance, and the order
        // is "what stops you soonest" rather than alphabetical.
        expect(lines().map((l) => l.id)).toEqual(['driver', 'git', 'tynn', 'github']);
    });

    it('names the driver it found, and counts them when there are several', () => {
        expect(lines().find((l) => l.id === 'driver')!.label).toContain('claude');
        expect(lines({ installedDrivers: ['claude', 'codex', 'gemini'] })[0]!.label).toContain('3');
    });

    it('says what a MISSING driver costs, not what is absent', () => {
        // "No CLI found" is a fact nobody can act on. "Nothing can run an agent yet" is.
        const driver = lines({ installedDrivers: [] })[0]!;
        expect(driver.state).toBe('missing');
        expect(driver.label).toContain('nothing can run an agent');
        expect(driver.fix).toBe('toolchain');
    });

    it('treats missing git as serious but not fatal, and says why', () => {
        // An agent can read and reason without git. It cannot keep anything it writes.
        const git = lines({ gitPresent: false }).find((l) => l.id === 'git')!;
        expect(git.state).toBe('missing');
        expect(git.label).toContain('cannot commit');
    });

    it('treats Tynn as OFF rather than missing, because it is optional', () => {
        // The owner's rule. A line that reads as a fault would make an optional service feel
        // mandatory, which is the gate this screen exists to remove.
        const tynn = lines({ tynnUser: null }).find((l) => l.id === 'tynn')!;
        expect(tynn.state).toBe('off');
        expect(tynn.state).not.toBe('missing');
        // And it says WHICH services it gates, because "not connected" alone invites the question.
        expect(tynn.label).toContain('hosting');
        expect(tynn.fix).toBe('tynn-signin');
    });

    it('names the connected Tynn account, so it is obvious WHICH one', () => {
        // A workstation can be signed into the wrong account, and that is invisible otherwise.
        expect(lines().find((l) => l.id === 'tynn')!.label).toContain('wishborn');
    });

    it('treats GitHub the same way — off, with what it gates', () => {
        const github = lines({ githubConnected: false }).find((l) => l.id === 'github')!;
        expect(github.state).toBe('off');
        expect(github.label).toContain('private repos');
    });

    it('carries NO fix route for something that is ready', () => {
        // A route to fix a thing that works is an invitation to break it.
        for (const line of lines()) {
            expect(line.state).toBe('ready');
            expect(line.fix).toBeUndefined();
        }
    });
});

describe('canStartFirstAgent', () => {
    it('is true with a driver, whatever else is off', () => {
        // The whole point: a workstation with no Tynn, no GitHub and no git can still start an
        // agent and show somebody what this product does.
        expect(
            canStartFirstAgent(lines({ tynnUser: null, githubConnected: false, gitPresent: false })),
        ).toBe(true);
    });

    it('is false with no driver, which is the ONE blocking case', () => {
        expect(canStartFirstAgent(lines({ installedDrivers: [] }))).toBe(false);
    });

    it('does not consult anything else', () => {
        // Stated as a property rather than trusted: flip every other input and the answer holds.
        for (const over of [
            { tynnUser: null },
            { githubConnected: false },
            { gitPresent: false },
            { tynnUser: null, githubConnected: false, gitPresent: false },
        ]) {
            expect(canStartFirstAgent(lines(over))).toBe(true);
        }
    });
});

describe('readinessNotes', () => {
    it('says NOTHING when everything is ready', () => {
        // Not four green ticks. The same rule the Deck's signal strip follows: a row of
        // reassurances trains people to stop reading.
        expect(readinessNotes(lines())).toEqual([]);
    });

    it('carries only what is worth mentioning', () => {
        const notes = readinessNotes(lines({ tynnUser: null, installedDrivers: [] }));
        expect(notes.map((l) => l.id)).toEqual(['driver', 'tynn']);
    });
});
