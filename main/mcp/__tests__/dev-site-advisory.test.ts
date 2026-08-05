import { describe, expect, it } from 'vitest';
import { createAdvisoryNotes } from '../dev-site-tools';

/**
 * The create-time advisories (genie #125). A custom `image` is a legacy
 * per-site-container concept; in the sandbox-serve model a site runs its command
 * inside the shared workspace dev sandbox, so the ref is stored but never used.
 * Surfacing that on create turns a silent trap into a visible note.
 */
describe('createAdvisoryNotes', () => {
    it('warns that a custom `image` is recorded but NOT used at runtime', () => {
        const notes = createAdvisoryNotes({ image: 'ghcr.io/acme/app:1' });
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatch(/`image` is recorded but NOT used/);
    });

    it('has nothing to say for a plain create with no custom image', () => {
        expect(createAdvisoryNotes({})).toEqual([]);
        expect(createAdvisoryNotes({ image: undefined })).toEqual([]);
    });
});
