import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * genie#586 — AgentList + UserList on a HOST-BOUND (remote) window.
 *
 * The lists live in the db of the machine that OWNS the workspace. Spread from
 * local, `lists.read` queried the CLIENT's own db with a HOST workspace id and
 * came back empty — a result shaped exactly like "you have nothing to do", which
 * is the rendering this repo has spent its time removing. Same treatment as
 * AgentInbox: read the host, render the host.
 *
 * `resolveUser` matters more than the read. It does not just record a tick — it
 * NUDGES the authoring agent through the broker, and that agent's terminal is on
 * the HOST. Resolved locally it would find no such item and silently do nothing;
 * routed to the host it must bring the host's OWN delivery outcome back
 * unchanged, undelivered ones included.
 */
function fakeLocal(request: ReturnType<typeof vi.fn>, localLists: GenieApi['lists']): GenieApi {
    return {
        remote: {
            request,
            terminalAttach: vi.fn(),
            terminalInput: vi.fn(),
            terminalResize: vi.fn(),
            terminalDetach: vi.fn(),
            controlState: vi.fn().mockResolvedValue({ locked: false }),
            onControl: vi.fn(),
        },
        // Namespaces the bridge spreads/rebuilds at construction (empty is fine).
        workspaces: {},
        files: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
        questions: { list: vi.fn(), answer: vi.fn() },
        lists: localLists,
    } as unknown as GenieApi;
}

const localApi = () =>
    ({ read: vi.fn(), resolveUser: vi.fn() }) as unknown as GenieApi['lists'];

const HOST_VIEW = {
    agents: [{ agentName: 'alpha', items: [{ id: 'a1', text: 'Read the RFC' }] }],
    user: [{ id: 'u1', text: 'Approve the staging login', agentName: 'alpha' }],
    userCount: 1,
};

describe('makeRemoteBridge — host-sourced lists (genie#586)', () => {
    it('reads the HOST workspace, not the client db that has none of it', async () => {
        const request = vi.fn().mockResolvedValue({ view: HOST_VIEW });
        const local = localApi();
        const api = makeRemoteBridge(fakeLocal(request, local));

        expect(await api.lists.read('host-ws')).toEqual(HOST_VIEW);
        expect(request).toHaveBeenLastCalledWith('/api/desktop/lists/read?workspaceId=host-ws');
        expect(local.read).not.toHaveBeenCalled();
    });

    it('encodes the workspace id rather than pasting it into the query', async () => {
        const request = vi.fn().mockResolvedValue({ view: HOST_VIEW });
        const api = makeRemoteBridge(fakeLocal(request, localApi()));

        await api.lists.read('ws with/slash&amp');
        expect(request).toHaveBeenLastCalledWith(
            '/api/desktop/lists/read?workspaceId=ws%20with%2Fslash%26amp',
        );
    });

    it('resolves ON THE HOST — the agent to nudge is running there', async () => {
        const request = vi.fn().mockResolvedValue({
            ok: true,
            todo: { id: 'u1', text: 'Approve it', agent_name: 'alpha' },
            nudge: { delivered: true, terminalId: 't1' },
        });
        const local = localApi();
        const api = makeRemoteBridge(fakeLocal(request, local));

        const r = await api.lists.resolveUser('u1', 'done', 'signed off');

        expect(request).toHaveBeenLastCalledWith('/api/desktop/lists/resolve', {
            method: 'POST',
            json: { todoId: 'u1', action: 'done', comment: 'signed off' },
        });
        expect(local.resolveUser).not.toHaveBeenCalled();
        expect(r).toEqual({
            ok: true,
            todo: { id: 'u1', text: 'Approve it', agent_name: 'alpha' },
            nudge: { delivered: true, terminalId: 't1' },
        });
    });

    it('brings an UNDELIVERED nudge back with its reason intact', async () => {
        // A remote tick over a nudge that went nowhere is the same defect the
        // local path reports away, wearing a network.
        const request = vi.fn().mockResolvedValue({
            ok: true,
            todo: { id: 'u1', text: 'Approve it', agent_name: 'alpha' },
            nudge: { delivered: false, reason: 'alpha is no longer running in this workspace.' },
        });
        const api = makeRemoteBridge(fakeLocal(request, localApi()));

        const r = await api.lists.resolveUser('u1', 'refused', 'not doing that');
        expect(r).toEqual({
            ok: true,
            todo: { id: 'u1', text: 'Approve it', agent_name: 'alpha' },
            nudge: { delivered: false, reason: 'alpha is no longer running in this workspace.' },
        });
    });
});
