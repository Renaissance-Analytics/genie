import { describe, expect, it, vi } from 'vitest';
import { provisionSteps, runProvisionSteps } from '../provision';
import type { CommandResult, ContainerRuntime } from '../../container-runtime';

/**
 * PROVISIONING (Tynn #234, P3) — how one shared engine is carved into a
 * per-workspace slice, and why that carving is the isolation.
 *
 * The steps are PURE argv, built here and asserted directly, for the same
 * reason `argv.ts` is pure: these are the statements that decide whether
 * workspace A can read workspace B's data, and they should be readable without
 * a database to run them against.
 *
 * The security property is NOT escaping. Identifiers are derived (`catalog.ts`)
 * and passwords are generated base64url, so both are drawn from closed
 * alphabets — and that is ASSERTED here rather than assumed, so the day someone
 * threads a user-supplied name through, it fails loudly instead of quietly
 * becoming a SQL-injection bug.
 */

const SLICE = { identifier: 'ws_acme_1a2b3c4d', dnsName: 'ws-acme-1a2b3c4d', password: 'pw-Abc_123' };
const ADMIN = { user: 'postgres', password: 'admin_pw-1' };

const flatten = (steps: { argv: string[] }[]) => steps.map((s) => s.argv.join(' ')).join('\n');

describe('postgres — a database and a role per workspace', () => {
    const steps = provisionSteps('postgres', ADMIN, SLICE);

    it('creates the login role with the workspace credential', () => {
        expect(flatten(steps)).toContain('CREATE ROLE "ws_acme_1a2b3c4d"');
        expect(flatten(steps)).toContain("PASSWORD 'pw-Abc_123'");
    });

    it('is idempotent — a second provision RESETS the password rather than failing', () => {
        // Provision runs on every acquire, so it must converge. The role branch
        // ALTERs when it already exists, which also repairs a workspace whose
        // stored credential and server credential have drifted apart.
        expect(flatten(steps)).toContain('ALTER ROLE');
        const createDb = steps.find((s) => s.argv.join(' ').includes('CREATE DATABASE'));
        expect(createDb?.tolerate?.test('ERROR: database "ws_acme_1a2b3c4d" already exists')).toBe(
            true,
        );
    });

    it('REVOKES connect from PUBLIC — without this, every role reaches every database', () => {
        // The load-bearing statement of the whole shared model: Postgres grants
        // CONNECT on a new database to PUBLIC by default, so workspace A's role
        // could open workspace B's database until this runs.
        expect(flatten(steps)).toContain('REVOKE CONNECT ON DATABASE "ws_acme_1a2b3c4d" FROM PUBLIC');
        expect(flatten(steps)).toContain('GRANT ALL PRIVILEGES ON DATABASE "ws_acme_1a2b3c4d"');
    });

    it('connects as the admin over loopback, so no pg_hba assumption is made', () => {
        expect(flatten(steps)).toContain('postgresql://postgres:admin_pw-1@127.0.0.1:5432/postgres');
    });

    it('stops on the first error inside a multi-statement script', () => {
        expect(flatten(steps)).toContain('ON_ERROR_STOP=1');
    });
});

describe('mysql — a schema and a user per workspace', () => {
    const steps = provisionSteps('mysql', { user: 'root', password: 'admin_pw-1' }, SLICE);

    it('creates the schema, the user and a grant scoped to that schema only', () => {
        const sql = flatten(steps);
        expect(sql).toContain('CREATE DATABASE IF NOT EXISTS `ws_acme_1a2b3c4d`');
        expect(sql).toContain("CREATE USER IF NOT EXISTS 'ws_acme_1a2b3c4d'@'%'");
        expect(sql).toContain('GRANT ALL PRIVILEGES ON `ws_acme_1a2b3c4d`.*');
        // The isolation: no global grant, ever.
        expect(sql).not.toContain('ON *.*');
    });

    it('re-asserts the password, so a drifted credential is repaired', () => {
        expect(flatten(steps)).toContain('ALTER USER');
    });
});

