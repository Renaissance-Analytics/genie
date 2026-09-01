import { describe, expect, it } from 'vitest';
import { callerWorkspaceDescriptor } from '../caller-workspace';

/**
 * The System Workspace is a real scope, not "no workspace".
 *
 * `workspace-of-terminal.ts` states the convention:
 *
 *   The System Workspace has NO `workspaces` row, so its terminal specs persist
 *   with `workspace_id: null` + `meta.system === true`; everywhere a workspace
 *   id flows we substitute this sentinel.
 *
 * The Genie OS agent is exactly such a spec. But the workspace-scoped guards
 * read `spec.workspace_id` RAW, saw null, and refused it:
 *
 *   agentinbox      → "This terminal is not in a workspace, so it can't use agentinbox."
 *   submitFeedback  → "This terminal is not attached to a Genie workspace."
 *   connectToGenie  → "Couldn't resolve this terminal to a Genie workspace."
 *
 * which made the OSA the one agent that cannot report its own defects, and —
 * because `thumbsUp` gates on a transport it therefore cannot register —
 * left it unable to ever signal boot complete. So it re-ran first-boot
 * orientation on every launch, forever (genie#321).
 *
 * Binding it to a `__system__` row is NOT the fix: no such row exists, by
 * design, so that only trades "not in a workspace" for "Workspace not found".
 * The spec is already correct; the guards have to honour the convention.
 */

const systemSpec = { workspace_id: null, meta: { system: true } };
const projectSpec = { workspace_id: 'ws-1', meta: {} };
const looseSpec = { workspace_id: null, meta: {} };

describe('resolving the caller workspace for a System spec (#321)', () => {
    it('resolves a system spec to the System Workspace, not to nothing', () => {
        const ws = callerWorkspaceDescriptor(systemSpec, () => undefined);

        expect(ws).not.toBeNull();
        expect(ws!.id).toBe('__system__');
    });

    it('gives it a name and slug, so it can join the inbox like any workspace', () => {
        const ws = callerWorkspaceDescriptor(systemSpec, () => undefined)!;

        expect(ws.name.length).toBeGreaterThan(0);
        expect(ws.slug.length).toBeGreaterThan(0);
    });

    it('still resolves a normal project spec through its real row', () => {
        // POSITIVE CONTROL: the System path must not swallow ordinary lookups.
        const ws = callerWorkspaceDescriptor(projectSpec, (id) =>
            id === 'ws-1' ? { id: 'ws-1', project_name: 'Tynn.ai' } : undefined,
        );

        expect(ws).toEqual(expect.objectContaining({ id: 'ws-1', name: 'Tynn.ai' }));
    });

    it('still refuses a spec that is genuinely in no workspace', () => {
        // POSITIVE CONTROL: an unattached terminal is a real state and must keep
        // being refused — otherwise this "fix" lets anything into the inbox.
        expect(callerWorkspaceDescriptor(looseSpec, () => undefined)).toBeNull();
    });

    it('refuses a project spec whose workspace row has vanished', () => {
        expect(callerWorkspaceDescriptor(projectSpec, () => undefined)).toBeNull();
    });
});
