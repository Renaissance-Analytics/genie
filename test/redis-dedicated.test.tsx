import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { serviceFormDefaults } from '../src/core/forms.js';
import { AddServiceForm } from '../src/renderer/components/AddForms.js';
import { containerPlan, SERVICE_CATALOG } from '../src/core/services.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import { ServiceDriver } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * REDIS IS ALWAYS ITS OWN, AND KEEPS ITS DATA THROUGH A CRASH (hosting fixes 3.2; the owner's D2, 2026-10-20: "Redis
 * always its own" — Genie 1's measured rule).
 *
 * Measured on omarchy-test (redis:7-alpine, 2026-10-21) before this was written:
 * - a shared Redis's workspace users are ACL users held in memory: gone when Docker restarts it (WRONGPASS for every
 *   workspace). A dedicated one's only credential is `--requirepass`, on its command line: it survives.
 * - launched as Genie launched it, a key written and then the container KILLED (a crash, no save) came back empty;
 *   with `--appendonly yes` it came back. A graceful `docker restart` kept it either way (Redis saves on SIGTERM).
 * - both ways, `PING` without the password after the crash answered `NOAUTH Authentication required.`, and FLUSHDB
 *   (Laravel's `cache:clear`) answered OK for the dedicated Redis's own user.
 */

describe('Redis is always dedicated', () => {
    it('the catalog says so', () => {
        expect(SERVICE_CATALOG.find((e) => e.engine === 'redis')?.sharing).toBe('dedicated-only');
    });

    it('a shared Redis is refused in words; a dedicated one is added (positive control)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'genie2-redis-'));
        try {
            const run: DockerRunner = async (args) => (args[0] === 'container' && args[1] === 'inspect' ? { stdout: '', exitCode: 1 } : { stdout: '[{}]', exitCode: 0 });
            const registry = await ServiceRegistry.open(dir, new ServiceDriver(run), { allocatePort: () => 63790, randomPassword: () => 'pw-generated' });
            const shared = await registry.add({ engine: 'redis', major: '7', scope: { kind: 'shared' }, consent: true }).then(() => null, (e: Error) => e.message);
            expect(shared).toMatch(/redis is always dedicated to one workspace/);
            const dedicated = await registry.add({ engine: 'redis', major: '7', scope: { kind: 'dedicated', workspaceId: 'tynn' }, consent: true });
            expect(dedicated.kind).toBe('added');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('a dedicated Redis keeps its data through a crash, and still needs its password', () => {
    const plan = containerPlan({ engine: 'redis', major: '7', scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPort: 63790, credentials: { password: 'pw-generated' } });

    it('launched append-only', () => {
        expect(plan.command).toEqual(['redis-server', '--requirepass', 'pw-generated', '--appendonly', 'yes']);
    });

    it('its data is in its volume, where the append-only file is written (/data)', () => {
        expect(plan.volume).not.toBeNull();
    });
});

describe('the Add engine form does not offer what would be refused', () => {
    const form = (engine: string) => renderToStaticMarkup(<AddServiceForm defaults={{ ...serviceFormDefaults({ workspaceId: 'tynn' }), engine, scope: 'shared' }} problems={[]} consent={null} onSubmit={() => {}} onCancel={() => {}} />);
    const sharedRadio = (html: string) => /<input[^>]*value="shared"[^>]*>/.exec(html)?.[0] ?? '';

    it('Redis: "Shared" is disabled and the form says why; "Dedicated" is the one checked', () => {
        const html = form('redis');
        expect(sharedRadio(html)).toMatch(/disabled=""/);
        expect(sharedRadio(html)).not.toMatch(/checked=""/);
        expect(/<input[^>]*value="dedicated"[^>]*>/.exec(html)?.[0]).toMatch(/checked=""/);
        expect(html).toContain('redis is always its own: its workspace users would be held only in its memory');
    });

    it('CONTROL: Postgres keeps both choices, and the shared one asked for is checked', () => {
        const html = form('postgres');
        expect(sharedRadio(html)).not.toMatch(/disabled=""/);
        expect(sharedRadio(html)).toMatch(/checked=""/);
        expect(html).not.toContain('data-dedicated-only');
    });
});
