import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComposedServices, composeServices } from '../src/main/compose.js';
import { envFileSites } from '../src/main/dotenv-sync.js';
import { gitMayRun } from '../src/main/git-read-policy.js';
import { gitTreeStatus } from '../src/main/git-ports.js';
import type { SiteInfo } from '../src/main/site-manager.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { composeTracker } from './support/compose-tracker.js';

/** The workspace verdict through the real composition: the real record, the real git. Invented names; every "nothing ran" has a control where it ran. */
const pty: PtyPort = {
    open: () => ({ id: 't', pid: 1, shell: 'sh', scrollback: '' }),
    write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
};
const composed = composeTracker();
let dir: string;
let repo: string;
let mark: string;
let services: ComposedServices;
let workspaces: Array<{ id: string; path: string }> = [];
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

async function launch(): Promise<void> {
    services = await composed.compose({
        userData: join(dir, 'home'), pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, workspaces: () => workspaces,
    } as Parameters<typeof composeServices>[0]);
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trust-wiring-'));
    repo = join(dir, 'acme');
    mark = join(dir, 'mark.txt');
    mkdirSync(repo);
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    const tool = join(dir, 'tool.sh');
    writeFileSync(tool, `#!/bin/sh\necho ran > '${mark.replace(/\\/g, '/')}'\nexit 0\n`);
    chmodSync(tool, 0o755);
    git('config', 'core.fsmonitor', tool.replace(/\\/g, '/'));
    workspaces = [];
});
afterEach(async () => {
    await composed.shutdownAll();
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('a workspace added after the upgrade, with a git key that could run something', () => {
    beforeEach(async () => {
        await launch();
        await services.shutdown();
        workspaces = [{ id: 'acme', path: repo }];
        await launch();
    });

    it('is untrusted, names the key, and no git runs in it', async () => {
        const view = await services.workspaceTrust.refresh('acme');
        expect(view).toMatchObject({ trusted: false });
        expect(view?.list.gitKeys.map((e) => e.key)).toEqual(['core.fsmonitor']);
        expect(await gitTreeStatus(repo)).toEqual({});
        expect(existsSync(mark)).toBe(false);
    });

    it('CONTROL: the person trusts it, and git runs as git does, on this launch and the next', async () => {
        await services.workspaceTrust.trust('acme');
        await gitTreeStatus(repo);
        expect(existsSync(mark)).toBe(true);
        rmSync(mark, { force: true });
        await services.shutdown();
        await launch();
        await services.workspaceTrust.refresh('acme');
        await gitTreeStatus(repo);
        expect(existsSync(mark)).toBe(true);
    });

    it('the key changes after that: it asks again, and git stops', async () => {
        await services.workspaceTrust.trust('acme');
        git('config', 'core.fsmonitor', `${join(dir, 'tool.sh').replace(/\\/g, '/')} --other`);
        expect(await services.workspaceTrust.refresh('acme')).toMatchObject({ trusted: false, changed: true });
        expect(await gitMayRun(repo)).toBe(false);
    });
});

describe('a workspace already here at the upgrade', () => {
    it('stays trusted: git runs in it, as it did', async () => {
        workspaces = [{ id: 'acme', path: repo }];
        await launch();
        expect(await services.workspaceTrust.refresh('acme')).toMatchObject({ trusted: true });
        await gitTreeStatus(repo);
        expect(existsSync(mark)).toBe(true);
    });
});

describe('after Genie closes', () => {
    it('the check is gone with it', async () => {
        workspaces = [];
        await launch();
        await services.shutdown();
        expect(await gitMayRun(repo)).toBe(true);
    });
});

describe('the env files', () => {
    it('leave out a site waiting for its first start: nothing is written, and git is not asked, for a site that has not been let run', () => {
        const site = (over: Partial<SiteInfo>) => ({ id: 's', firstStart: undefined, ...over }) as SiteInfo;
        const waiting = site({ id: 'waiting', firstStart: { runs: 'x', folder: '.', changed: false } });
        const running = site({ id: 'running' });
        expect(envFileSites([waiting, running]).map((s) => s.id)).toEqual(['running']);
        // And it is what the composition gives the env files, which the row above cannot see.
        expect(readFileSync('src/main/compose.ts', 'utf8')).toMatch(/sites: \(\) => envFileSites\(sites\.list\(\)\)/);
    });
});
