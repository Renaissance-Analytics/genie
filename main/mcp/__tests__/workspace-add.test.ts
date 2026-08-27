import { describe, expect, it } from 'vitest';
import { decideWorkspaceAdd } from '../workspace-add';

/**
 * An operator can UNREGISTER a workspace and cannot REGISTER one.
 *
 * Found the way these things usually are — by being asked to do something and
 * discovering the tool has no verb for it. The owner granted this workstation
 * operator authority, and `manageWorkspaces list` duly returned 20 workspaces
 * with `relation: 'operator'`, so the grant works. But its action list is
 * `list | status | open | activate | remove`: an agent holding authority over
 * the whole machine can take a workspace OFF Genie's list and cannot put one
 * back.
 *
 * The capability is not missing from Genie — `addWorkspace` (db.ts) exists and
 * the UI reaches it through the `workspaces:add` IPC. It was simply never given
 * to agents, so the asymmetry is in the surface rather than the model.
 *
 * (`provisionWorkspaces` is NOT that verb and is not broken. It clones envelopes
 * for the child projects an OPS PROJECT governs — a different feature with a
 * different gate, which correctly answered `isOps: false` here.)
 *
 * This is the decision half: who may add, and what is a legal thing to add.
 * Kept pure so the answer is testable without a disk or a database.
 */
const OPERATOR = { callerIsOperator: true, exists: () => true, isDirectory: () => true, known: [] };

describe('decideWorkspaceAdd', () => {
    it('lets the workstation OPERATOR register a folder', () => {
        const got = decideWorkspaceAdd({ ...OPERATOR, path: 'C:/Projects/thing.agi' });

        expect(got.allowed).toBe(true);
    });

    it('REFUSES a caller that is not the operator', () => {
        // Registering a workspace is a workstation-level act: it puts a folder
        // Genie did not know about into every surface that lists workspaces. An
        // ordinary agent holds authority over its OWN workspace, which is not
        // authority to introduce another.
        const got = decideWorkspaceAdd({
            ...OPERATOR,
            callerIsOperator: false,
            path: 'C:/Projects/thing.agi',
        });

        expect(got.allowed).toBe(false);
        expect(got.reason).toMatch(/operator/i);
    });

    it('refuses a path that does not exist', () => {
        const got = decideWorkspaceAdd({
            ...OPERATOR,
            exists: () => false,
            path: 'C:/Projects/gone',
        });

        expect(got.allowed).toBe(false);
        expect(got.reason).toMatch(/does not exist/i);
    });

    it('refuses a FILE — a workspace is a directory', () => {
        const got = decideWorkspaceAdd({
            ...OPERATOR,
            isDirectory: () => false,
            path: 'C:/Projects/notes.txt',
        });

        expect(got.allowed).toBe(false);
        expect(got.reason).toMatch(/directory|folder/i);
    });

    it('refuses a relative path, so what gets registered is unambiguous', () => {
        // A relative path would resolve against whatever cwd the host happened to
        // have, which is not a property of the request.
        const got = decideWorkspaceAdd({ ...OPERATOR, path: '../thing.agi' });

        expect(got.allowed).toBe(false);
        expect(got.reason).toMatch(/absolute/i);
    });

    it('reports an ALREADY-REGISTERED folder rather than adding it twice', () => {
        // Two rows for one folder is worse than a refusal: every list shows it
        // twice and removing one leaves the other.
        const got = decideWorkspaceAdd({
            ...OPERATOR,
            known: ['C:/Projects/thing.agi'],
            path: 'C:/Projects/thing.agi',
        });

        expect(got.allowed).toBe(false);
        expect(got.alreadyKnown).toBe(true);
        expect(got.reason).toMatch(/already/i);
    });

    it('matches an existing registration regardless of slash or case', () => {
        // Windows paths arrive both ways; a case- or separator-sensitive compare
        // would let the same folder be registered twice.
        const got = decideWorkspaceAdd({
            ...OPERATOR,
            known: ['C:\\Projects\\Thing.agi'],
            path: 'c:/projects/thing.agi',
        });

        expect(got.alreadyKnown).toBe(true);
    });
});
