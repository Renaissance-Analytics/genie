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
});
