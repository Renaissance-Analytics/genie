import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * A REMOVED ENGINE WHOSE DATA IS KEPT COMES BACK WITH THE CREDENTIALS ITS DATA HOLDS (moic's acceptance, 2026-10-16:
 * B11c/B11d). Postgres (MySQL, MariaDB) set the password only when the data directory is first made; the kept volume
 * keeps it. Re-added with a NEW random password, the engine refused the connection Genie wrote into .env
 * ("FATAL: password authentication failed") and the data the workspace kept was unreachable.
 *
 * So the credentials are remembered beside the ports when the data is KEPT (and forgotten when it is deleted), and an
 * engine added again under the same container name is created with them — whatever happened to its port. A shared
 * engine's superuser and its workspaces' slices (roles that live in that same data) come back with it.
 *
 * Every value is invented; names are RFC 2606 (`example-*`).
 */

function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const containers = new Map<string, 'created' | 'running' | 'exited'>();
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: '[{}]', exitCode: 0 };
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'stop') { containers.set(args[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'rm') { containers.delete(args[args.length - 1]!); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'exec') return { stdout: args.includes('PING') ? 'PONG\n' : args.includes('SETUSER') ? 'OK\n' : '', exitCode: 0 };
        return { stdout: '', exitCode: 0 };
    };
    const execs = () => calls.filter((c) => c[0] === 'exec').map((c) => c.slice(2));
    const creates = () => calls.filter((c) => c[0] === 'create');
    return { run, calls, containers, execs, creates };
}

let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let registry: ServiceRegistry;
let port: number;
let pw: number;
let busy: Set<number>;

const open = async () => {
    registry = await ServiceRegistry.open(dir, new ServiceDriver(docker.run), {
        allocatePort: () => ++port,
        randomPassword: () => `genpw-${String(++pw).padStart(4, '0')}`,
        sliceReadiness: { timeoutMs: 5_000, pollMs: 500 },
        sleep: async () => {},
        portFree: async (p) => !busy.has(p),
    });
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-db-choice-'));
    docker = fakeDocker();
    port = 4100;
    pw = 0;
    busy = new Set();
    await open();
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const WS = 'example-moic';
const SHARED = { kind: 'shared' } as const;
const MINE = { kind: 'dedicated', workspaceId: WS } as const;
const pgv = (scope: typeof MINE | typeof SHARED) => ({ engine: 'postgres', major: '17', variant: 'pgvector', scope, consent: true, workspaceId: WS });
/** The POSTGRES_PASSWORD each `docker create` was given, in order. */
const createdPasswords = () => docker.creates().map((c) => c.find((a) => a.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length) ?? null);

describe('remove with the data kept, then add again', () => {
    it('a dedicated engine is created again with the SAME password, and the workspace env carries it (across a reopen)', async () => {
        await registry.add(pgv(MINE));
        const before = registry.envFor(WS).DB_PASSWORD;
        expect(before).toBeTruthy();
        await registry.remove(registry.list(WS)[0]!.id, { deleteData: false });
        await open();
        await registry.add(pgv(MINE));
        expect(registry.envFor(WS).DB_PASSWORD).toBe(before);
        expect(createdPasswords()).toEqual([before, before]);
    });

    it('the password comes back even when the remembered PORT cannot (something else holds it)', async () => {
        await registry.add(pgv(MINE));
        const { DB_PASSWORD: before, DB_PORT: firstPort } = registry.envFor(WS);
        await registry.remove(registry.list(WS)[0]!.id, { deleteData: false });
        busy.add(Number(firstPort));
        await registry.add(pgv(MINE));
        expect(registry.envFor(WS).DB_PORT).not.toBe(firstPort); // CONTROL: the port really was not handed back
        expect(registry.envFor(WS).DB_PASSWORD).toBe(before);
    });

    it('CONTROL: with the data DELETED there is nothing to match — a new password', async () => {
        await registry.add(pgv(MINE));
        const before = registry.envFor(WS).DB_PASSWORD;
        await registry.remove(registry.list(WS)[0]!.id, { deleteData: true, workspaceId: WS });
        await registry.add(pgv(MINE));
        expect(registry.envFor(WS).DB_PASSWORD).not.toBe(before);
    });

    it("a SHARED engine comes back with its superuser and the workspace's slice — the role is not made twice", async () => {
        await registry.add(pgv(SHARED));
        const before = registry.envFor(WS);
        const adminBefore = createdPasswords()[0];
        const rolesMade = () => docker.execs().filter((a) => /CREATE ROLE/i.test(a[a.length - 1] ?? '')).length;
        expect(rolesMade()).toBe(1);
        const shared = registry.list().find((i) => i.scope.kind === 'shared')!;
        await registry.remove(shared.id, { deleteData: false });
        await registry.add(pgv(SHARED));
        expect(createdPasswords()).toEqual([adminBefore, adminBefore]);
        expect(registry.envFor(WS).DB_USERNAME).toBe(before.DB_USERNAME);
        expect(registry.envFor(WS).DB_PASSWORD).toBe(before.DB_PASSWORD);
        expect(rolesMade()).toBe(1);
    });
});
