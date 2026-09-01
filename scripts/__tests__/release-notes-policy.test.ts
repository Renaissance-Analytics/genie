import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = fs.readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');

describe('release notes policy', () => {
    it('publishes the tag-specific curated notes and never an automated placeholder', () => {
        expect(workflow).toContain('docs/releases/${TAG}.md');
        expect(workflow).toContain('--notes-file "$NOTES_FILE"');
        expect(workflow).not.toContain('--notes "Automated build for $TAG"');
    });

    it('gates the length of those notes BEFORE the release is created', () => {
        // The vitest gate can be skipped; a release cannot. Both run the same
        // checker, so the limits cannot drift apart (genie#325).
        expect(workflow).toContain('node scripts/release-notes-policy.mjs "$NOTES_FILE"');

        // ...and BEFORE `gh release create`, not after — a novel that is
        // already published has already been read.
        expect(workflow.indexOf('release-notes-policy.mjs')).toBeLessThan(
            workflow.indexOf('gh release create'),
        );
    });
});
