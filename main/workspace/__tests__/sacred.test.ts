import { describe, expect, it } from 'vitest';
import { planSacredSync, type SacredProject, type SacredWorkspace } from '../sacred';

/**
 * Mirroring Tynn's sacred marking onto the workspace (Tynn story #262).
 *
 * The owner's rule: *"the tynn workspace should be somehow marked as a sacred
 * workspace in tynn and when in genie (just cosmetic in genie, you use the same
 * tools and guides everyone else uses)"*.
 *
 * THE FLAG HAS EXACTLY ONE HOME — Tynn — and Genie converges on it. This is the
 * same shape as `is_gapp`/`planGappDevSync`, deliberately: a Genie-side toggle
 * would be a second place for the answer to live, and the two would drift.
 *
 * What Tynn sends is a NAME, not a boolean: the one reserved agent name this
 * workspace may use. A boolean would leave Genie guessing WHICH term was
 * granted, and the obvious guess — the workspace slug — is wrong here, because
 * the Tynn workspace's slug is `tynn-ai` while the name it needs is `tynn`.
 *
 * SACRED IS COSMETIC PLUS THAT ONE EXEMPTION. It confers no tools, no
 * permissions and no different guides.
 */

const ws = (over: Partial<SacredWorkspace> = {}): SacredWorkspace => ({
    id: 'w1',
    sacred_name: null,
    tynnProjectId: 'p1',
    ...over,
});

describe('planning the sacred sync', () => {
    it('grants the name Tynn marked the project with', () => {
        const projects: SacredProject[] = [{ id: 'p1', sacredAgentName: 'tynn' }];

        expect(planSacredSync([ws()], projects)).toEqual([{ id: 'w1', next: 'tynn' }]);
    });

    it('emits nothing when the grant already matches', () => {
        // A row rewritten to itself makes every project fetch look like a change
        // and churns the workspaces-changed broadcast.
        const projects: SacredProject[] = [{ id: 'p1', sacredAgentName: 'tynn' }];

        expect(planSacredSync([ws({ sacred_name: 'tynn' })], projects)).toEqual([]);
    });

    it('REVOKES the grant when Tynn no longer marks the project', () => {
        const projects: SacredProject[] = [{ id: 'p1', sacredAgentName: null }];

        expect(planSacredSync([ws({ sacred_name: 'tynn' })], projects)).toEqual([
            { id: 'w1', next: null },
        ]);
    });

    it('revokes the grant from a workspace that is no longer linked', () => {
        // An unlinked workspace has no Tynn to speak for it, so it cannot keep
        // an exemption Tynn granted.
        expect(
            planSacredSync([ws({ sacred_name: 'tynn', tynnProjectId: null })], []),
        ).toEqual([{ id: 'w1', next: null }]);
    });

    it('leaves a workspace ALONE when the fetch said nothing about its project', () => {
        // A partial project list must not read as "revoked". Same rule as
        // `planGappDevSync`: no answer is not an answer.
        expect(planSacredSync([ws({ sacred_name: 'tynn' })], [{ id: 'other' }])).toEqual([]);
    });

    it('normalises case and whitespace', () => {
        const projects: SacredProject[] = [{ id: 'p1', sacredAgentName: '  TYNN ' }];

        expect(planSacredSync([ws()], projects)).toEqual([{ id: 'w1', next: 'tynn' }]);
    });

    it('IGNORES a grant that is not a reserved term', () => {
        // A grant is an exemption from the block list, not a claim on a name.
        // `frontend` is allowed everywhere already, so granting it means
        // nothing — and storing it would imply Genie reserves it.
        expect(planSacredSync([ws()], [{ id: 'p1', sacredAgentName: 'frontend' }])).toEqual([]);
    });

    it('drops a stored grant that is no longer a reserved term', () => {
        expect(
            planSacredSync([ws({ sacred_name: 'frontend' })], [{ id: 'p1', sacredAgentName: 'frontend' }]),
        ).toEqual([{ id: 'w1', next: null }]);
    });

    it('revokes against an older Tynn that has no such field', () => {
        // A PROJECT that answers without the field is saying "not marked" — the
        // same reading `is_gapp` takes with `!!p.is_gapp`. Only an ABSENT
        // PROJECT means "no answer" (asserted above).
        //
        // The consequence is deliberate: pointed at a Tynn that predates the
        // field, no workspace is sacred. Tynn is the source of truth, and a
        // backend that cannot express the grant has not granted one. The
        // alternative — keeping a grant no backend still vouches for — is how a
        // flag outlives the thing that set it.
        expect(planSacredSync([ws({ sacred_name: 'tynn' })], [{ id: 'p1' }])).toEqual([
            { id: 'w1', next: null },
        ]);
    });

    it('plans across many workspaces at once', () => {
        const workspaces = [
            ws({ id: 'w-tynn', tynnProjectId: 'p-tynn' }),
            ws({ id: 'w-other', tynnProjectId: 'p-other' }),
        ];
        const projects: SacredProject[] = [
            { id: 'p-tynn', sacredAgentName: 'tynn' },
            { id: 'p-other', sacredAgentName: null },
        ];

        expect(planSacredSync(workspaces, projects)).toEqual([{ id: 'w-tynn', next: 'tynn' }]);
    });
});
