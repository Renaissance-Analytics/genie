import { describe, expect, it, vi } from 'vitest';
import { makeRemoteBridge } from '../remote-bridge';
import type { GenieApi } from '../genie';

/**
 * genie #327 — AMS agent RECORDS belong to the HOST, on a remote window.
 *
 * The `agents` namespace was missing from the bridge's returned object, so
 * `api().agents.*` fell through to `...local` — the client's own preload, its
 * own `ipcMain`, its own database. Two symptoms the owner hit, one cause:
 *
 *   create → the HOST's workspace id looked up in the CLIENT's rows, so the
 *            form answered "That workspace is no longer registered"
 *   delete → the row removed on the CLIENT; the host never told, so the agent
 *            was still there, dimmed. A delete that reported success and did
 *            nothing, which is worse than an error.
 *
 * `terminalSpec.createAgent` WAS bridged, which is why spawning an agent
 * terminal worked while managing the agent record did not — the `agents:*`
 * channels were added later and never got bridge coverage.
 *
 * Every case asserts the local implementation was NOT called. That is the whole
 * bug: the local call succeeds at being called, and does the wrong thing on the
 * wrong machine.
 */
function fakeLocal(request: ReturnType<typeof vi.fn>, localAgents: Record<string, unknown>): GenieApi {
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
        workspaces: {},
        files: {},
        terminal: {},
        clipboard: {},
        issueWatch: {},
        questions: {},
        agents: localAgents,
    } as unknown as GenieApi;
}

function harness(result: unknown = { ok: true }) {
    const request = vi.fn().mockResolvedValue({ result });
    const local = {
        list: vi.fn(),
        create: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        delete: vi.fn(),
        setDefault: vi.fn(),
        addRuntime: vi.fn(),
        front: vi.fn(),
        setAvatar: vi.fn(),
        roster: vi.fn(),
        adopt: vi.fn(),
    };
    const bridge = makeRemoteBridge(fakeLocal(request, local));
    return { request, local, bridge };
}

/** The path of the single call the bridge made. */
function calledPath(request: ReturnType<typeof vi.fn>): string {
    return String(request.mock.calls[0]?.[0] ?? '');
}

describe('the agents namespace is host-sourced on a remote window', () => {
    it('CREATE goes to the host, not the client database', async () => {
        const { request, local, bridge } = harness({ ok: true });

        await bridge.agents.create({
            workspaceId: 'host-ws',
            name: 'prism',
            purpose: 'Maintainer of the Prism AI eco system',
        });

        expect(calledPath(request)).toBe('/api/desktop/agents/create');
        expect(local.create).not.toHaveBeenCalled();
    });

    it('DELETE goes to the host, so the agent actually goes away there', async () => {
        const { request, local, bridge } = harness({ ok: true, filesRemoved: false });

        await bridge.agents.delete('agent-1', 'delete', true);

        expect(calledPath(request)).toBe('/api/desktop/agents/delete');
        expect(request.mock.calls[0]?.[1]).toMatchObject({
            json: { agentId: 'agent-1', mode: 'delete', handoff: true },
        });
        expect(local.delete).not.toHaveBeenCalled();
    });

    it('LIST reads the HOST roster, not the client of the same machine', async () => {
        const { request, local, bridge } = harness({ agents: [], runtimes: [] });

        await bridge.agents.list('host-ws');

        expect(calledPath(request)).toBe('/api/desktop/agents/list');
        expect(local.list).not.toHaveBeenCalled();
    });

    /**
     * The ROSTER reads a FOLDER (genie#465) — `.agents/<slug>/AGENT.md` — which
     * makes falling through worse than for the database calls above: the client
     * machine has a `.agents/` too, so an unbridged roster would answer with a
     * plausible list of somebody else's agents under a panel that claims to be
     * the host's workspace. And an ADOPT that fell through would register an
     * agent on the wrong machine, from the wrong file.
     */
    it('the ROSTER reads the HOST folder, not the client one of the same name', async () => {
        const { request, local, bridge } = harness({ ok: true, roster: [] });

        await bridge.agents.roster('host-ws');

        expect(calledPath(request)).toBe('/api/desktop/agents/roster');
        expect(local.roster).not.toHaveBeenCalled();
    });

    it('ADOPT registers on the host, from the host file', async () => {
        const { request, local, bridge } = harness({ ok: true });

        await bridge.agents.adopt('host-ws', 'ripple');

        expect(calledPath(request)).toBe('/api/desktop/agents/adopt');
        expect(local.adopt).not.toHaveBeenCalled();
    });

    it('START launches on the host', async () => {
        const { request, local, bridge } = harness({ ok: true });

        await bridge.agents.start('host-ws', 'tynn-builder');

        expect(calledPath(request)).toBe('/api/desktop/agents/start');
        expect(local.start).not.toHaveBeenCalled();
    });

    /**
     * STOP is host-sourced for the same reason DELETE is, and worse: falling
     * through would kill a terminal on the CLIENT while the host's agent kept
     * running — a stop that reports success and stops nothing.
     */
    it('STOP ends the run on the host, not on the client', async () => {
        const { request, local, bridge } = harness({ ok: true });

        await bridge.agents.stop('agent-1');

        expect(calledPath(request)).toBe('/api/desktop/agents/stop');
        expect(request.mock.calls[0]?.[1]).toMatchObject({ json: { agentId: 'agent-1' } });
        expect(local.stop).not.toHaveBeenCalled();
        // POSITIVE CONTROL for the verb, not just the transport: stopping must
        // never reach the endpoint that tears the record down.
        expect(local.delete).not.toHaveBeenCalled();
        expect(calledPath(request)).not.toBe('/api/desktop/agents/delete');
    });

    it.each([
        ['setDefault', '/api/desktop/agents/set-default', ['ws', 'a1']],
        ['addRuntime', '/api/desktop/agents/add-runtime', ['a1', 'codex']],
        ['front', '/api/desktop/agents/front', ['a1', 'r1']],
        ['setAvatar', '/api/desktop/agents/set-avatar', ['a1', '🦊']],
    ] as const)('%s goes to the host', async (method, path, args) => {
        const { request, local, bridge } = harness(true);

        await (bridge.agents[method] as (...a: unknown[]) => Promise<unknown>)(...args);

        expect(calledPath(request)).toBe(path);
        expect(local[method]).not.toHaveBeenCalled();
    });

    it('unwraps the host envelope rather than returning it', async () => {
        // The endpoints answer `{ result }`; a caller expecting the payload
        // would otherwise get an object with a `result` key and read every
        // field as undefined — which looks exactly like a failed call.
        const { bridge } = harness({ ok: false, error: 'nope' });

        await expect(bridge.agents.create({ workspaceId: 'w', name: 'n', purpose: 'p' })).resolves.toEqual({
            ok: false,
            error: 'nope',
        });
    });

    it('POSITIVE CONTROL: an unbridged namespace really does fall through', async () => {
        // Proves the assertions above mean something. `makeRemoteBridge` spreads
        // `...local`, so anything it does not override IS the local object — the
        // exact mechanism that broke `agents`.
        const { bridge } = harness();

        expect((bridge as unknown as { neverBridged?: unknown }).neverBridged).toBeUndefined();
        expect(bridge.agents.create).not.toBe(harness().local.create);
    });
});
