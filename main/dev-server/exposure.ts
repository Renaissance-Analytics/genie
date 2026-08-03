import { createHash } from 'node:crypto';
import type { PortPublish } from './container-runtime';

/**
 * PURE. WHAT A HOSTED SITE MAKES REACHABLE — the Hosting Manager's boundary.
 *
 * ## The rule
 *
 * **Browser-reachable ⇒ exposed (a `.gen` subdomain, and a port when the
 * protocol needs one). Backend ⇒ internal.**
 *
 * The unit of isolation is the workspace container, so `localhost` inside it IS
 * the workspace: the app reaches its own processes normally, with nothing
 * published. A shared database or cache is reached at the WORKSTATION engine's
 * address — the engine's container name on the workspace's own network, injected
 * as `DATABASE_URL` and friends by `services/env-wiring.ts`. That is backend
 * traffic, it never leaves the container network, and it is never given a
 * browser-facing name or a published port.
 *
 * What IS exposed is a short list: the app's HTTP surface at `<name>.gen`, plus
 * anything **the browser itself must connect to** — a websocket, a gRPC-web
 * endpoint, a raw stream. Nothing else.
 *
 * ## Why the `reason` field is required rather than documentation
 *
 * "Expose only what the browser needs" is a convention until something enforces
 * it. A caller that can add a surface without stating the need will eventually
 * add a database port "just to check something", and that port outlives the
 * check. So a surface with no reason is REFUSED, and the refusal is returned as
 * data (`rejected`) rather than thrown, because the site should still come up
 * with everything that was legitimate.
 *
 * ## Two things worth knowing before reading the code
 *
 * **A websocket on the app's own port needs nothing.** A WebSocket handshake is
 * an HTTP request with an `Upgrade` header, so it already reaches the app
 * through the `.gen` carrier. Publishing a second port for it opens a hole and
 * buys nothing — which is why the same-port case is detected and dropped.
 *
 * **A raw stream needs a STABLE port.** The site's own HTTP port is published
 * ephemerally, because nothing needs to know it: the carrier resolves `.gen` to
 * whatever it got. A gRPC or TCP client is configured with a number by a human
 * or a build, so an ephemeral port would move on every restart and break every
 * client that had been told where to dial. {@link stablePortFor} derives one
 * from the site and surface, so it survives restarts without a registry.
 */

// --- the model --------------------------------------------------------------

/**
 * What the browser speaks to this surface.
 *
 * `http` and `ws` ride the existing HTTP carrier (a websocket upgrade IS an HTTP
 * request), so they need a `.gen` name and nothing more. `grpc` and `tcp` cannot
 * — the session proxy is HTTP — so they get a published port and are reported
 * as a forward for the client to dial directly.
 */
export type BrowserProtocol = 'http' | 'ws' | 'grpc' | 'tcp';

export interface ExposedSurface {
    /** A DNS label. Becomes the first label of `<name>.<site>.gen`. */
    name: string;
    /** The port this surface listens on INSIDE the container. */
    port: number;
    protocol: BrowserProtocol;
    /** Why THE BROWSER must reach this. Required — see the file header. */
    reason: string;
}

export interface ExposureInput {
    /** The site's opaque id — half of the stable-port derivation. */
    siteId: string;
    /** The site's browser-facing name. */
    genName: string;
    /** The app's own HTTP port inside the container. */
    port: number;
    /** `tcp` sites are published and listed, but routed nowhere. */
    kind?: 'http' | 'tcp';
    /** Additional BROWSER-FACING surfaces. Backend services never appear here. */
    exposed?: readonly ExposedSurface[];
}

/** One `.gen` name the carrier should resolve to this site. */
export interface ExposureRoute {
    genName: string;
    /** The port INSIDE the container. The caller maps it to the published one. */
    containerPort: number;
    protocol: 'http' | 'ws';
}

/** A surface the browser dials directly, at a port that does not move. */
export interface ExposureForward {
    genName: string;
    containerPort: number;
    hostPort: number;
    protocol: 'grpc' | 'tcp';
}

export interface ExposureRejection {
    name: string;
    error: string;
}

export interface ExposurePlan {
    /** Exactly what the site container publishes. Nothing else is reachable. */
    publish: PortPublish[];
    routes: ExposureRoute[];
    forwards: ExposureForward[];
    rejected: ExposureRejection[];
    /** Decisions worth reporting that are not refusals — e.g. a websocket that
     *  needed no port of its own. */
    notes: string[];
}

