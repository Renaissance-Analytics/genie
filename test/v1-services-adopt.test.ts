import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InspectedContainer } from '../src/core/v1-services.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { runtimeDir } from '../src/main/paths.js';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { runV1ServicesAdoption } from '../src/main/v1-services.js';

/**
 * THE UPGRADE BOOT TAKES OVER GENIE 1's ENGINES AND STOPS ITS SANDBOXES (2026-10-14). The owner: "the
 * upgrade should have shut down everything that was genie 1 so that everything running was genie 2
 * and what needed to be migrated, was migrated."
 *
 * Driven through `runV1ServicesAdoption` — what composition runs at boot — and once through
 * `composeServices` itself, against a Genie 1 database built here from Genie 1's REAL `CREATE TABLE`
 * statements (repos/genie main/db.ts migrations v33 and v48, `workspaces` as v1 created it plus the
 * `dev_services` column its migration adds) and a fake Docker that keeps container state. Every value
 * is invented.
 *
 * The contract:
 * - Adopted engines are REGISTERED, never created, pulled or removed; one that is not running is started.
 * - Genie 1's sandbox and site containers get `--restart=no` and are stopped — never removed.
 * - ONCE: recorded in services.json; a later boot makes no docker call at all.
 * - Blind boots are PROVISIONAL: no Genie 1 database → Docker is not even asked; Docker down → nothing
 *   decided. A later boot that can see takes over.
 * - A failed stop is not "done": the next boot repeats, and nothing is added twice.
 * - The report says what happened and carries no credential. Genie 1's database is opened read-only.
 */

const ENGINES = `CREATE TABLE IF NOT EXISTS dev_service_engines (
                        key TEXT PRIMARY KEY,
                        engine TEXT NOT NULL,
                        version TEXT NOT NULL,
                        workspace_id TEXT,
                        admin_user TEXT NOT NULL,
                        admin_password TEXT NOT NULL,
                        created_at INTEGER NOT NULL
                    )`;
const PORTS = `CREATE TABLE IF NOT EXISTS dev_service_ports (
                        record_key TEXT NOT NULL,
                        port_name TEXT NOT NULL,
                        host_port INTEGER NOT NULL,
                        created_at INTEGER NOT NULL,
                        PRIMARY KEY (record_key, port_name)
                    )`;
const WORKSPACES = `CREATE TABLE "workspaces" (
                    id                TEXT PRIMARY KEY,
                    tynn_project_id   TEXT NOT NULL,
                    tynn_project_name TEXT NOT NULL,
                    shape             TEXT NOT NULL CHECK (shape IN ('agi','simple')),
                    path              TEXT NOT NULL,
                    editor            TEXT,
                    editor_cmd        TEXT,
                    start_cmd         TEXT,
                    env_file          TEXT,
                    last_opened_at    TEXT,
                    created_by_genie  INTEGER NOT NULL DEFAULT 0
                , backend TEXT NOT NULL DEFAULT 'tynn', project_id   TEXT, project_name TEXT, sort_order INTEGER NOT NULL DEFAULT 0, hibernated_at INTEGER)`;

const ALPHA = 'ws-alpha';
const BETA = 'ws-beta';
const SECRETS = ['admin-pg-secret', 'alpha-pg-pw', 'beta-pg-pw', 'admin-redis-secret', 'alpha-redis-pw', 'admin-mail-secret', 'alpha-mail-pw'];