describe('redis — an ACL user per workspace', () => {
    const steps = provisionSteps('redis', { user: 'default', password: 'admin_pw-1' }, SLICE);

    it('restricts the user to its own key prefix', () => {
        const argv = steps[0].argv;
        expect(argv).toContain('SETUSER');
        expect(argv).toContain('~ws_acme_1a2b3c4d:*');
        expect(argv).toContain('>pw-Abc_123');
    });

    it('resets the user first, so a re-provision is a full redefinition', () => {
        // Redis ACLs are in-memory unless an aclfile is configured, so they are
        // gone after an engine restart and re-created on the next acquire. That
        // only converges if SETUSER starts from `reset`.
        expect(steps[0].argv).toContain('reset');
    });

    it('denies the commands that would reach outside the prefix or change auth', () => {
        const argv = steps[0].argv.join(' ');
        for (const denied of ['-flushall', '-flushdb', '-config', '-acl', '-shutdown']) {
            expect(argv).toContain(denied);
        }
    });
});

describe('namespace engines', () => {
    it('run NO commands — separation is by name, and it says so', () => {
        expect(provisionSteps('meilisearch', ADMIN, SLICE)).toEqual([]);
        expect(provisionSteps('minio', ADMIN, SLICE)).toEqual([]);
        expect(provisionSteps('mailpit', ADMIN, SLICE)).toEqual([]);
        expect(provisionSteps('custom', ADMIN, SLICE)).toEqual([]);
    });
});

describe('the argument-grammar guard', () => {
    it('refuses an identifier that is not a derived slug', () => {
        expect(() =>
            provisionSteps('postgres', ADMIN, { ...SLICE, identifier: 'ws"; DROP DATABASE x; --' }),
        ).toThrow(/identifier/i);
    });

    it('refuses a password that is not a generated one', () => {
        expect(() =>
            provisionSteps('postgres', ADMIN, { ...SLICE, password: "pw'; DROP DATABASE x; --" }),
        ).toThrow(/password/i);
    });

    it('refuses an admin password that is not a generated one', () => {
        expect(() =>
            provisionSteps('postgres', { user: 'postgres', password: "a'b" }, SLICE),
        ).toThrow(/password/i);
    });
});

// --- running the steps ------------------------------------------------------

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };

function fakeRuntime(exec: (argv: string[]) => CommandResult): ContainerRuntime {
    return {
        exec: vi.fn(async (_id: string, argv: string[]) => exec(argv)),
    } as unknown as ContainerRuntime;
}

describe('runProvisionSteps', () => {
    it('runs every step, in order, inside the engine container', async () => {
        const seen: string[][] = [];
        const runtime = fakeRuntime((argv) => {
            seen.push(argv);
            return OK;
        });
        const result = await runProvisionSteps(runtime, 'engine-id', provisionSteps('postgres', ADMIN, SLICE));
        expect(result.ok).toBe(true);
        expect(seen.length).toBe(provisionSteps('postgres', ADMIN, SLICE).length);
    });

    it('reports the FAILING step, with what the engine said', async () => {
        const runtime = fakeRuntime(() => ({ code: 1, stdout: '', stderr: 'FATAL: no such role' }));
        const result = await runProvisionSteps(runtime, 'engine-id', provisionSteps('postgres', ADMIN, SLICE));
        expect(result.ok).toBe(false);
        expect(result.error).toContain('FATAL: no such role');
        // Named, so the failure says WHICH part of provisioning broke.
        expect(result.error).toMatch(/role|database|grant/i);
    });

    it('tolerates the failure a step declares tolerable, and keeps going', async () => {
        const runtime = fakeRuntime((argv) =>
            argv.join(' ').includes('CREATE DATABASE')
                ? { code: 1, stdout: '', stderr: 'ERROR: database "x" already exists' }
                : OK,
        );
        const result = await runProvisionSteps(runtime, 'engine-id', provisionSteps('postgres', ADMIN, SLICE));
        expect(result.ok).toBe(true);
    });

    it('never throws — a provisioning failure is a status the caller reports', async () => {
        const runtime = {
            exec: async () => {
                throw new Error('engine gone');
            },
        } as unknown as ContainerRuntime;
        await expect(
            runProvisionSteps(runtime, 'engine-id', provisionSteps('postgres', ADMIN, SLICE)),
        ).resolves.toMatchObject({ ok: false });
    });
});