/**
 * Where a stable forward port is drawn from.
 *
 * Deliberately NOT the ephemeral range (49152+), which the OS hands out to
 * outbound connections — a fixed port in there gets stolen by an unrelated
 * process and the failure looks like Genie's. The 20000s are in the registered
 * range and almost entirely unassigned.
 */
export const STABLE_PORT_RANGE = { min: 20000, max: 29999 } as const;

/** A DNS label: what a surface name must be, because it becomes part of an
 *  origin the browser will trust. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host port a raw surface is always published on.
 *
 * Derived rather than allocated, for the same reason every container name in
 * this module is: it has to be the SAME number after a restart, an app update
 * and a reboot, with nothing stored. A collision with something else on the
 * machine is possible and is reported by the runtime when the bind fails —
 * visibly, at start, rather than as a client that silently reaches the wrong
 * program.
 */
export function stablePortFor(siteId: string, surfaceName: string): number {
    const digest = createHash('sha256').update(`${siteId}\0${surfaceName}`).digest();
    const span = STABLE_PORT_RANGE.max - STABLE_PORT_RANGE.min + 1;
    return STABLE_PORT_RANGE.min + (digest.readUInt32BE(0) % span);
}

// --- the plan ---------------------------------------------------------------

export function planExposure(input: ExposureInput): ExposurePlan {
    const publish: PortPublish[] = [
        // The app's own surface: loopback, ephemeral. The carrier reads the real
        // port back, so nothing has to know it in advance — and two workspaces
        // hosting on 8080 never collide.
        { container: input.port, hostIp: '127.0.0.1' },
    ];
    const routes: ExposureRoute[] = [];
    const forwards: ExposureForward[] = [];
    const rejected: ExposureRejection[] = [];
    const notes: string[] = [];

    if ((input.kind ?? 'http') === 'http') {
        routes.push({ genName: input.genName, containerPort: input.port, protocol: 'http' });
    }

    const claimed = new Set<string>();
    for (const surface of input.exposed ?? []) {
        const name = String(surface.name ?? '').trim().toLowerCase();
        if (!DNS_LABEL.test(name)) {
            rejected.push({
                name: String(surface.name ?? ''),
                error: `"${surface.name}" is not a DNS label, and this name becomes the first label of an origin the browser trusts.`,
            });
            continue;
        }
        if (!String(surface.reason ?? '').trim()) {
            rejected.push({
                name,
                error: `"${name}" was not exposed: say why the BROWSER must reach it. Backend surfaces — a database, a cache, an internal API the server calls — stay on the workspace network and are reached through the injected environment, not through a published port.`,
            });
            continue;
        }
        if (
            !Number.isInteger(surface.port) ||
            surface.port < 1 ||
            surface.port > 65535
        ) {
            rejected.push({ name, error: `"${name}" has no valid container port.` });
            continue;
        }
        if (claimed.has(name)) {
            rejected.push({
                name,
                error: `"${name}.${input.genName}" is already claimed by another surface on this site.`,
            });
            continue;
        }

        if (surface.protocol === 'ws' || surface.protocol === 'http') {
            if (surface.port === input.port) {
                // Already reachable: the handshake is an HTTP request to the
                // same port the carrier is already forwarding.
                notes.push(
                    `"${name}" listens on the site's own port ${input.port}, so it is already reachable at https://${input.genName} — a websocket upgrades over the existing connection and needs no port of its own.`,
                );
                claimed.add(name);
                continue;
            }
            claimed.add(name);
            publish.push({ container: surface.port, hostIp: '127.0.0.1' });
            routes.push({
                genName: `${name}.${input.genName}`,
                containerPort: surface.port,
                protocol: surface.protocol,
            });
            continue;
        }

        // grpc / tcp: the HTTP carrier cannot express these, so the client dials
        // the published port directly — and that port must not move.
        claimed.add(name);
        const hostPort = stablePortFor(input.siteId, name);
        publish.push({ container: surface.port, host: hostPort, hostIp: '127.0.0.1' });
        forwards.push({
            genName: `${name}.${input.genName}`,
            containerPort: surface.port,
            hostPort,
            protocol: surface.protocol,
        });
    }

    return { publish, routes, forwards, rejected, notes };
}