function writeV1(file: string): void {
    const db = new DatabaseSync(file);
    db.exec(WORKSPACES);
    db.exec('ALTER TABLE workspaces ADD COLUMN dev_services TEXT');
    db.exec(ENGINES);
    db.exec(PORTS);
    const ws = db.prepare("INSERT INTO workspaces (id, tynn_project_id, tynn_project_name, shape, path, dev_services) VALUES (?, ?, ?, 'agi', ?, ?)");
    ws.run(ALPHA, 'p-alpha', 'Alpha', '/w/alpha', JSON.stringify({
        a1: { engine: 'postgres', version: '17', dedicated: false, enabled: true, active: true, password: 'alpha-pg-pw' },
        a2: { engine: 'redis', version: '7', dedicated: true, enabled: true, password: 'alpha-redis-pw' },
        a3: { engine: 'mailpit', version: '1.30', dedicated: false, enabled: true, password: 'alpha-mail-pw' },
    }));
    ws.run(BETA, 'p-beta', 'Beta', '/w/beta', JSON.stringify({ b1: { engine: 'postgres', version: '17', dedicated: false, enabled: true, password: 'beta-pg-pw' } }));
    const engine = db.prepare('INSERT INTO dev_service_engines (key, engine, version, workspace_id, admin_user, admin_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    engine.run('postgres-17', 'postgres', '17', null, 'postgres', 'admin-pg-secret', 1);
    engine.run(`redis-7@${ALPHA}`, 'redis', '7', ALPHA, 'default', 'admin-redis-secret', 2);
    engine.run('mailpit-1.30', 'mailpit', '1.30', null, '', 'admin-mail-secret', 3);
    db.prepare('INSERT INTO dev_service_ports (record_key, port_name, host_port, created_at) VALUES (?, ?, ?, ?)').run('postgres-17', 'postgres', 30001, 1);
    db.close();
}

const bind = (port: number) => [{ HostIp: '127.0.0.1', HostPort: String(port) }];
const fixtureContainers = (): InspectedContainer[] => [
    { Name: '/genie-svc-postgres-17', Config: { Image: 'ghcr.io/renaissance-analytics/genie-postgres:pg17-1', Labels: { 'genie.service': 'postgres-17', 'genie.role': 'service' } }, State: { Status: 'running' }, NetworkSettings: { Ports: { '5432/tcp': bind(35432) } }, Mounts: [{ Type: 'volume', Name: 'genie-svc-postgres-17-data', Destination: '/var/lib/postgresql/data' }] },
    { Name: '/genie-svc-redis-7-ws-alpha', Config: { Image: 'redis:7-alpine', Labels: { 'genie.service': 'redis-7', 'genie.workspace': ALPHA, 'genie.role': 'service' } }, State: { Status: 'exited' }, NetworkSettings: { Ports: {} }, HostConfig: { PortBindings: { '6379/tcp': bind(36379) } }, Mounts: [{ Type: 'volume', Name: 'genie-svc-redis-7-ws-alpha-data', Destination: '/data' }] },
    { Name: '/genie-svc-mailpit-1.30', Config: { Image: 'axllent/mailpit:v1.30', Labels: { 'genie.service': 'mailpit-1.30', 'genie.role': 'service' } }, State: { Status: 'running' }, NetworkSettings: { Ports: { '1025/tcp': bind(31025), '8025/tcp': bind(38025) } } },
    { Name: '/genie-ws-ws-alpha-site-web', Config: { Image: 'example.test/app-dev:1', Labels: { 'genie.workspace': ALPHA, 'genie.role': 'site', 'genie.site': 'site-web' } }, State: { Status: 'running' } },
    { Name: '/genie-ws-ws-beta-dev', Config: { Image: 'example.test/dev-base:1', Labels: { 'genie.workspace': BETA, 'genie.role': 'workspace-dev' } }, State: { Status: 'running' } },
];

/** A Docker that keeps state: `ps` by label, `container inspect`, start/stop/update — and counts every call. */
function fakeDocker(initial: InspectedContainer[] = fixtureContainers()) {
    const calls: (readonly string[])[] = [];
    const containers = new Map(initial.map((c) => [c.Name!.replace(/^\//, ''), c]));
    const running = new Map(initial.map((c) => [c.Name!.replace(/^\//, ''), c.State?.Status ?? 'created']));
    const restart = new Map<string, string>();
    const control = { up: true, failStop: new Set<string>() };
    const run: DockerRunner = async (args) => {
        calls.push(args);
        if (!control.up) return { stdout: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', exitCode: 1 };
        const [cmd, sub] = args;
        if (cmd === 'ps') {
            const label = args[args.indexOf('--filter') + 1]!.replace(/^label=/, '');
            return { stdout: [...containers].filter(([, c]) => c.Config?.Labels?.[label] !== undefined).map(([n]) => n).join('\n'), exitCode: 0 };
        }
        if (cmd === 'container' && sub === 'inspect') {
            const found = args.slice(2).flatMap((n) => {
                const c = containers.get(n);
                return c ? [{ ...c, State: { Status: running.get(n) } }] : [];
            });
            return { stdout: JSON.stringify(found), exitCode: found.length === args.length - 2 ? 0 : 1 };
        }
        const name = args.at(-1)!;
        if (cmd === 'start') { running.set(name, 'running'); return { stdout: name, exitCode: 0 }; }
        if (cmd === 'stop') {
            if (control.failStop.has(name)) return { stdout: `Error response from daemon: cannot stop container: ${name}`, exitCode: 1 };
            running.set(name, 'exited');
            return { stdout: name, exitCode: 0 };
        }
        if (cmd === 'update') { restart.set(name, args[1]!); return { stdout: name, exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
    const status = (name: string) => running.get(name);
    return { run, calls, restart, control, status };
}

let home: string;
let v1File: string;
let docker: ReturnType<typeof fakeDocker>;
const reportFile = () => join(home, 'v1-services.json');
const servicesFile = () => join(runtimeDir(home), 'services.json');
const openRegistry = () => ServiceRegistry.open(home, new ServiceDriver(docker.run), { allocatePort: () => 4101, randomPassword: () => 'never-used' });
const adopt = async (registry?: ServiceRegistry) => {
    const r = registry ?? (await openRegistry());
    await runV1ServicesAdoption(r, { database: v1File, docker: docker.run, reportFile: reportFile(), now: () => Date.UTC(2026, 9, 14) });
    return r;
};
const verbs = (verb: string) => docker.calls.filter((c) => c[0] === verb);
const md5 = (f: string) => createHash('md5').update(readFileSync(f)).digest('hex');

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'genie2-v1-services-'));
    v1File = join(home, 'v1-genie.db');
    docker = fakeDocker();
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the upgrade boot takes over Genie 1's engines", () => {
    it('registers the engines AS THEY ARE and gives each workspace the env its .env already has — no create, no pull, no rm', async () => {
        writeV1(v1File);
        const registry = await adopt();
        expect(registry.list().map((i) => i.id).sort()).toEqual(['svc_v1_mailpit-1.30', 'svc_v1_postgres-17', `svc_v1_redis-7@${ALPHA}`]);
        expect(registry.envFor(ALPHA)).toMatchObject({ DB_PORT: '35432', DB_USERNAME: 'ws_ws_alpha', DB_PASSWORD: 'alpha-pg-pw', REDIS_PORT: '36379', REDIS_USERNAME: 'ws_ws_alpha', REDIS_PASSWORD: 'alpha-redis-pw', REDIS_PREFIX: 'ws_ws_alpha:', MAIL_PORT: '31025', GENIE_MAIL_TAG: 'ws_ws_alpha' });
        expect(registry.envFor(BETA)).toMatchObject({ DB_USERNAME: 'ws_ws_beta', DB_PASSWORD: 'beta-pg-pw' });
        expect(registry.envFor(BETA).REDIS_PORT).toBeUndefined();
        for (const verb of ['create', 'pull', 'rm', 'run', 'volume']) expect(verbs(verb), verb).toHaveLength(0);
    });

    it('starts the ONE adopted engine that was down, and nothing else', async () => {
        writeV1(v1File);
        await adopt();
        expect(verbs('start')).toEqual([['start', 'genie-svc-redis-7-ws-alpha']]);
        expect(docker.status('genie-svc-redis-7-ws-alpha')).toBe('running');
    });

    it("stops Genie 1's sandbox and site containers with their restart policy cleared FIRST — and touches no engine", async () => {
        writeV1(v1File);
        await adopt();
        const effects = docker.calls.filter((c) => c[0] === 'update' || c[0] === 'stop');
        expect(effects).toEqual([
            ['update', '--restart=no', 'genie-ws-ws-alpha-site-web'], ['stop', 'genie-ws-ws-alpha-site-web'],
            ['update', '--restart=no', 'genie-ws-ws-beta-dev'], ['stop', 'genie-ws-ws-beta-dev'],
        ]);
        expect(docker.status('genie-ws-ws-alpha-site-web')).toBe('exited');
        expect(docker.status('genie-ws-ws-beta-dev')).toBe('exited');
        // CONTROL: the engines are still up.
        expect(docker.status('genie-svc-postgres-17')).toBe('running');
        expect(docker.status('genie-svc-mailpit-1.30')).toBe('running');
    });

    it('writes a report of what it did — and no credential in it (CONTROL: the same scan finds them in services.json)', async () => {
        writeV1(v1File);
        await adopt();
        const text = readFileSync(reportFile(), 'utf8');
        const report = JSON.parse(text) as { adopted: unknown[]; started: { ok: boolean }[]; stopped: { ok: boolean }[]; skipped: unknown[] };
        expect(report.adopted).toHaveLength(3);
        expect(report.started.filter((s) => s.ok)).toHaveLength(1);
        expect(report.stopped.filter((s) => s.ok)).toHaveLength(2);
        expect(report.skipped).toHaveLength(0);
        for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
        const kept = readFileSync(servicesFile(), 'utf8');
        expect(SECRETS.filter((s) => kept.includes(s))).toHaveLength(SECRETS.length);
    });

    it("opens Genie 1's database read-only: its bytes are the same after", async () => {
        writeV1(v1File);
        const before = md5(v1File);
        await adopt();
        expect(md5(v1File)).toBe(before);
    });
});

describe('once, and only when it could see', () => {
    it('ONCE: a later boot makes no docker call at all, and the registry is unchanged', async () => {
        writeV1(v1File);
        const first = await adopt();
        const instances = first.list();
        const callsAfterFirst = docker.calls.length;
        expect(callsAfterFirst).toBeGreaterThan(0);
        const second = await adopt();
        expect(docker.calls.length - callsAfterFirst).toBe(0);
        expect(second.list()).toEqual(instances);
    });

    it('idempotent: a pass whose record was lost (a crash after the effects) adds nothing twice', async () => {
        writeV1(v1File);
        await adopt();
        const file = JSON.parse(readFileSync(servicesFile(), 'utf8')) as { instances: unknown[]; v1Import?: unknown };
        delete file.v1Import;
        writeFileSync(servicesFile(), JSON.stringify(file), 'utf8');
        const again = await adopt();
        expect(again.list()).toHaveLength(3);
        expect(again.v1Import()).toMatchObject({ sawV1: true, sawDocker: true, adopted: 0, alreadyHere: 3 });
    });

    it("no Genie 1 database: Docker is NOT asked, the record is provisional — and a later boot that can see takes over", async () => {
        const registry = await adopt();
        expect(docker.calls).toHaveLength(0);
        expect(registry.v1Import()).toMatchObject({ sawV1: false, sawDocker: false });
        expect(registry.list()).toHaveLength(0);
        writeV1(v1File);
        const later = await adopt();
        expect(later.list()).toHaveLength(3);
        expect(later.v1Import()).toMatchObject({ sawV1: true, sawDocker: true });
    });

    it('Docker down: nothing adopted, nothing stopped, the record is provisional — and a later boot with Docker takes over', async () => {
        writeV1(v1File);
        docker.control.up = false;
        const registry = await adopt();
        expect(registry.list()).toHaveLength(0);
        expect(registry.v1Import()).toMatchObject({ sawV1: true, sawDocker: false });
        expect(docker.calls.filter((c) => c[0] !== 'ps')).toHaveLength(0);
        expect(existsSync(reportFile())).toBe(false);
        docker.control.up = true;
        const later = await adopt();
        expect(later.list()).toHaveLength(3);
        expect(docker.status('genie-ws-ws-beta-dev')).toBe('exited');
    });

    it('a stop that FAILED is not done: the next boot repeats it (without adding anything twice), and then it is done', async () => {
        writeV1(v1File);
        docker.control.failStop.add('genie-ws-ws-beta-dev');
        const first = await adopt();
        expect(first.v1Import()).toMatchObject({ failed: 1, stopped: 1 });
        expect(docker.status('genie-ws-ws-beta-dev')).toBe('running');
        const report = JSON.parse(readFileSync(reportFile(), 'utf8')) as { stopped: { name: string; ok: boolean; output?: string }[] };
        expect(report.stopped.find((s) => s.name === 'genie-ws-ws-beta-dev')).toMatchObject({ ok: false, output: expect.stringMatching(/cannot stop/) });

        docker.control.failStop.clear();
        const second = await adopt();
        expect(docker.status('genie-ws-ws-beta-dev')).toBe('exited');
        expect(second.list()).toHaveLength(3);
        expect(second.v1Import()?.failed).toBeUndefined();
        const before = docker.calls.length;
        await adopt();
        expect(docker.calls.length - before).toBe(0);
    });
});

describe('at boot, through composition', () => {
    const pty: PtyPort = {
        open: () => ({ id: 'term_1', pid: 501, shell: 'sh', scrollback: '' }),
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => '',
        onData: () => () => {},
        onExit: () => () => {},
    };
    let services: ComposedServices | null = null;
    afterEach(async () => {
        await services?.shutdown();
        services = null;
    });

    // `v1Services` is the input boot wires to Genie 1's database; the cast keeps this file loadable on a tree without it.
    const compose = () => composeServices({ userData: home, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, now: () => Date.UTC(2026, 9, 14), docker: docker.run, v1Services: { database: v1File } } as never);

    it("composition takes Genie 1's engines over before anything reads a workspace's env, and writes the report", async () => {
        writeV1(v1File);
        services = await compose();
        expect(services.engines.envFor(ALPHA)).toMatchObject({ DB_PASSWORD: 'alpha-pg-pw', REDIS_USERNAME: 'ws_ws_alpha' });
        expect(docker.status('genie-ws-ws-alpha-site-web')).toBe('exited');
        expect(existsSync(reportFile())).toBe(true);
    });

    it("the loopback allocator never hands out a port an adopted engine publishes (Genie 2's own allocator starts at 4101)", async () => {
        writeV1(v1File);
        docker = fakeDocker(fixtureContainers().map((c) => (c.Name === '/genie-svc-postgres-17' ? { ...c, NetworkSettings: { Ports: { '5432/tcp': bind(4101) } } } : c)));
        services = await compose();
        expect(services.engines.envFor(BETA).DB_PORT).toBe('4101');
        const added = await services.engines.add({ engine: 'redis', major: '8', scope: { kind: 'shared' }, consent: true });
        expect(added).toMatchObject({ kind: 'added', instance: { publishedPort: 4102 } });
    });
});
