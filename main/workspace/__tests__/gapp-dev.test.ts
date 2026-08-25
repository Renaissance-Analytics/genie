import { describe, expect, it } from 'vitest';
import { isGappDevValue, planGappDevSync, type GappDevWorkspace } from '../gapp-dev';

/**
 * A GApp Development Workspace (GDW) is a workspace whose linked Tynn project
 * carries `is_gapp`. The flag lives in Tynn and a human flips it there, so the
 * only thing Genie can do is CONVERGE — which makes the convergence rules the
 * whole feature, and the reason they live in a pure function.
 *
 * Two of these tests are the owner's actual complaint ("I enabled GApp project
 * on a project but nothing changed in genie") and its mirror image.
 */

function ws(over: Partial<GappDevWorkspace> = {}): GappDevWorkspace {
    return { id: 'ws-1', gapp_dev: 0, tynnProjectId: 'proj-1', ...over };
}

describe('planGappDevSync', () => {
    it('UPGRADES an existing workspace when the flag flips ON in Tynn', () => {
        // The owner's report: they turned `is_gapp` on and Genie did not notice.
        expect(planGappDevSync([ws()], [{ id: 'proj-1', isGapp: true }])).toEqual([
            { id: 'ws-1', next: true },
        ]);
    });

    it('DOWNGRADES when the flag flips back OFF — never a one-way ratchet', () => {
        expect(
            planGappDevSync([ws({ gapp_dev: 1 })], [{ id: 'proj-1', isGapp: false }]),
        ).toEqual([{ id: 'ws-1', next: false }]);
    });

    it('an older Tynn that omits the field reads as "not a GApp", not "unknown"', () => {
        expect(planGappDevSync([ws({ gapp_dev: 1 })], [{ id: 'proj-1' }])).toEqual([
            { id: 'ws-1', next: false },
        ]);
    });

    it('plans NOTHING when the row already agrees with Tynn', () => {
        expect(planGappDevSync([ws({ gapp_dev: 1 })], [{ id: 'proj-1', isGapp: true }])).toEqual(
            [],
        );
        expect(planGappDevSync([ws({ gapp_dev: 0 })], [{ id: 'proj-1', isGapp: false }])).toEqual(
            [],
        );
    });

    it('does NOT downgrade a project that is simply ABSENT from the list', () => {
        // `TynnBackend.listProjects()` returns [] on ANY failure — a dead session,
        // an offline laptop, a 500. Treating absence as `is_gapp: false` would
        // silently strip every GDW in the workspace the first time the network
        // hiccups, and the user would have no idea why their chrome changed.
        expect(
            planGappDevSync([ws({ gapp_dev: 1 })], [{ id: 'other-proj', isGapp: true }]),
        ).toEqual([]);
    });

    it('an EMPTY project list changes nothing at all', () => {
        expect(
            planGappDevSync(
                [ws({ id: 'a', gapp_dev: 1 }), ws({ id: 'b', gapp_dev: 1, tynnProjectId: 'p2' })],
                [],
            ),
        ).toEqual([]);
    });

    it('an UNLINKED workspace stops being a GDW — a local fact, known for certain', () => {
        // Absence of a LINK is decided on this machine, unlike absence from the
        // project list, which is a network answer. So this one is safe to act on.
        expect(planGappDevSync([ws({ gapp_dev: 1, tynnProjectId: null })], [])).toEqual([
            { id: 'ws-1', next: false },
        ]);
    });

    it('plans one change per workspace sharing a project, and skips the settled ones', () => {
        const plan = planGappDevSync(
            [
                ws({ id: 'a', gapp_dev: 0 }),
                ws({ id: 'b', gapp_dev: 1 }),
                ws({ id: 'c', gapp_dev: 0, tynnProjectId: 'proj-2' }),
            ],
            [
                { id: 'proj-1', isGapp: true },
                { id: 'proj-2', isGapp: false },
            ],
        );
        expect(plan).toEqual([{ id: 'a', next: true }]);
    });
});

describe('isGappDevValue', () => {
    it('only the integer 1 means "GApp Development Workspace"', () => {
        expect(isGappDevValue(1)).toBe(true);
    });

    it('anything else — including a hand edit or a newer Genie’s value — reads as false', () => {
        // Same posture as `toWorkspaceAppKind`: an unrecognised value must fall
        // back to the ORDINARY workspace, never to the privileged one.
        for (const v of [0, null, undefined, '1', 'true', true, 2, -1, {}, []]) {
            expect(isGappDevValue(v)).toBe(false);
        }
    });
});
