import { describe, expect, it } from 'vitest';
import { createDatabaseSteps, databaseExistsStep, databaseNameProblem } from '../src/core/service-provision.js';

/**
 * The pure half of `services createDatabase` (Tynn #403): the name rule and the superuser's commands. The steps assert
 * their own inputs, as every other provisioning step does, so a name that skipped the tool's check fails loudly here.
 */

const admin = { user: 'genie', password: 'generated-admin-pw' };
const sql = (argv: readonly string[]) => argv[argv.length - 1]!;

describe('a database name a workspace may ask for', () => {
    it('is ^[a-z_][a-z0-9_]{0,62}$, and not Genie’s ws_ nor Postgres’s pg_ — each refusal in words', () => {
        for (const ok of ['app', '_app', 'app_testing_2', `a${'b'.repeat(62)}`]) expect(databaseNameProblem(ok)).toBeNull();
        for (const bad of ['', 'App', '1app', 'app-x', 'app x', 'app"x', "app'x", `a${'b'.repeat(63)}`]) expect(databaseNameProblem(bad)).toMatch(/name/);
        expect(databaseNameProblem('ws_other')).toMatch(/ws_/);
        expect(databaseNameProblem('pg_app')).toMatch(/pg_/);
    });
});

describe('the steps, as the engine’s superuser', () => {
    it('ask whether it exists, by name, in the `postgres` database', () => {
        const step = databaseExistsStep(admin, 'app_testing');
        expect(step.argv[1]).toBe('postgresql://genie:generated-admin-pw@127.0.0.1:5432/postgres');
        expect(sql(step.argv)).toBe("SELECT 1 FROM pg_database WHERE datname = 'app_testing'");
    });

    it('create it OWNED by the workspace role, revoke CONNECT from PUBLIC, then the variant’s extensions IN it', () => {
        const steps = createDatabaseSteps(admin, 'app_testing', 'ws_example', ['vector']);
        expect(steps.map((s) => sql(s.argv))).toEqual([
            'CREATE DATABASE "app_testing" OWNER "ws_example"',
            'REVOKE CONNECT ON DATABASE "app_testing" FROM PUBLIC; GRANT ALL PRIVILEGES ON DATABASE "app_testing" TO "ws_example";',
            'CREATE EXTENSION IF NOT EXISTS "vector"',
        ]);
        // "Already exists" is NOT tolerated here: a database a workspace did not make is never handed to it.
        expect(steps[0]!.tolerate).toBeUndefined();
        expect(steps[2]!.argv[1]).toBe('postgresql://genie:generated-admin-pw@127.0.0.1:5432/app_testing');
        // Control: a stock Postgres creates no extension.
        expect(createDatabaseSteps(admin, 'app_testing', 'ws_example')).toHaveLength(2);
    });

    it('refuse anything that is not a valid name, a derived role or a generated password', () => {
        expect(() => createDatabaseSteps(admin, 'app"; DROP', 'ws_example')).toThrow(/name/);
        expect(() => createDatabaseSteps(admin, 'ws_other', 'ws_example')).toThrow(/ws_/);
        expect(() => createDatabaseSteps(admin, 'app', 'Bad Role')).toThrow(/identifier/);
        expect(() => createDatabaseSteps({ user: 'genie', password: "x'" }, 'app', 'ws_example')).toThrow(/password/);
        expect(() => databaseExistsStep(admin, "x' OR '1'='1")).toThrow(/name/);
    });
});
