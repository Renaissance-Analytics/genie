import { describe, expect, it } from 'vitest';
import { applyCaddyConfig, CADDY_CONFIG_PATH } from '../caddy-proxy';
import type { CommandResult, ContainerRuntime, ExecOptions } from '../container-runtime';

/**
 * Driving the per-workspace Caddy inside the sandbox: write the generated
 * Caddyfile to a container-internal path, then RELOAD a running Caddy or START it
 * if it isn't up yet — one idempotent converge step. Never throws; a failure is a
 * result the caller turns into a failed-site status.
 */
function fakeRuntime(exec?: (argv: string[]) => CommandResult): {
    runtime: ContainerRuntime;
    execs: Array<{ id: string; argv: string[]; opts?: ExecOptions }>;
} {
    const execs: Array<{ id: string; argv: string[]; opts?: ExecOptions }> = [];
    const runtime = {
        async exec(id: string, argv: string[], opts?: ExecOptions) {
            execs.push({ id, argv, ...(opts ? { opts } : {}) });
            return exec ? exec(argv) : { code: 0, stdout: '', stderr: '' };
        },
    } as unknown as ContainerRuntime;
    return { runtime, execs };
}

describe('applyCaddyConfig', () => {
    it('writes the Caddyfile then reloads-or-starts Caddy, in one exec', async () => {
        const { runtime, execs } = fakeRuntime();
        const r = await applyCaddyConfig(runtime, 'sandbox-1', [
            { host: 'web.acme.gen', port: 5173 },
        ]);
        expect(r.ok).toBe(true);
        expect(execs).toHaveLength(1);
        const script = execs[0].argv[2] ?? '';
        // Config is written to the container-internal path (base64-decoded, so no
        // shell-quoting hazard from the Caddyfile body).
        expect(script).toContain(`base64 -d > '${CADDY_CONFIG_PATH}'`);
        // Reload if running, else start — Caddy converges either way.
        expect(script).toMatch(/caddy reload .*\|\| .*caddy start/);
        expect(script).toContain('--adapter caddyfile');
    });

    it('carries the site set into the written config (base64 round-trips the vhost)', async () => {
        const { runtime, execs } = fakeRuntime();
        await applyCaddyConfig(runtime, 'sandbox-1', [{ host: 'api.acme.gen', port: 8000 }]);
        const script = execs[0].argv[2] ?? '';
        const b64 = /printf %s '([A-Za-z0-9+/=]+)'/.exec(script)?.[1] ?? '';
        const decoded = Buffer.from(b64, 'base64').toString('utf8');
        expect(decoded).toContain('api.acme.gen');
        expect(decoded).toContain('reverse_proxy 127.0.0.1:8000');
    });

    it('is ok with zero sites (Caddy runs with an empty config)', async () => {
        const { runtime } = fakeRuntime();
        expect((await applyCaddyConfig(runtime, 'sandbox-1', [])).ok).toBe(true);
    });

    it('reports rather than throws when the exec fails', async () => {
        const { runtime } = fakeRuntime(() => ({ code: 1, stdout: '', stderr: 'caddy: boom' }));
        const r = await applyCaddyConfig(runtime, 'sandbox-1', [{ host: 'x.gen', port: 3000 }]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/caddy/i);
    });

    it('rejects a bad site before touching the container', async () => {
        const { runtime, execs } = fakeRuntime();
        const r = await applyCaddyConfig(runtime, 'sandbox-1', [{ host: 'bad {', port: 3000 }]);
        expect(r.ok).toBe(false);
        expect(execs).toHaveLength(0);
    });
});
