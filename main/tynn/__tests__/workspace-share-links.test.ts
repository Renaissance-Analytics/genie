import { describe, expect, it, vi } from 'vitest';
import {
    listWorkspaceShareLinks,
    mintWorkspaceShareLink,
    revokeWorkspaceShareLink,
    type ShareLinkDeps,
} from '../workspace-share-links';

/**
 * The share-link layer BETWEEN the IPC handlers and the Tynn client.
 *
 * It exists for one reason the client cannot cover: a share link is scoped to a
 * workspace ON A WORKSTATION, and Genie has to know which workstation THIS
 * machine is. When it is not enrolled there is no id to share under, and the
 * failure has to be a sentence the user can act on — not a crash in the settings
 * modal and not a silent empty list, which is indistinguishable from "no links".
 */
function deps(over: Partial<ShareLinkDeps> = {}): ShareLinkDeps {
    return {
        identity: () => ({ workstationId: 'wst-1' }),
        backend: {
            mintWorkspaceShareLink: vi.fn(async () => ({
                id: 'inv1',
                url: 'https://tynn.ai/invites/accept/tok',
                token: 'tok',
                capability: 'readonly' as const,
                workspace_ids: ['ws-design'],
                all_workspaces: false,
                expires_at: null,
                created_at: null,
            })),
            listWorkspaceShareLinks: vi.fn(async () => []),
            revokeWorkspaceShareLink: vi.fn(async () => {}),
        },
        ...over,
    };
}

describe('mintWorkspaceShareLink', () => {
    it('mints under THIS machine’s workstation id', async () => {
        const d = deps();
        const out = await mintWorkspaceShareLink('ws-design', 'readonly', d);

        expect(out.ok).toBe(true);
        expect(d.backend.mintWorkspaceShareLink).toHaveBeenCalledWith('wst-1', 'ws-design', 'readonly');
    });

    it('explains an unenrolled machine instead of crashing', async () => {
        // Genie only has a workstation id once it has self-registered with Tynn.
        // Before that there is nothing to share a workspace ON, and the user needs
        // to be told that — a thrown error here takes the settings modal with it.
        const out = await mintWorkspaceShareLink('ws-design', 'readonly', deps({ identity: () => null }));

        expect(out.ok).toBe(false);
        expect(out.ok === false && out.error).toMatch(/sign in|Tynn/i);
    });

    it('surfaces a refusal from Tynn as its message, not as a generic failure', async () => {
        // The service refuses a workspace this machine does not report yet (422).
        // "Something went wrong" would send the user looking in the wrong place.
        const d = deps({
            backend: {
                ...deps().backend,
                mintWorkspaceShareLink: vi.fn(async () => {
                    throw new Error('Tynn POST /share-links → 422 workspace not hosted');
                }),
            },
        });

        const out = await mintWorkspaceShareLink('ws-design', 'readonly', d);

        expect(out.ok).toBe(false);
        expect(out.ok === false && out.error).toContain('422');
    });
});

describe('listWorkspaceShareLinks', () => {
    it('lists this workspace’s links under this machine', async () => {
        const d = deps();
        await listWorkspaceShareLinks('ws-design', d);

        expect(d.backend.listWorkspaceShareLinks).toHaveBeenCalledWith('wst-1', 'ws-design');
    });

    it('returns an empty list for an unenrolled machine without calling Tynn', async () => {
        const d = deps({ identity: () => null });
        const out = await listWorkspaceShareLinks('ws-design', d);

        expect(out).toEqual([]);
        expect(d.backend.listWorkspaceShareLinks).not.toHaveBeenCalled();
    });
});

describe('revokeWorkspaceShareLink', () => {
    it('revokes under this machine and reports success', async () => {
        const d = deps();
        const out = await revokeWorkspaceShareLink('inv1', d);

        expect(out).toEqual({ ok: true });
        expect(d.backend.revokeWorkspaceShareLink).toHaveBeenCalledWith('wst-1', 'inv1');
    });

    it('reports a FAILED revoke as failed', async () => {
        // The one thing this surface must never do is claim a link is dead when it
        // is still live. Swallowing the error would do exactly that.
        const d = deps({
            backend: {
                ...deps().backend,
                revokeWorkspaceShareLink: vi.fn(async () => {
                    throw new Error('Tynn DELETE → 500');
                }),
            },
        });

        const out = await revokeWorkspaceShareLink('inv1', d);

        expect(out.ok).toBe(false);
    });
});
