import { describe, expect, it } from 'vitest';
import { parseTynnProject, tynnAddPlan, tynnLink } from '../src/core/tynn.js';

/**
 * ADD A WORKSPACE FROM TYNN (§6.1) — the pure half. Tynn's REST API answers `GET /api/v1/project` for
 * the project a token belongs to (name, slug, vision…); it exposes no repositories. So "from Tynn" is the
 * ENVELOPE from the project: a folder named by the slug under the parent you pick, `project.json`
 * carrying the project's name, its vision as the description, and the `tynn` link the envelope schema
 * defines (host, project, projectId) — the plan shown BEFORE anything is written. Repos follow through
 * the repo registry. A token that is not a project token, or a project with no slug, is a refusal in
 * words, not a guess.
 */

const project = { id: 42, name: 'Tynn.ai', slug: 'tynn', vision: 'Agentic project management.', visibility: 'private' };

describe('parseTynnProject', () => {
    it('takes the project endpoint’s own shape — id as a string, name, slug, vision — and nothing it did not say', () => {
        expect(parseTynnProject(project)).toEqual({ id: '42', name: 'Tynn.ai', slug: 'tynn', vision: 'Agentic project management.' });
        expect(parseTynnProject({ id: 'p_7', name: 'X', slug: 'x' })).toEqual({ id: 'p_7', name: 'X', slug: 'x', vision: null });
        expect(parseTynnProject({ id: 1, name: 'X', slug: 'x', vision: '' })).toEqual({ id: '1', name: 'X', slug: 'x', vision: null });
    });

    it('is null for anything that is not a project: a user record, a message, no slug, a slug with a path in it', () => {
        expect(parseTynnProject({ id: 3, email: 'a@b.invalid', name: 'Someone' })).toBeNull();
        expect(parseTynnProject({ message: 'Unauthenticated.' })).toBeNull();
        expect(parseTynnProject({ id: 1, name: 'X', slug: '' })).toBeNull();
        expect(parseTynnProject({ id: 1, name: 'X', slug: '../x' })).toBeNull();
        expect(parseTynnProject({ id: 1, name: 'X', slug: 'a/b' })).toBeNull();
        expect(parseTynnProject(null)).toBeNull();
        expect(parseTynnProject('tynn')).toBeNull();
    });
});

describe('tynnLink', () => {
    it('the link the schema defines, the host without a trailing slash, owner omitted when unknown', () => {
        expect(tynnLink({ id: '42', name: 'Tynn.ai', slug: 'tynn', vision: null }, 'https://tynn.ai/')).toEqual({ host: 'https://tynn.ai', project: 'tynn', projectId: '42' });
    });
});

describe('tynnAddPlan', () => {
    const p = { id: '42', name: 'Tynn.ai', slug: 'tynn', vision: 'Agentic project management.' };

    it('a folder named by the slug under the parent; the empty-envelope steps after creating it; the Tynn link named; nothing written here', () => {
        const plan = tynnAddPlan({ project: p, parent: '/w/', folderExists: false, host: 'https://tynn.ai' });
        expect(plan.ok).toBe(true);
        if (!plan.ok) return;
        expect(plan.source).toBe('tynn');
        // An envelope folder, `.agi` like New's (parity row 30) — the link still names the project by its slug.
        expect(plan.path).toBe('/w/tynn.agi');
        expect(plan.kind).toBe('empty');
        expect(plan.project).toEqual(p);
        expect(plan.manifest).toMatchObject({ name: 'Tynn.ai', description: 'Agentic project management.', tynn: { host: 'https://tynn.ai', project: 'tynn', projectId: '42' } });
        expect(plan.steps[0]).toEqual({ action: 'create /w/tynn.agi', path: '/w/tynn.agi', writes: true });
        expect(plan.steps.map((s) => s.action)).toContain('write project.json');
        expect(plan.steps.map((s) => s.action)).toContain('link to Tynn project Tynn.ai (https://tynn.ai)');
        expect(plan.steps.map((s) => s.action)).toContain('register in Genie');
        expect(plan.steps.filter((s) => !s.writes).map((s) => s.action)).toEqual(['register in Genie']);
    });

    it('refuses a folder that already exists — add that folder instead of writing into it', () => {
        const plan = tynnAddPlan({ project: p, parent: '/w', folderExists: true, host: 'https://tynn.ai' });
        expect(plan).toEqual({ ok: false, reason: '/w/tynn.agi already exists; add that folder instead of creating the Tynn envelope over it' });
    });

    it('a project with no vision gets an empty description, not the word null', () => {
        const plan = tynnAddPlan({ project: { ...p, vision: null }, parent: '/w', folderExists: false, host: 'https://tynn.ai' });
        expect(plan.ok && plan.manifest.description).toBe('');
    });
});
