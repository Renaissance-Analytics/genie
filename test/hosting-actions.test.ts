import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction } from '../src/main/feature-ipc.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * ONE SET OF SERVICE AND SITE CALLS. The Services and Hosting tabs (feature-ipc.ts) and the agents' `services` / `sites`
 * tools (mcp-tools-hosting.ts) both go through hosting-actions.ts, so an agent's add is validated, wired and recorded
 * exactly as the person's is. The tabs' own behaviour is pinned, unchanged, by feature-ipc-services.test.ts and the
 * Hosting tests; this file pins that neither side keeps a private copy of the calls, and that the registry tells
 * listeners when the PERSON acts too (main pushes the snapshot on it).
 */

// Comment lines dropped by LINE, CRLF-safe: a guard that matched a comment would pass on prose.
const code = (file: string) => readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/** The calls that must live in hosting-actions.ts only. */
const DIRECT = [/\.engines\.add\(/, /\.engines\.setActive\(/, /\.envelopeSites\.(create|start|stop|remove)\(/, /\.(startEngine|stopEngine|removeEngine)\(/, /validateSiteForm\(/, /validateServiceForm\(/];
/**
 * The one exception, by design: the agent tool runs the SAME `validateServiceForm` once more BEFORE it asks the person,
 * so a request Genie would refuse is never put to them. The add itself still goes through `createService`.
 */
const ALLOWED: Record<string, readonly RegExp[]> = { 'src/main/mcp-tools-hosting.ts': [/validateServiceForm\(/] };

describe('the shared actions', () => {
    it('hosting-actions.ts holds every service and site call — counted, the control for the guards below', () => {
        expect(existsSync('src/main/hosting-actions.ts')).toBe(true);
        const shared = code('src/main/hosting-actions.ts');
        expect(DIRECT.filter((re) => re.test(shared))).toHaveLength(DIRECT.length);
    });

    for (const file of ['src/main/feature-ipc.ts', 'src/main/mcp-tools-hosting.ts']) {
        it(`${file} makes them through hosting-actions.ts and keeps no copy of its own — the offending calls named`, () => {
            expect(existsSync(file)).toBe(true);
            const source = code(file);
            expect(source).toMatch(/from '\.\/hosting-actions\.js'/);
            const allowed = ALLOWED[file] ?? [];
            expect(DIRECT.filter((re) => re.test(source) && !allowed.some((a) => a.source === re.source)).map((re) => re.source)).toEqual([]);
        });
    }
});

describe('the engine registry tells its listeners', () => {
    const pty: PtyPort = {
        open: () => ({ id: 'term_1', pid: 1, shell: 'sh', scrollback: '' }),
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
    const docker: DockerRunner = async (args) => {
        if (args[0] === 'image' || (args[0] === 'container' && args[1] === 'inspect')) return { stdout: '', exitCode: 1 };
        return { stdout: '', exitCode: 0 };
    };
    let dir: string;
    let services: ComposedServices;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-hosting-actions-'));
        await mkdir(join(dir, 'example'), { recursive: true });
        await writeFile(join(dir, 'example', 'project.json'), '{ "name": "example", "repos": [] }\n', 'utf8');
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker, portFree: async () => true, workspaces: () => [{ id: 'example', path: join(dir, 'example') }] });
    });
    afterEach(async () => {
        await services.shutdown();
        await rm(dir, { recursive: true, force: true });
    });

    it('when the PERSON adds, stops, starts, makes active and removes — counted, and nothing after an unsubscribe', async () => {
        let changes = 0;
        const off = services.engines.onChange(() => { changes += 1; });
        const form = { workspaceId: 'example', engine: 'postgres', major: '17', scope: 'dedicated' as const };
        // Control: a submit that asks for consent creates nothing, and changes nothing.
        await handleFeatureAction(services, { kind: 'services.create', form, consent: false });
        expect(changes).toBe(0);
        await handleFeatureAction(services, { kind: 'services.create', form, consent: true });
        expect(changes).toBe(1);
        const id = services.engines.list()[0]!.id;
        await handleFeatureAction(services, { kind: 'services.stop', serviceId: id });
        await handleFeatureAction(services, { kind: 'services.start', serviceId: id });
        await handleFeatureAction(services, { kind: 'services.setActive', workspaceId: 'example', engine: 'postgres', version: '17' });
        expect(changes).toBe(4);
        off();
        await handleFeatureAction(services, { kind: 'services.remove', serviceId: id, deleteData: false });
        expect(changes).toBe(4);
        expect(services.engines.list()).toEqual([]);
    });
});
