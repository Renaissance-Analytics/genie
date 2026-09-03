import { describe, expect, it } from 'vitest';
import { callerWorkspaceDescriptor } from '../caller-workspace';

/**
 * The System Workspace resolves like every other workspace — through its ROW.
 *
 * This file used to assert the opposite, and said so at length: the OSA's spec
 * carried `workspace_id: null` + `meta.system === true`, no `__system__` row
 * existed "by design", and the guard's job was to substitute the sentinel. That
 * reasoning was sound given its premise. The premise is gone: the row exists
 * (`ensureSystemWorkspaceRow`), rooted at `~/.gosa`, and the OSA's spec carries
 * its id like any agent's.
 *
 * So the substitution is DELETED, not relaxed. A spec with no `workspace_id` is
 * once again exactly what it says it is — a terminal in no workspace — and is
 * refused, `meta.system` or not. That tag still marks unattached System-Workspace
 * PANELS and global processes, which root at their own cwd and are not callers;
 * it no longer stands in for a missing row.
 */

const systemRow = {
    id: '__system__',
    project_name: 'System',
    path: '/home/wishborn/.gosa',
};
const lookup = (id: string) =>
    id === '__system__'
        ? systemRow
        : id === 'ws-1'
          ? { id: 'ws-1', project_name: 'Tynn.ai', path: '/src/tynn' }
          : undefined;

const osaSpec = { workspace_id: '__system__', meta: { system: true } };
const projectSpec = { workspace_id: 'ws-1', meta: {} };
const looseSpec = { workspace_id: null, meta: {} };
const legacySystemSpec = { workspace_id: null, meta: { system: true } };

describe('resolving the caller workspace', () => {
    it('resolves the operator through the ordinary row lookup', () => {
        const ws = callerWorkspaceDescriptor(osaSpec, lookup);

        expect(ws).toEqual({
            id: '__system__',
            name: 'System',
            slug: 'system',
            path: '/home/wishborn/.gosa',
        });
    });

    it('POSITIVE CONTROL — an ordinary project spec resolves exactly as before', () => {
        // The assertion that matters most: "the operator works" would pass just
        // as well against a change that broke every other workspace.
        const ws = callerWorkspaceDescriptor(projectSpec, lookup);

        expect(ws).toEqual(
            expect.objectContaining({ id: 'ws-1', name: 'Tynn.ai', path: '/src/tynn' }),
        );
    });

    it('refuses a terminal that is genuinely in no workspace', () => {
        expect(callerWorkspaceDescriptor(looseSpec, lookup)).toBeNull();
    });

    it('no longer substitutes a workspace for an unattached `meta.system` spec', () => {
        // This is the deleted special case. A code panel or a global process
        // carries this shape; neither is an MCP caller, and neither may borrow
        // the operator's identity by wearing its tag.
        expect(callerWorkspaceDescriptor(legacySystemSpec, lookup)).toBeNull();
    });

    it('refuses a project spec whose workspace row has vanished', () => {
        expect(callerWorkspaceDescriptor(projectSpec, () => undefined)).toBeNull();
    });

    it('refuses the operator spec when its row is missing, like any other', () => {
        // No more "the row does not exist, so invent one". A missing row is a
        // broken install and must read as one.
        expect(callerWorkspaceDescriptor(osaSpec, () => undefined)).toBeNull();
    });
});
