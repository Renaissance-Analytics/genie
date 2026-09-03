import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A CEILING on how special the workstation operator is allowed to be.
 *
 * The operator used to be `workspace_id: null` + `meta.system === true` with no
 * row behind it, and `caller-workspace.ts` said so outright: *"every surface
 * substitutes"*. Forty-four sites did. Every one was a place someone had to
 * remember, and on 2026-09-03 five of them were found broken at once — it had
 * never joined AgentInbox, its handoff note was always dropped, it was nearly
 * locked out of service inventory, every restart failed on a non-null assertion
 * against an always-null value, and it was permanently stuck in first-boot.
 *
 * Giving it a real workspace row deleted the substitutions rather than adding a
 * forty-fifth. This test is what stops the count creeping back: a new branch on
 * the operator's identity fails here, and the person adding it has to either
 * justify raising the ceiling or — far more often — find the ordinary path that
 * already works now that the row exists.
 *
 * WHAT IS COUNTED (production `main/` only; tests are excluded because a test
 * NAMING the convention is the opposite of a surface depending on it):
 *   - `SYSTEM_WORKSPACE_ID` — the sentinel id, wherever it appears;
 *   - `meta.system` — the "no row, tag instead" convention;
 *   - `agent_id === 'genie:workstation'` — a branch on the operator's identity.
 *
 * 41 before this change, 21 after. The remainder is NOT residue to be shaved: it
 * is the tag that marks unattached System-Workspace panels and global processes
 * (a real, different thing — they root at their own `cwd`), the id constant
 * itself, and two DELIBERATE policy branches on the operator's role. Each is
 * named where it stands.
 *
 * Raising `MAX` is a decision, not a formality. Lowering it is always welcome.
 */
const MAX_OSA_SPECIAL_CASES = 21;

const PATTERNS: ReadonlyArray<RegExp> = [
    /SYSTEM_WORKSPACE_ID/g,
    /meta\??\.\s*system\b/g,
    /agent_id\s*===\s*'genie:workstation'/g,
];

function productionSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
            out.push(...productionSources(full));
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function countSpecialCases(): { total: number; byFile: Record<string, number> } {
    const mainDir = path.resolve(__dirname, '..');
    const byFile: Record<string, number> = {};
    let total = 0;
    for (const file of productionSources(mainDir)) {
        const src = fs.readFileSync(file, 'utf8');
        let n = 0;
        for (const pattern of PATTERNS) n += (src.match(pattern) ?? []).length;
        if (n > 0) {
            byFile[path.relative(mainDir, file).split(path.sep).join('/')] = n;
            total += n;
        }
    }
    return { total, byFile };
}

describe('how special the workstation operator is allowed to be', () => {
    it(`keeps OSA special cases in main/ at or under ${MAX_OSA_SPECIAL_CASES}`, () => {
        const { total, byFile } = countSpecialCases();

        // The per-file map is in the failure message on purpose: a ceiling that
        // fails with a bare number tells you nothing about what to go and look at.
        expect({ total, byFile }).toEqual({ total: expect.any(Number), byFile });
        expect(total).toBeLessThanOrEqual(MAX_OSA_SPECIAL_CASES);
    });

    it('POSITIVE CONTROL — the counter actually finds the patterns it claims to', () => {
        // A ceiling test passes trivially against a counter that matches nothing.
        // This proves the count is real before the number above means anything.
        const { total, byFile } = countSpecialCases();

        expect(total).toBeGreaterThan(0);
        expect(Object.keys(byFile).length).toBeGreaterThan(0);
    });
});
