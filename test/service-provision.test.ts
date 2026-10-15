import { describe, expect, it } from 'vitest';
import { provisionSteps, readinessProbe, REDIS_DENIED, redisUserAclRule, stepSucceeded } from '../src/core/service-provision.js';
import { workspaceSqlIdentifier } from '../src/core/v1-services.js';

/**
 * A WORKSPACE'S SLICE OF A SHARED ENGINE — the commands, pure (hosting ship line H3). Genie 1's provisioning, ported:
 * a database + role per workspace on Postgres / MySQL / MariaDB, an ACL user pinned to a key prefix on Redis, each
 * named `ws_<slug>` exactly as Genie 1 derived it, run as the engine's superuser with its own client. What these
 * strings DO against a real engine is proven in genie-test-ubuntu (real Docker); here, that they say it.
 */

const ADMIN = { user: 'genie', password: 'admin-Example_pw1' };
const SLICE = { identifier: workspaceSqlIdentifier('example-a'), password: 'slice-Example_pw1' };

const sqlOf = (argv: readonly string[]) => argv[argv.length - 1]!;

describe('the names are Genie 1’s', () => {
    it('`ws_<slug>` from the workspace id — the name an adopted engine’s slice already has', () => {
        expect(workspaceSqlIdentifier('example-a')).toBe('ws_example_a');
        expect(workspaceSqlIdentifier('example-b')).toBe('ws_example_b');
    });
});

describe('postgres: a role, a database it owns, and CONNECT revoked from everyone else', () => {
    const steps = provisionSteps('postgres', ADMIN, SLICE);

    it('three steps — role, database, grants — through psql as the superuser over TCP inside the container', () => {
        expect(steps.map((s) => s.label)).toEqual(['role', 'database', 'grants']);
        for (const s of steps) expect(s.argv.slice(0, 2)).toEqual(['psql', 'postgresql://genie:admin-Example_pw1@127.0.0.1:5432/postgres']);
    });

    it('idempotent: the role is CREATEd or ALTERed (repairing a drifted password), and "already exists" is tolerated on the database', () => {
        expect(sqlOf(steps[0]!.argv)).toContain(`IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ws_example_a')`);
        expect(sqlOf(steps[0]!.argv)).toContain(`ALTER ROLE "ws_example_a" WITH LOGIN PASSWORD 'slice-Example_pw1'`);
        expect(sqlOf(steps[1]!.argv)).toBe('CREATE DATABASE "ws_example_a" OWNER "ws_example_a"');
        expect(stepSucceeded(steps[1]!, { stdout: 'ERROR:  database "ws_example_a" already exists', exitCode: 1 })).toBe(true);
        // The control: any OTHER failure of the same step is a failure.
        expect(stepSucceeded(steps[1]!, { stdout: 'ERROR:  permission denied to create database', exitCode: 1 })).toBe(false);
    });

    it('THE isolation line: CONNECT on the workspace database is revoked from PUBLIC (Postgres grants it to everyone by default)', () => {
        expect(sqlOf(steps[2]!.argv)).toContain('REVOKE CONNECT ON DATABASE "ws_example_a" FROM PUBLIC');
    });
});

describe('mysql / mariadb: a schema-scoped grant, never ON *.*', () => {
    it('mysql uses `mysql`, mariadb uses `mariadb` (MariaDB 11 ships no `mysql` client); both converge with IF NOT EXISTS', () => {
        const my = provisionSteps('mysql', { user: 'root', password: ADMIN.password }, SLICE);
        const maria = provisionSteps('mariadb', { user: 'root', password: ADMIN.password }, SLICE);
        expect(my[0]!.argv[0]).toBe('mysql');
        expect(maria[0]!.argv[0]).toBe('mariadb');
        for (const steps of [my, maria]) {
            const sql = sqlOf(steps[0]!.argv);
            expect(sql).toContain('CREATE DATABASE IF NOT EXISTS `ws_example_a`');
            expect(sql).toContain("CREATE USER IF NOT EXISTS 'ws_example_a'@'%'");
            expect(sql).toContain("GRANT ALL PRIVILEGES ON `ws_example_a`.* TO 'ws_example_a'@'%'");
            expect(sql).not.toContain('*.*');
        }
    });
});

