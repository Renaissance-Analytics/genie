import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * genie #60 — the top-bar QUESTIONS badge on a HOST-BOUND (remote) window.
 *
 * The badge seeds from `api().questions.list()` and shows `groups.length`. On a
 * host window that call used to fall through to the client's LOCAL question
 * queue, which is empty — the pending questions live on the HOST — so the badge
 * sat at 0 no matter how many questions the host had. AgentInbox never had this
 * bug because its badge is HOST-SOURCED in the bridge (`agentinbox/lag`).
 *
 * This pins the same treatment for questions: `questions.list()` reads the HOST
 * (`GET /api/questions` — the route the CURRENTLY-DEPLOYED hosts already serve,
 * so no host upgrade is required) and groups the result with the SAME pure
 * grouping main uses, and `questions.answer()` posts back to the HOST (answering
 * a host question id against the client's local queue would silently no-op).
 */
function fakeLocal(request: ReturnType<typeof vi.fn>, localList = vi.fn()): GenieApi {
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
        questions: { list: localList, answer: vi.fn() },
    } as unknown as GenieApi;
}

/** One host pending question as `GET /api/questions` serves it. */
const hostQ = (over: Record<string, unknown>) => ({
    id: 'q',
    questions: [{ header: 'H', question: 'H?', options: [{ label: 'Yes' }] }],
    index: 0,
    ...over,
});

describe('makeRemoteBridge — host-sourced PendingQuestions (genie #60)', () => {
    it('reads the HOST for the badge instead of the empty local queue', async () => {
        const request = vi.fn();
        const localList = vi.fn().mockResolvedValue({ groups: [], count: 0 });
        const api = makeRemoteBridge(fakeLocal(request, localList));

        request.mockResolvedValueOnce({
            questions: [
                hostQ({ id: 'a', workspaceLabel: 'Alpha', index: 0, priority: 'normal' }),
                hostQ({ id: 'b', workspaceLabel: 'Beta', index: 1, priority: 'urgent' }),
                hostQ({ id: 'c', workspaceLabel: 'Alpha', index: 2, priority: 'high' }),
            ],
        });

        const r = await api.questions.list();

        expect(request).toHaveBeenLastCalledWith('/api/questions');
        // The client's own (empty) queue must NOT be what the badge reflects.
        expect(localList).not.toHaveBeenCalled();
        // The badge shows the number of WORKSPACES with pending questions.
        expect(r.groups).toHaveLength(2);
        expect(r.count).toBe(3);
        // …grouped exactly as main groups them: most-urgent workspace first,
        // per-workspace count + top priority, questions in answer order.
        expect(r.groups.map((g) => g.workspaceLabel)).toEqual(['Beta', 'Alpha']);
        expect(r.groups[1].count).toBe(2);
        expect(r.groups[1].topPriority).toBe('high');
        expect(r.groups[1].questions.map((q) => q.id)).toEqual(['a', 'c']);
    });

    it('carries the host attribution + createdAt through to the flyout', async () => {
        const request = vi.fn();
        const api = makeRemoteBridge(fakeLocal(request));
        request.mockResolvedValueOnce({
            questions: [
                hostQ({ id: 'a', workspaceLabel: 'W', remoteHost: 'box', createdAt: 1_700_000 }),
            ],
        });
        const r = await api.questions.list();
        expect(r.groups[0].remoteHost).toBe('box');
        expect(r.groups[0].questions[0].createdAt).toBe(1_700_000);
    });

    it('degrades to an empty inbox when the host answers with nothing', async () => {
        const request = vi.fn();
        const api = makeRemoteBridge(fakeLocal(request));
        request.mockResolvedValueOnce({});
        expect(await api.questions.list()).toEqual({ groups: [], count: 0 });
    });

    it('answers against the HOST (a host question id is unknown locally)', async () => {
        const request = vi.fn();
        const localAnswer = vi.fn();
        const local = fakeLocal(request);
        (local.questions as unknown as { answer: unknown }).answer = localAnswer;
        const api = makeRemoteBridge(local);

        request.mockResolvedValueOnce({ ok: true, answered: true });
        const answers = [{ header: 'H', question: 'H?', selected: ['Yes'], note: '' }];
        expect(await api.questions.answer('host id/1', answers)).toBe(true);

        expect(request).toHaveBeenLastCalledWith('/api/questions/host%20id%2F1/answer', {
            method: 'POST',
            json: { answers },
        });
        expect(localAnswer).not.toHaveBeenCalled();
    });

    it('reports the benign already-answered race as false', async () => {
        const request = vi.fn();
        const api = makeRemoteBridge(fakeLocal(request));
        request.mockResolvedValueOnce({ ok: true, answered: false });
        expect(await api.questions.answer('gone', [])).toBe(false);
    });
});
