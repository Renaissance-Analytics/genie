import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * On a remote/host window the AgentInbox lives on the HOST — so an attachment's
 * bytes must be fetched from it, not from the client's own (empty) broker. The
 * bytes then land on the CLIENT, which is where a remote human wants the file;
 * the mirror of how an external file DROP reads client-side and posts to the host.
 */
function fakeLocal(request: ReturnType<typeof vi.fn>): GenieApi {
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
        agentInbox: {
            attachmentBytes: vi.fn().mockResolvedValue({ ok: false }),
            post: vi.fn(),
        },
        files: {},
        workspaces: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
        settings: { get: vi.fn(), set: vi.fn() },
    } as unknown as GenieApi;
}

describe('makeRemoteBridge — AgentInbox attachments', () => {
    it('fetches attachment bytes from the HOST, never the local broker', async () => {
        const request = vi
            .fn()
            .mockResolvedValue({ ok: true, filename: 'spec.md', mime: 'text/markdown', base64: 'aGk=' });
        const local = fakeLocal(request);
        const api = makeRemoteBridge(local);

        const res = await api.agentInbox.attachmentBytes('att-1');

        expect(request).toHaveBeenCalledWith('/api/desktop/agentinbox/attachment', {
            method: 'POST',
            json: { attachmentId: 'att-1' },
        });
        expect(res).toMatchObject({ ok: true, filename: 'spec.md', base64: 'aGk=' });
        expect(local.agentInbox.attachmentBytes).not.toHaveBeenCalled();
    });

    it('POSTs a human message WITH its inline attachment bytes to the host', async () => {
        const request = vi.fn().mockResolvedValue({ ok: true });
        const api = makeRemoteBridge(fakeLocal(request));

        await api.agentInbox.post({
            toAgentId: 'agent-1',
            text: 'here',
            attachments: [{ filename: 'a.md', base64: 'aGk=' }],
        });

        expect(request).toHaveBeenCalledWith('/api/desktop/agentinbox/post', {
            method: 'POST',
            json: {
                toAgentId: 'agent-1',
                text: 'here',
                attachments: [{ filename: 'a.md', base64: 'aGk=' }],
            },
        });
    });
});
