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
            feedbackPathForWorkspace({ id: 'PRJ-TYNN', tynn_project_id: 'PRJ-TYNN' }),
        ).toBe('/p/PRJ-TYNN/feedback');
    });

    it('prefers the Tynn project id over the local id when they differ', () => {
        // A locally scaffolded envelope: local id ≠ Tynn project id. Linking on
        // `id` here would open a project id Tynn has never heard of.
        expect(
            feedbackPathForWorkspace({ id: 'local-prism-id', tynn_project_id: 'PRJ-PRISM' }),
        ).toBe('/p/PRJ-PRISM/feedback');
    });

    it('falls back to the local id when the Tynn project id column is empty', () => {
        // The live shape for older rows: `tynn_project_id` is '' and the local
        // id IS the project id (see the #134 link-resolution tests).
        expect(feedbackPathForWorkspace({ id: 'PRJ-TYNN', tynn_project_id: '' })).toBe(
            '/p/PRJ-TYNN/feedback',
        );
    });

    it('returns null when the workspace has no Tynn project at all', () => {
        // An unlinked workspace has nothing to open. The notice must stay inert
        // rather than send the user to a URL that cannot resolve.
        expect(feedbackPathForWorkspace({ id: '', tynn_project_id: '' })).toBeNull();
        expect(feedbackPathForWorkspace(undefined)).toBeNull();
    });

    it('escapes an id so it cannot break out of the path segment', () => {
        // Ids are server-minted ULIDs, but this builds a URL opened in the
        // user's real browser — encode rather than trust the shape.
        expect(
            feedbackPathForWorkspace({ id: 'a/b?x=1', tynn_project_id: '' }),
        ).toBe('/p/a%2Fb%3Fx%3D1/feedback');
    });
});
