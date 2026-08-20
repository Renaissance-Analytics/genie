import { describe, expect, it } from 'vitest';
import { resolveAppRequirements } from '../requirements';

/**
 * What a GApp NEEDS, and who provides it (Tynn #250, owner-directed).
 *
 * The owner's rule, and it is a better model than the refuse-or-warn question I
 * asked: the app is installed either way, the GApp tells Genie WHAT it needs,
 * Genie provides whatever it can, and anything Genie does not manage gets a
 * distinctive spot in the installer rather than being buried.
 *
 * That split is not a fixed property of a runtime — it depends on the MACHINE.
 * Genie installs Python on Windows x64 today and cannot on macOS; Rust it cannot
 * install anywhere. So a requirement resolves to one of three states per machine,
 * and the manifest only ever DECLARES the need:
 *
 *   satisfied      — already on this machine, nothing to do
 *   genie-installs — Genie has a recipe for this platform and will fetch it
 *   user-provides  — Genie cannot; the installer must SAY SO, prominently
 *
 * Pure, with the machine's facts injected, so every branch is asserted rather
 * than depending on what happens to be installed on the box running the tests.
 */

const machine = (over: Partial<Parameters<typeof resolveAppRequirements>[1]> = {}) => ({
    installed: new Set<string>(),
    canInstall: (tool: string) => tool === 'python' || tool === 'node',
    ...over,
});

describe('a requirement Genie can see is already met', () => {
    it('is satisfied, and asks nothing of anyone', () => {
        const plan = resolveAppRequirements(
            [{ tool: 'python' }],
            machine({ installed: new Set(['python']) }),
        );

        expect(plan.items[0]).toMatchObject({ tool: 'python', status: 'satisfied' });
        expect(plan.userProvides).toEqual([]);
        expect(plan.genieInstalls).toEqual([]);
    });
});

describe('a requirement Genie can provide', () => {
    it('is planned as an install, not asked of the user', () => {
        const plan = resolveAppRequirements([{ tool: 'python', version: '3.13.15' }], machine());

        expect(plan.items[0]).toMatchObject({ tool: 'python', status: 'genie-installs' });
        expect(plan.genieInstalls).toHaveLength(1);
        expect(plan.userProvides).toEqual([]);
    });

    it('carries the requested version through, so the app gets what it asked for', () => {
        const plan = resolveAppRequirements([{ tool: 'python', version: '3.13.15' }], machine());
        expect(plan.genieInstalls[0]?.version).toBe('3.13.15');
    });
});

describe('a requirement Genie does NOT manage', () => {
    const plan = () =>
        resolveAppRequirements(
            [{ tool: 'rust' }, { tool: 'docker', reason: 'runs the strategy sandbox' }],
            machine(),
        );

    it('still lets the app install — the owner ruled out refusing', () => {
        expect(plan().installable).toBe(true);
    });

    it('is surfaced for the installer to show prominently', () => {
        expect(plan().userProvides.map((r) => r.tool)).toEqual(['rust', 'docker']);
    });

    it("keeps the app's own reason, so the user is told WHY it is needed", () => {
        // "Install Docker" is an instruction. "Install Docker — it runs the
        // strategy sandbox" is a decision the user can actually make.
        expect(plan().userProvides[1]?.reason).toBe('runs the strategy sandbox');
    });
});

describe('what the installer needs to know at a glance', () => {
    it('reports whether anything at all needs the user', () => {
        expect(resolveAppRequirements([{ tool: 'node' }], machine()).needsUser).toBe(false);
        expect(resolveAppRequirements([{ tool: 'rust' }], machine()).needsUser).toBe(true);
    });

    it('keeps declaration order, so the installer list does not reshuffle', () => {
        const plan = resolveAppRequirements(
            [{ tool: 'rust' }, { tool: 'node' }, { tool: 'python' }],
            machine({ installed: new Set(['node']) }),
        );
        expect(plan.items.map((i) => i.tool)).toEqual(['rust', 'node', 'python']);
    });

    it('handles an app that needs nothing', () => {
        const plan = resolveAppRequirements([], machine());
        expect(plan).toMatchObject({ installable: true, needsUser: false });
        expect(plan.items).toEqual([]);
    });
});

describe('the same app on a different machine', () => {
    it('resolves differently — which is the whole reason this is per-machine', () => {
        const requires = [{ tool: 'python' }];

        // Windows: Genie fetches it.
        expect(
            resolveAppRequirements(requires, machine({ canInstall: () => true })).items[0]?.status,
        ).toBe('genie-installs');

        // macOS today: Genie has no Python recipe, so the user is asked.
        expect(
            resolveAppRequirements(requires, machine({ canInstall: () => false })).items[0]?.status,
        ).toBe('user-provides');
    });
});
