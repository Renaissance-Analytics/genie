import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * GENIE'S SHUTDOWN WAITS FOR THE `.env` PASS IN FLIGHT. Every engine or site change starts a pass that asks git
 * (`git check-ignore`, in the site repo) before writing. Shutdown used to return while that git was still running:
 * on Windows a process whose working directory is the repo keeps the folder from being removed, which is how this was
 * found (two Windows unit runs failed EBUSY removing their workspace), and a quit mid-pass could cut a write short.
 * Here git's answer is held until released — the real composition, real files, fake Docker.
 */

const pty: PtyPort = {
    open: (o) => ({ id: 'term_1', pid: 1, shell: o.command ?? 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
    onData: () => () => {}, onExit: () => () => {},
};

function fakeDocker(): DockerRunner {
    const images = new Set<string>();
    const containers = new Map<string, string>();
    return async (args) => {
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: images.has(args[2]!) ? '[{}]' : '', exitCode: images.has(args[2]!) ? 0 : 1 };
        if (cmd === 'pull') { images.add(args[1]!); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'stop') { containers.set(args[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
}

let dir: string;
let services: ComposedServices;
let release: () => void = () => {};
let asked = 0;
const state: FeatureState = { toolStatuses: null, knowledgeQuery: '' };

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-compose-env-drain-'));
    await mkdir(join(dir, 'example'), { recursive: true });
    await writeFile(join(dir, 'example', 'project.json'), `${JSON.stringify({ name: 'example', repos: [] }, null, 2)}\n`, 'utf8');
    asked = 0;
    const gate = new Promise<void>((r) => { release = r; });
    services = await composeServices({
        userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, docker: fakeDocker(), portFree: async () => true,
        workspaces: () => [{ id: 'example', path: join(dir, 'example') }],
        gitIgnored: async () => { asked++; await gate; return 'ignored'; },
    });
});

afterEach(async () => {
    release();
    await services.shutdown();
    await rm(dir, { recursive: true, force: true });
});

it('shutdown does not return while a `.env` pass waits on git; once git answers it does, and git is asked nothing more (counted)', async () => {
    await handleFeatureAction(services, { kind: 'services.create', form: { workspaceId: 'example', engine: 'postgres', major: '17', scope: 'dedicated' }, consent: true }, state);
    const site = { name: 'example', mode: 'proxy' as const, devServer: { stack: 'node' as const, command: 'npm run dev -- --port {port}' }, hostPort: null, root: null, spa: false };
    await handleFeatureAction(services, { kind: 'hosting.createSite', workspaceId: 'example', repoPath: join(dir, 'example'), form: site }, state);
    // Positive control: the site's change did start a pass that is now waiting on git.
    for (let i = 0; i < 200 && asked === 0; i++) await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(1);

    let down = false;
    const shutting = services.shutdown().then(() => { down = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(down).toBe(false);
    release();
    await shutting;
    expect(down).toBe(true);
    expect(asked).toBe(1);
});
