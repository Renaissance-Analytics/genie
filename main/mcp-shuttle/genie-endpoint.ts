import type { McpContext } from '../mcp/protocol';
import type { DispatchFrame, ShuttleResponse } from './core';
import type { ShuttleStatus, ShuttleSupervisor, ShuttleSupervisorEvents } from './ensure';
import type { ShuttleManifest } from './manifest-store';
import { runDispatch } from './publisher';
import type { ShuttleTopology } from './topology-store';

/**
 * WHO SERVES GENIE'S MCP PORT — the shuttle, or this process. Never neither.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.3 and §9.1. The server
 * module mints tokens and runs calls; the supervisor gets a shuttle. This decides
 * between them at boot and keeps the decision true afterwards:
 *
 *  - shuttle not enabled → bind in-process, exactly as before;
 *  - a shuttle attached → the port is the shuttle's, and nothing binds it here;
 *  - no shuttle to be had (or no surface to give one) → bind in-process, and log
 *    why, because a fallback nobody can see is the silence §9.1 forbids;
 *  - a working shuttle that dies and cannot be brought back → take the port back,
 *    once, so the URLs every agent holds answer again.
 *
 * Every effect is injected; `background.ts` supplies the real server and supervisor.
 */

export interface McpEndpointServer {
    adoptShuttleListener(): void;
    bindInProcess(): Promise<void>;
    topology(): ShuttleTopology;
    onTopologyChanged(listener: () => void): () => void;
    contextFor(terminalId: string): McpContext;
}

export interface McpEndpointDeps {
    shuttleEnabled: boolean;
    server: McpEndpointServer;
    createSupervisor(
        run: (frame: DispatchFrame) => Promise<ShuttleResponse>,
        events: ShuttleSupervisorEvents,
    ): ShuttleSupervisor;
    /** The surface this Genie serves, built fresh each time it is asked. */
    manifest(): Promise<ShuttleManifest>;
    /** How long a burst of routing changes is gathered before it is sent. */
    topologyDebounceMs?: number;
    /** A shuttle that was turned on is not serving, and why — once. */
    onFallback?(reason: string): void;
    /**
     * Stop a shuttle an earlier session left running, when the shuttle is now off.
     * It would otherwise keep the port: this Genie's bind would lose to it and fall
     * back to a temporary port that no `.mcp.json` names.
     */
    stopRunningShuttle?(): Promise<void>;
    /**
     * Before attaching: deal with a running shuttle that is wrong for this Genie —
     * one listening on a port the owner has since changed would be attached to,
     * while every URL this Genie mints names the new port.
     */
    prepareShuttle?(): Promise<void>;
    log?(line: string): void;
}

export interface McpEndpoint {
    mode(): 'shuttle' | 'in-process' | 'displaced';
    /**
     * Did this Genie take over an endpoint that never went down? True only when the
     * boot ATTACHED to a shuttle already serving — then every agent's `genie`
     * connection lived through the swap, and the upgrade notice must not repair
     * it (genie#346). A shuttle this Genie had to start or replace, or serving
     * in-process, means the previous endpoint went away with the previous Genie.
     */
    keptAgentConnections(): boolean;
    /** Build the surface again and send it — the tool list changed. */
    republishManifest(): Promise<void>;
    stop(): void;
}

const DEFAULT_TOPOLOGY_DEBOUNCE_MS = 50;

export async function startMcpEndpoint(deps: McpEndpointDeps): Promise<McpEndpoint> {
    const log = (line: string) => deps.log?.(`[mcp-endpoint] ${line}`);
    let mode: 'shuttle' | 'in-process' | 'displaced' = 'in-process';
    let attachedAtBoot = false;
    let supervisor: ShuttleSupervisor | null = null;
    let unsubscribe: (() => void) | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    /**
     * The one bind of the port here, shared by everyone who asks. The supervisor
     * reports a fallback through `onStatus` AND resolves `start()` with it; the
     * second caller has to wait on the first's bind, not return while it runs —
     * boot mints endpoint URLs next, and those are null until the port is bound.
     */
    let portTaken: Promise<void> | null = null;

    const inProcess = (reason: string | null): Promise<void> =>
        (portTaken ??= (async () => {
            mode = 'in-process';
            if (reason) {
                log(`serving in-process: ${reason}`);
                deps.onFallback?.(reason);
            }
            unsubscribe?.();
            unsubscribe = null;
            supervisor?.stop();
            await deps.server.bindInProcess();
        })());

    const endpoint: McpEndpoint = {
        mode: () => mode,
        keptAgentConnections: () => attachedAtBoot,
        async republishManifest() {
            if (!supervisor || mode !== 'shuttle') return;
            try {
                supervisor.publish(await deps.manifest());
            } catch (e) {
                // The shuttle keeps the last surface it was given, which is better
                // than a surface with a hole in it.
                log(`could not rebuild the MCP surface: ${(e as Error).message}`);
            }
        },
        stop() {
            if (debounce) clearTimeout(debounce);
            unsubscribe?.();
            unsubscribe = null;
            supervisor?.stop();
        },
    };

    if (!deps.shuttleEnabled) {
        try {
            await deps.stopRunningShuttle?.();
        } catch (e) {
            log(`could not stop the MCP shuttle left running by an earlier session: ${(e as Error).message}`);
        }
        await inProcess(null);
        return endpoint;
    }

    deps.server.adoptShuttleListener();

    let manifest: ShuttleManifest;
    try {
        manifest = await deps.manifest();
    } catch (e) {
        await inProcess(`Genie could not build the surface to give the MCP shuttle: ${(e as Error).message}`);
        return endpoint;
    }

    const onStatus = (status: ShuttleStatus) => {
        if (status.mode === 'in-process') {
            void inProcess(status.reason);
        } else if (status.mode === 'displaced') {
            mode = 'displaced';
            log(`a newer Genie took the MCP shuttle over: ${status.reason}`);
        } else {
            mode = 'shuttle';
        }
    };
    supervisor = deps.createSupervisor((frame) => runDispatch(frame, deps.server.contextFor), { onStatus });

    supervisor.publish(manifest);
    supervisor.topology(deps.server.topology());
    unsubscribe = deps.server.onTopologyChanged(() => {
        if (debounce) return;
        debounce = setTimeout(() => {
            debounce = null;
            // Handed to the supervisor even while it is still attaching: it keeps the
            // latest and sends it on attach, so a change mid-boot is not lost.
            if (!portTaken) supervisor?.topology(deps.server.topology());
        }, deps.topologyDebounceMs ?? DEFAULT_TOPOLOGY_DEBOUNCE_MS);
        debounce.unref?.();
    });

    try {
        await deps.prepareShuttle?.();
    } catch (e) {
        log(`could not replace a shuttle on another port: ${(e as Error).message}`);
    }
    const status = await supervisor.start();
    if (status.mode === 'shuttle') {
        mode = 'shuttle';
        attachedAtBoot = status.how === 'attached';
        log(`serving through the MCP shuttle (${status.how})`);
    } else if (status.mode === 'in-process') {
        await inProcess(status.reason);
    }
    return endpoint;
}
