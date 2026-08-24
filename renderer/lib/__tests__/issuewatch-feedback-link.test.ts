import { describe, expect, it } from 'vitest';
import { feedbackPathForWorkspace } from '../issuewatch';

/**
 * The IssueWatch flyout's feedback notice — "N unresolved pieces of project
 * feedback in Tynn, waiting on triage" — has to open something.
 *
 * Tynn's canonical project URL is built from an owner slug + a project slug
 * (`/u/<owner>/<project>`), and Genie holds NEITHER. What a workspace does hold
 * is its Tynn PROJECT ID, so the desktop links through Tynn's id-addressed
 * entry point and lets the server redirect to the canonical path.
 *
 * The two ids coincide only by construction: a workspace created FROM a Tynn
 * project uses `id := project.id`, while a locally scaffolded `.agi` envelope
 * mints its own id and records the Tynn link separately. Linking on the local
 * id would send those workspaces to a project that does not exist.
 */
describe('feedbackPathForWorkspace', () => {
    it('addresses the feedback page by the workspace TYNN project id', () => {
        expect(
            feedbackPathForWorkspace({
                id: 'PRJ-TYNN',
                tynn_project_id: 'PRJ-TYNN',
                backend: 'tynn',
            }),
        ).toBe('/p/PRJ-TYNN/feedback');
    });

    it('prefers the Tynn project id over the local id when they differ', () => {
        // A locally scaffolded envelope: local id ≠ Tynn project id. Linking on
        // `id` here would open a project id Tynn has never heard of.
        expect(
            feedbackPathForWorkspace({
                id: 'local-prism-id',
                tynn_project_id: 'PRJ-PRISM',
                backend: 'tynn',
            }),
        ).toBe('/p/PRJ-PRISM/feedback');
    });

    it('falls back to the local id when the Tynn project id column is empty', () => {
        // The live shape for older rows: `tynn_project_id` is '' and the local
        // id IS the project id (see the #134 link-resolution tests).
        expect(
            feedbackPathForWorkspace({ id: 'PRJ-TYNN', tynn_project_id: '', backend: 'tynn' }),
        ).toBe('/p/PRJ-TYNN/feedback');
    });

    it('offers nothing for a workspace that is not Tynn-backed', () => {
        // The fallback above makes this check load-bearing: an Aionima
        // workspace's `id` is a LOCAL identifier, so without the backend test it
        // would be dressed up as a Tynn project id and linked to a page that
        // cannot resolve.
        expect(
            feedbackPathForWorkspace({
                id: 'local-only-id',
                tynn_project_id: '',
                backend: 'aionima',
            }),
        ).toBeNull();
    });

    it('returns null when there is no workspace or no id at all', () => {
        expect(
            feedbackPathForWorkspace({ id: '', tynn_project_id: '', backend: 'tynn' }),
        ).toBeNull();
        expect(feedbackPathForWorkspace(undefined)).toBeNull();
    });

    it('escapes an id so it cannot break out of the path segment', () => {
        // Ids are server-minted ULIDs, but this builds a URL opened in the
        // user's real browser — encode rather than trust the shape.
        expect(
            feedbackPathForWorkspace({ id: 'a/b?x=1', tynn_project_id: '', backend: 'tynn' }),
        ).toBe('/p/a%2Fb%3Fx%3D1/feedback');
    });
});
