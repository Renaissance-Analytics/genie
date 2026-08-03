import { describe, expect, it } from 'vitest';
import { STABLE_PORT_RANGE, planExposure, stablePortFor } from '../exposure';

/**
 * The EXPOSURE MODEL (the Hosting Manager's load-bearing boundary).
 *
 * One rule, and everything here is a consequence of it:
 *
 *   **browser-reachable ⇒ exposed (subdomain + port); backend ⇒ internal.**
 *
 * The unit of isolation is the workspace container, so `localhost` inside it IS
 * the workspace — an app reaches its own processes normally, and a shared
 * database is reached at the workstation engine's address that gets injected as
 * environment. Neither of those is ever given a browser-facing name or a
 * published port, because a published port is a hole in the sandbox and a
 * database has no business behind one.
 *
 * What IS exposed: the app's HTTP surface, plus any websocket / gRPC / raw
 * stream **the browser itself must connect to** — and only when the caller can
 * say why.
 */

const site = { siteId: 'abc123', genName: 'web.acme.gen', port: 8080 };

describe('the app’s own HTTP surface', () => {
    it('is published and routed at the site’s .gen name, with no extra ports', () => {
        const plan = planExposure(site);
        expect(plan.publish).toEqual([{ container: 8080, hostIp: '127.0.0.1' }]);
        expect(plan.routes).toEqual([
            { genName: 'web.acme.gen', containerPort: 8080, protocol: 'http' },
        ]);
        expect(plan.forwards).toEqual([]);
    });

    it('publishes to LOOPBACK on an ephemeral port — never the LAN, never fixed', () => {
        // The site's own HTTP surface is reached through the `.gen` carrier, so
        // nothing needs to know its host port. Pinning one would collide the
        // moment two workspaces host a site on 8080.
        const [published] = planExposure(site).publish;
        expect(published?.hostIp).toBe('127.0.0.1');
        expect(published?.host).toBeUndefined();
    });
});

describe('a websocket the browser must reach', () => {
    it('on the app’s OWN port needs nothing extra — it upgrades over the carrier', () => {
        // The single most valuable thing this function knows. A WebSocket
        // handshake is an HTTP request, so a `ws://` on the same port as the
        // app is already reachable through `.gen`. Publishing a second port for
        // it would open a hole that buys nothing.
        const plan = planExposure({
            ...site,
            exposed: [
                { name: 'live', port: 8080, protocol: 'ws', reason: 'the client subscribes' },
            ],
        });
        expect(plan.publish).toEqual([{ container: 8080, hostIp: '127.0.0.1' }]);
        expect(plan.routes).toHaveLength(1);
        expect(plan.notes.join(' ')).toMatch(/upgrade|same port/i);
    });

    it('on a SEPARATE port gets its own subdomain, carried over the same proxy', () => {
        const plan = planExposure({
            ...site,
            exposed: [
                { name: 'live', port: 6001, protocol: 'ws', reason: 'Echo/Reverb from the browser' },
            ],
        });
        expect(plan.publish).toContainEqual({ container: 6001, hostIp: '127.0.0.1' });
        expect(plan.routes).toContainEqual({
            genName: 'live.web.acme.gen',
            containerPort: 6001,
            protocol: 'ws',
        });
        // A websocket rides the HTTP carrier, so it needs no raw port forward.
        expect(plan.forwards).toEqual([]);
    });
});

describe('gRPC and raw streams', () => {
    it('get a STABLE host port, because a client config cannot chase an ephemeral one', () => {
        const plan = planExposure({
            ...site,
            exposed: [
                { name: 'rpc', port: 50051, protocol: 'grpc', reason: 'grpc-web from the browser' },
            ],
        });
        const forward = plan.forwards[0];
        expect(forward?.genName).toBe('rpc.web.acme.gen');
        expect(forward?.hostPort).toBe(stablePortFor('abc123', 'rpc'));
        // Published at that exact number — an ephemeral one would move on every
        // restart and break every client that had been told where to dial.
        expect(plan.publish).toContainEqual({
            container: 50051,
            host: forward?.hostPort,
            hostIp: '127.0.0.1',
        });
    });

    it('derives that port deterministically, and differently per site and surface', () => {
        const a = stablePortFor('abc123', 'rpc');
        expect(stablePortFor('abc123', 'rpc')).toBe(a);
        expect(stablePortFor('abc123', 'stream')).not.toBe(a);
        expect(stablePortFor('def456', 'rpc')).not.toBe(a);
        expect(a).toBeGreaterThanOrEqual(STABLE_PORT_RANGE.min);
        expect(a).toBeLessThanOrEqual(STABLE_PORT_RANGE.max);
    });
});

describe('what is REFUSED — the boundary, enforced', () => {
    it('refuses a surface that cannot say why the BROWSER needs it', () => {
        // This is the whole guard. "Expose only what the browser needs" is not a
        // convention if a caller can skip stating the need — it is a comment.
        const plan = planExposure({
            ...site,
            exposed: [{ name: 'db', port: 5432, protocol: 'tcp', reason: '  ' }],
        });
        expect(plan.publish).toEqual([{ container: 8080, hostIp: '127.0.0.1' }]);
        expect(plan.rejected[0]?.name).toBe('db');
        expect(plan.rejected[0]?.error).toMatch(/reason|browser/i);
    });

    it('refuses a name that is not a DNS label — it would become part of an origin', () => {
        const plan = planExposure({
            ...site,
            exposed: [{ name: 'Not A Label', port: 6001, protocol: 'ws', reason: 'x' }],
        });
        expect(plan.routes).toHaveLength(1);
        expect(plan.rejected[0]?.error).toMatch(/label/i);
    });

    it('refuses two surfaces claiming one subdomain', () => {
        const plan = planExposure({
            ...site,
            exposed: [
                { name: 'live', port: 6001, protocol: 'ws', reason: 'a' },
                { name: 'live', port: 6002, protocol: 'ws', reason: 'b' },
            ],
        });
        expect(plan.routes.filter((r) => r.genName === 'live.web.acme.gen')).toHaveLength(1);
        expect(plan.rejected[0]?.error).toMatch(/already/i);
    });

    it('never publishes a backing service, however the site was configured', () => {
        // A shared Postgres is reached at the workstation engine's address,
        // injected as DATABASE_URL. There is deliberately no input to this
        // function through which a service could become a published port — the
        // env is not read here at all.
        const plan = planExposure({
            ...site,
            env: {
                DATABASE_URL: 'postgresql://u:p@genie-svc-postgres-16:5432/db',
                REDIS_URL: 'redis://genie-svc-redis-7:6379',
            },
        } as never);
        expect(plan.publish).toEqual([{ container: 8080, hostIp: '127.0.0.1' }]);
        expect(plan.routes).toHaveLength(1);
    });
});

describe('a tcp-kind site (no browser surface at all)', () => {
    it('is published but routed nowhere — the browser has nothing to open', () => {
        const plan = planExposure({ ...site, kind: 'tcp' });
        expect(plan.publish).toEqual([{ container: 8080, hostIp: '127.0.0.1' }]);
        expect(plan.routes).toEqual([]);
    });
});
