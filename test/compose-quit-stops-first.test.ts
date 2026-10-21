import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { handleFeatureAction, type FeatureState } from '../src/main/feature-ipc.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * QUIT STOPS WHAT GENIE SUPERVISES FIRST (hosting fixes 2.2). Shutdown waited for the `.env` pass in flight
 * (`await envFiles.close()`, which waits on git) BEFORE it stopped a single supervised process — so a slow or stuck git
 * left every site's dev server, worker and the front door running for as long as it took, and a quit that did not wait
 * that long (Electron's does not) left them running for good.
 *
 * Here git's answer is held: the site's dev server must be killed while shutdown is still waiting, and the shutdown
 * still waits for the `.env` pass after (compose-env-drain.test.ts keeps that half).
 */

const opened: string[] = [];
const killed: string[] = [];
let nextPty = 0;
const pty: PtyPort = {
    open: (o) => { const id = `term_${++nextPty}`; opened.push(id); return { id, pid: 1000 + nextPty, shell: o.command ?? 'sh', scrollback: '' }; },
    write: () => true, resize: () => true,
    kill: (id) => { killed.push(id); return true; },
    scrollback: () => '',
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
    dir = await mkdtemp(join(tmpdir(), 'genie2-quit-stops-first-'));
    await mkdir(join(dir, 'example'), { recursive: true });
    await writeFile(join(dir, 'example', 'project.json'), `${JSON.stringify({ name: 'example', repos: [] }, null, 2)}\n`, 'utf8');
    opened.length = 0;
    killed.length = 0;
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

it('while the `.env` pass still waits on git, every supervised process is already stopped (counted against what ran)', async () => {
    // An engine for the workspace: what gives the site's change a `.env` pass to run (compose-env-drain.test.ts).
    await handleFeatureAction(services, { kind: 'services.create', form: { workspaceId: 'example', engine: 'postgres', major: '17', scope: 'dedicated' }, consent: true }, state);
    const site = { name: 'example', mode: 'proxy' as const, devServer: { stack: 'node' as const, command: 'npm run dev -- --port {port}' }, hostPort: null, root: null, spa: false };
    await handleFeatureAction(services, { kind: 'hosting.createSite', workspaceId: 'example', repoPath: join(dir, 'example'), form: site }, state);
    // Positive controls: the site's dev server runs in a pty, and its change started a pass now held on git.
    for (let i = 0; i < 200 && (asked === 0 || opened.length === 0); i++) await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(1);
    const running = [...opened];
    expect(running.length).toBeGreaterThan(0);
    expect(killed).toEqual([]);

    let down = false;
    const shutting = services.shutdown().then(() => { down = true; });
    await new Promise((r) => setTimeout(r, 50));
    // Still waiting on git — and nothing it supervises is left running meanwhile.
    expect(down).toBe(false);
    expect(running.filter((id) => !killed.includes(id))).toEqual([]);
    release();
    await shutting;
});
