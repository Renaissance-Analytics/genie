import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GENIE NEVER SAYS A FOLDER IS TRUSTED ON A PROVIDER'S BEHALF. Each provider CLI keeps its own record of which folders a person has trusted, and what it does with a folder's own config depends on it.
 * That record is the person's, given to that CLI. Nothing in Genie's code may write it, or pass a setting that stands in for it.
 */
const MARKS_A_FOLDER_TRUSTED = /trust_level|trusted_projects|hasTrustDialogAccepted|hasCompletedProjectOnboarding|\[projects[."]|projects\.\s*["'`]|-c\s*projects|'projects\./;

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return /\.(ts|tsx|mjs|cjs|js)$/.test(name) ? [path] : [];
    });
}

describe('a provider folder trust record', () => {
    it('CONTROL: the guard sees each way of writing one', () => {
        for (const sample of ['[projects."/w/acme"]', 'trust_level = "trusted"', 'hasTrustDialogAccepted: true', "'-c', 'projects.x'", 'trusted_projects: []']) {
            expect(MARKS_A_FOLDER_TRUSTED.test(sample), sample).toBe(true);
        }
        expect(MARKS_A_FOLDER_TRUSTED.test('const projects = list();')).toBe(false);
    });

    it('nothing under src writes one', () => {
        const found = sources('src').flatMap((file) => readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line, at) => (MARKS_A_FOLDER_TRUSTED.test(line) ? [`${file}:${at + 1}`] : [])));
        expect(found).toEqual([]);
    });
});
