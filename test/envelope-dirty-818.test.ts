import { describe, expect, it } from 'vitest';
import { ENVELOPE_DIRS, ENVELOPE_GITIGNORE, envelopeReadme, envelopeRules } from '../src/core/add-workspace.js';

/**
 * THE ENVELOPE'S DEFAULT FOLDERS (Tynn #818). The owner, 2026-11-17: a new or scaffolded .agi envelope includes
 * `.ai/_dirty/` and `.trash/`, each kept by git as a folder with its contents ignored. `.ai/_dirty/` is Genie 1's drop
 * folder for files sent to a workspace; `.trash/` is #697's soft-delete buffer. New, the Tynn import and the
 * convert-a-folder build all write through one scaffold (main/workspace-ops-host.ts scaffoldEnvelope), which lays out
 * ENVELOPE_DIRS with a `.gitkeep` each and writes ENVELOPE_GITIGNORE; create-workspace-first-commit.test.ts measures the
 * result with real git. This file pins the lists and the words.
 */
const lines = ENVELOPE_GITIGNORE.split(/\r?\n/);

describe('the envelope skeleton (Tynn #818)', () => {
    it('CONTROL: .trash/ is a default folder, its contents ignored and its .gitkeep kept', () => {
        expect(ENVELOPE_DIRS).toContain('.trash');
        expect(lines).toEqual(expect.arrayContaining(['.trash/**', '!.trash/.gitkeep']));
    });

    it('.ai/_dirty/ is a default folder, its contents ignored and its .gitkeep kept', () => {
        expect(ENVELOPE_DIRS).toContain('.ai/_dirty');
        // after .ai, so the parent is made first
        expect(ENVELOPE_DIRS.indexOf('.ai/_dirty')).toBeGreaterThan(ENVELOPE_DIRS.indexOf('.ai'));
        expect(lines).toEqual(expect.arrayContaining(['.ai/_dirty/**', '!.ai/_dirty/.gitkeep']));
    });

    it('the README layout and the workspace RULES name .ai/_dirty/ as gitignored', () => {
        expect(envelopeReadme('Acme', 'acme.agi')).toMatch(/_dirty\/\s+.*gitignored/);
        expect(envelopeRules('Acme')).toMatch(/`\.ai\/_dirty\/`.*gitignored/);
    });
});
