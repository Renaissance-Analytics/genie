import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpContext } from '../../mcp/protocol';
import type { DispatchFrame, ShuttleResponse } from '../core';
import type { ShuttleStatus, ShuttleSupervisor, ShuttleSupervisorEvents } from '../ensure';
import { startMcpEndpoint, type McpEndpoint, type McpEndpointDeps } from '../genie-endpoint';
import type { ShuttleManifest } from '../manifest-store';
import type { ShuttleTopology } from '../topology-store';

/**
 * WHO SERVES GENIE'S MCP ENDPOINT, DECIDED ONCE AT BOOT AND KEPT TRUE AFTER.
 *
 * genie#346 Phase 1. The server module knows how to mint tokens and run calls; the
 * supervisor knows how to get a shuttle. This joins them so that, whatever happens,
 * the port is served by exactly one of the two: the shuttle when one is attached,
 * this process otherwise — including when a shuttle that was working dies and
 * cannot be brought back, which must not leave every agent's URL answering nothing.
 */

const endpoints: McpEndpoint[] = [];
afterEach(() => {
    for (const e of endpoints.splice(0)) e.stop();
});

const MANIFEST = { generation: 1 } as unknown as ShuttleManifest;
const TABLE: ShuttleTopology = { endpoints: {}, workspaces: {} };

function harness(over: { start?: () => Promise<ShuttleStatus>; manifest?: () => Promise<ShuttleManifest>; shuttleEnabled?: boolean } = {}) {
    let topologyListener: (() => void) | null = null;
    let table: ShuttleTopology = TABLE;
    const server = {
        adoptShuttleListener: vi.fn(),
        bindInProcess: vi.fn(async () => {}),
        topology: vi.fn(() => table),
        onTopologyChanged: vi.fn((listener: () => void) => {
            topologyListener = listener;
            return () => (topologyListener = null);
        }),
        contextFor: vi.fn((terminalId: string) => ({ terminalId }) as unknown as McpContext),
    };
    let events: ShuttleSupervisorEvents = {};
    let run: ((frame: DispatchFrame) => Promise<ShuttleResponse>) | null = null;
    const supervisor = {
        start: vi.fn(over.start ?? (async (): Promise<ShuttleStatus> => ({ mode: 'shuttle', how: 'spawned' }))),
        publish: vi.fn(),
        topology: vi.fn(),
        status: vi.fn(() => null),
        stop: vi.fn(),
    } satisfies ShuttleSupervisor;
    const deps: McpEndpointDeps = {
        shuttleEnabled: over.shuttleEnabled ?? true,
        server,
        createSupervisor: vi.fn((r, e) => {
            run = r;
            events = e;
            return supervisor;
        }),
        manifest: over.manifest ?? (async () => MANIFEST),
        topologyDebounceMs: 10,
    };
    return {
        deps,
        server,
        supervisor,
        emit: (status: ShuttleStatus) => events.onStatus?.(status),
        changeTopology: (next: ShuttleTopology) => {
            table = next;
            topologyListener?.();
        },
        run: (frame: DispatchFrame) => run!(frame),
    };
}

async function start(h: ReturnType<typeof harness>) {
    const endpoint = await startMcpEndpoint(h.deps);
    endpoints.push(endpoint);
    return endpoint;
}