describe('redis: an ACL user pinned to its own prefix, then its own credential proven', () => {
    const steps = provisionSteps('redis', { user: 'default', password: ADMIN.password }, SLICE);

    it('ACL SETUSER from `reset`, the prefix as key AND channel pattern, the deny-list last — then a PING as the workspace user', () => {
        expect(steps.map((s) => s.label)).toEqual(['acl user', 'workspace credential']);
        expect(steps[0]!.argv).toEqual(['redis-cli', '-h', '127.0.0.1', '-a', ADMIN.password, '--no-auth-warning', 'ACL', 'SETUSER', 'ws_example_a', 'reset', ...redisUserAclRule('ws_example_a', SLICE.password)]);
        expect(redisUserAclRule('ws_example_a', SLICE.password)).toEqual(['on', '>slice-Example_pw1', '~ws_example_a:*', '&ws_example_a:*', '+@all', ...REDIS_DENIED]);
        expect(REDIS_DENIED).toEqual(expect.arrayContaining(['-flushall', '-flushdb', '-swapdb', '-function', '-config', '-acl']));
        expect(steps[1]!.argv).toEqual(['redis-cli', '-h', '127.0.0.1', '--user', 'ws_example_a', '--pass', SLICE.password, '--no-auth-warning', 'PING']);
    });

    it('redis-cli exits 0 on an error reply, so success is the ANSWER: OK / PONG — an error printed with exit 0 is a failure', () => {
        expect(stepSucceeded(steps[0]!, { stdout: 'OK\n', exitCode: 0 })).toBe(true);
        expect(stepSucceeded(steps[0]!, { stdout: 'LOADING Redis is loading the dataset in memory\n', exitCode: 0 })).toBe(false);
        expect(stepSucceeded(steps[1]!, { stdout: 'PONG\n', exitCode: 0 })).toBe(true);
        expect(stepSucceeded(steps[1]!, { stdout: 'WRONGPASS invalid username-password pair\n', exitCode: 0 })).toBe(false);
    });
});

describe('readiness is the engine’s own client over TCP', () => {
    it('pg_isready / mysqladmin / mariadb-admin / redis-cli PING — redis counts only on PONG', () => {
        expect(readinessProbe('postgres', ADMIN).argv).toEqual(['pg_isready', '-h', '127.0.0.1', '-p', '5432', '-U', 'genie']);
        expect(readinessProbe('mysql', { user: 'root', password: ADMIN.password }).argv[0]).toBe('mysqladmin');
        expect(readinessProbe('mariadb', { user: 'root', password: ADMIN.password }).argv[0]).toBe('mariadb-admin');
        const redis = readinessProbe('redis', { user: 'default', password: ADMIN.password });
        expect(stepSucceeded(redis, { stdout: 'PONG\n', exitCode: 0 })).toBe(true);
        expect(stepSucceeded(redis, { stdout: 'Could not connect to Redis at 127.0.0.1:6379: Connection refused\n', exitCode: 0 })).toBe(false);
    });
});

describe('nothing that is not a derived name or a generated password reaches a command line', () => {
    it('an identifier with a quote, or a password with one, is REFUSED — counted against the same call with clean values (the control)', () => {
        const attempts = [
            () => provisionSteps('postgres', ADMIN, { identifier: `ws_x"; DROP DATABASE ws_y; --`, password: SLICE.password }),
            () => provisionSteps('postgres', ADMIN, { identifier: SLICE.identifier, password: `pw'; DROP ROLE genie; --` }),
            () => provisionSteps('mysql', { user: 'root', password: 'short' }, SLICE),
            () => provisionSteps('redis', { user: 'default', password: ADMIN.password }, { identifier: 'WS_UPPER', password: SLICE.password }),
        ];
        let refused = 0;
        for (const a of attempts) { try { a(); } catch { refused++; } }
        expect(refused).toBe(attempts.length);
        expect(() => provisionSteps('postgres', ADMIN, SLICE)).not.toThrow();
    });

    it('an engine without slices (mongo) is refused rather than given an invented command', () => {
        expect(() => provisionSteps('mongo', ADMIN, SLICE)).toThrow(/not carved/);
    });
});
