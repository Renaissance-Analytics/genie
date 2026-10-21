import { describe, expect, it } from 'vitest';
import { SERVICE_CATALOG } from '../src/core/services.js';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';

/**
 * POSTGRES 18 KEEPS ITS DATA WHERE ITS IMAGE PUTS IT (hosting fixes 3.3). Measured on omarchy-test, 2026-10-21 — a row
 * written, the container removed and made again on the same volume:
 *
 * | image                      | PGDATA                         | VOLUME                   | on /var/lib/postgresql/data | on /var/lib/postgresql |
 * | postgres:17, pgvector pg17 | /var/lib/postgresql/data       | /var/lib/postgresql/data | row kept                    | row LOST               |
 * | postgres:18, pgvector pg18 | /var/lib/postgresql/18/docker  | /var/lib/postgresql      | does NOT START              | row kept               |
 *
 * So the data volume goes where each major's image declares it: 17 and before unchanged, 18 on /var/lib/postgresql.
 */
function created(major: string, variant?: string) {
    const calls: (readonly string[])[] = [];
    const run: DockerRunner = async (args) => {
        calls.push(args);
        if (args[0] === 'container' && args[1] === 'inspect') return { stdout: '', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
    };
    return { run, mount: async () => {
        await new ServiceDriver(run).create({ engine: 'postgres', major, scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPort: 54321, credentials: { user: 'genie', password: 'pw', database: 'tynn' }, ...(variant ? { variant } : {}) });
        const create = calls.find((c) => c[0] === 'create')!;
        return create[create.indexOf('-v') + 1]!.split(':').slice(1).join(':');
    } };
}

describe('the data volume is mounted where each major keeps its data', () => {
    it('Postgres 18 (and pgvector pg18): /var/lib/postgresql — where its image declares its VOLUME', async () => {
        expect(await created('18').mount()).toBe('/var/lib/postgresql');
        expect(await created('18', 'pgvector').mount()).toBe('/var/lib/postgresql');
    });

    it('CONTROL: 14–17 unchanged on /var/lib/postgresql/data — moving them would lose every row (measured)', async () => {
        for (const major of ['14', '15', '16', '17']) expect(await created(major).mount()).toBe('/var/lib/postgresql/data');
        expect(await created('17', 'pgvector').mount()).toBe('/var/lib/postgresql/data');
    });

    it('Postgres 18 is offered', () => {
        expect(SERVICE_CATALOG.find((e) => e.engine === 'postgres')?.majors).toContain('18');
    });
});