describe('startMcpEndpoint', () => {
    it('serves in-process, exactly as before, when the shuttle is not enabled', async () => {
        const h = harness({ shuttleEnabled: false });

        const endpoint = await start(h);

        expect(endpoint.mode()).toBe('in-process');
        expect(h.server.bindInProcess).toHaveBeenCalledOnce();
        expect(h.server.adoptShuttleListener).not.toHaveBeenCalled();
        expect(h.deps.createSupervisor).not.toHaveBeenCalled();
    });

    it('stops a shuttle left running by an earlier session BEFORE binding, when the shuttle is off', async () => {
        // Turning the setting off must not leave a shuttle from the last session
        // holding the port: this Genie would lose the bind to it, fall back to a
        // temporary port no .mcp.json names, and every agent would dial a shuttle
        // with no Genie behind it.
        const h = harness({ shuttleEnabled: false });
        const order: string[] = [];
        h.deps.stopRunningShuttle = vi.fn(async () => void order.push('stop'));
        h.server.bindInProcess.mockImplementation(async () => void order.push('bind'));

        await start(h);

        expect(order).toEqual(['stop', 'bind']);
    });

    it('still binds when stopping a leftover shuttle fails, and says why', async () => {
        const log = vi.fn();
        const h = harness({ shuttleEnabled: false });
        h.deps.log = log;
        h.deps.stopRunningShuttle = vi.fn(async () => Promise.reject(new Error('still holding the pipe')));

        await start(h);

        expect(h.server.bindInProcess).toHaveBeenCalledOnce();
        expect(log.mock.calls.flat().join('\n')).toContain('still holding the pipe');
    });

    it('hands the port to the shuttle and does NOT bind it here', async () => {
        const h = harness();

        const endpoint = await start(h);

        expect(endpoint.mode()).toBe('shuttle');
        expect(h.server.adoptShuttleListener).toHaveBeenCalledOnce();
        expect(h.server.bindInProcess).not.toHaveBeenCalled();
    });

    it('lets a shuttle that is wrong for this Genie be dealt with BEFORE it attaches', async () => {
        // A shuttle from an earlier session listening on a port the owner has since
        // changed would be attached to happily — and every URL this Genie mints
        // names the NEW port, where nothing listens.
        const h = harness();
        const order: string[] = [];
        h.deps.prepareShuttle = vi.fn(async () => void order.push('prepare'));
        h.supervisor.start.mockImplementation(async () => {
            order.push('start');
            return { mode: 'shuttle', how: 'spawned' };
        });

        await start(h);

        expect(order).toEqual(['prepare', 'start']);
    });

    it('gives the supervisor the surface and the routes BEFORE it starts', async () => {
        // Held by the supervisor and sent on attach — so a shuttle this Genie
        // attaches to never serves a moment of the previous Genie's surface.
        const h = harness();
        const order: string[] = [];
        h.supervisor.publish.mockImplementation(() => void order.push('publish'));
        h.supervisor.topology.mockImplementation(() => void order.push('topology'));
        h.supervisor.start.mockImplementation(async () => {
            order.push('start');
            return { mode: 'shuttle', how: 'attached' };
        });

        await start(h);

        expect(order).toEqual(['publish', 'topology', 'start']);
        expect(h.supervisor.publish).toHaveBeenCalledWith(MANIFEST);
        expect(h.supervisor.topology).toHaveBeenCalledWith(TABLE);
    });

    it('binds in-process when no shuttle can be had, and says why', async () => {
        const log = vi.fn();
        const h = harness({ start: async () => ({ mode: 'in-process', reason: 'Port 51717 is already in use.' }) });
        h.deps.log = log;

        const endpoint = await start(h);

        expect(endpoint.mode()).toBe('in-process');
        expect(h.server.bindInProcess).toHaveBeenCalledOnce();
        expect(h.supervisor.stop).toHaveBeenCalled();
        expect(log.mock.calls.flat().join('\n')).toContain('Port 51717 is already in use.');
    });

    it('does not return until the port is actually bound here, however the fallback was reported', async () => {
        // The real supervisor reports in-process through onStatus BEFORE its
        // start() resolves with the same answer. Boot goes straight on to mint
        // endpoint URLs, which are null until the port is bound — so resolving on
        // the second report while the first report's bind is still running hands
        // the OS workspace no endpoint (genie#319's ordering, by another road).
        const h = harness();
        let bound = false;
        h.server.bindInProcess.mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 30));
            bound = true;
        });
        h.supervisor.start.mockImplementation(async () => {
            const status: ShuttleStatus = { mode: 'in-process', reason: 'no shuttle' };
            h.emit(status);
            return status;
        });

        await start(h);

        expect(bound).toBe(true);
        expect(h.server.bindInProcess).toHaveBeenCalledOnce();
    });

    it('tells the user when a WANTED shuttle could not run — once, with the reason', async () => {
        // §9.1: a fallback nobody can see is the silence the design forbids. Agents
        // keep working, but lose exactly what the owner turned the shuttle on for.
        const onFallback = vi.fn();
        const h = harness({ start: async () => ({ mode: 'in-process', reason: 'No standalone Node runtime.' }) });
        h.deps.onFallback = onFallback;

        await start(h);
        h.emit({ mode: 'in-process', reason: 'again' });

        expect(onFallback).toHaveBeenCalledOnce();
        expect(onFallback).toHaveBeenCalledWith('No standalone Node runtime.');
    });

    it('POSITIVE CONTROL: says nothing when the shuttle is simply off, or attached', async () => {
        const off = harness({ shuttleEnabled: false });
        off.deps.onFallback = vi.fn();
        const on = harness();
        on.deps.onFallback = vi.fn();

        await start(off);
        await start(on);

        expect(off.deps.onFallback).not.toHaveBeenCalled();
        expect(on.deps.onFallback).not.toHaveBeenCalled();
    });

    it('binds in-process when its surface cannot even be built', async () => {
        const h = harness({ manifest: async () => Promise.reject(new Error('tools/list answered an error')) });

        const endpoint = await start(h);

        expect(endpoint.mode()).toBe('in-process');
        expect(h.server.bindInProcess).toHaveBeenCalledOnce();
        expect(h.supervisor.start).not.toHaveBeenCalled();
    });

    it('takes the port back when a working shuttle dies and cannot be brought back', async () => {
        const h = harness();
        const endpoint = await start(h);

        h.emit({ mode: 'in-process', reason: 'The MCP shuttle stopped and could not be brought back.' });
        await vi.waitFor(() => expect(h.server.bindInProcess).toHaveBeenCalledOnce());

        expect(endpoint.mode()).toBe('in-process');
        // And only once, however many times it is told.
        h.emit({ mode: 'in-process', reason: 'again' });
        await new Promise((r) => setTimeout(r, 20));
        expect(h.server.bindInProcess).toHaveBeenCalledOnce();
    });

    it('sends the shuttle a changed routing table, once for a burst of changes', async () => {
        const h = harness();
        await start(h);
        h.supervisor.topology.mockClear();
        const next: ShuttleTopology = { endpoints: { tok: { kind: 'workspace', workspaceId: 'w' } }, workspaces: { w: ['t'] } };

        h.changeTopology(next);
        h.changeTopology(next);
        h.changeTopology(next);

        await vi.waitFor(() => expect(h.supervisor.topology).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 30));
        expect(h.supervisor.topology).toHaveBeenCalledOnce();
        expect(h.supervisor.topology).toHaveBeenCalledWith(next);
    });

    it('runs a forwarded call in the context of the terminal the shuttle resolved', async () => {
        const h = harness();
        await start(h);

        await h.run({
            correlationId: 1,
            generation: 1,
            request: { id: 1, method: 'ping' },
            route: { token: 'tok', terminalId: 't-a' },
        });

        expect(h.server.contextFor).toHaveBeenCalledWith('t-a');
    });

    it('republishes the surface when asked — a plugin turned on changes the tool list', async () => {
        const h = harness();
        let generation = 1;
        h.deps.manifest = async () => ({ generation: ++generation }) as unknown as ShuttleManifest;
        const endpoint = await start(h);
        h.supervisor.publish.mockClear();

        await endpoint.republishManifest();

        expect(h.supervisor.publish).toHaveBeenCalledWith({ generation: 3 });
    });

    it('stops listening for routes once stopped', async () => {
        const h = harness();
        const endpoint = await start(h);

        endpoint.stop();

        expect(h.supervisor.stop).toHaveBeenCalled();
        h.supervisor.topology.mockClear();
        h.changeTopology(TABLE);
        await new Promise((r) => setTimeout(r, 30));
        expect(h.supervisor.topology).not.toHaveBeenCalled();
    });
});
