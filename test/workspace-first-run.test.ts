import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureInProcessBackend, inProcessBackend, resolveDefaultShell } from '@particle-academy/fancy-term-host';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvelopeSites, nodeEnvelopeFs } from '../src/main/envelope-sites-host.js';
import { fancyTermPort } from '../src/main/fancy-term-port.js';
import { gitFileStatus, gitLogSince, gitShowHead, gitTreeStatus } from '../src/main/git-ports.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { repoDiff, repoStatus } from '../src/main/repo-git.js';
import { SiteManager } from '../src/main/site-manager.js';

/** What a workspace's own files start on their own the first time Genie sees them: measured through the real paths, on each OS. */
const until = async (done: () => boolean, ms: number) => { const end = Date.now() + ms; while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); };

let root: string;
let mark: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'first-run-')); mark = join(root, 'mark.txt'); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a site declared in a workspace', () => {
    it('is not started the first time Genie sees it', async () => {
        const settings = { get: (key: string) => (key === 'track_cwd' ? 'off' : key === 'detached_terminals' ? 'off' : undefined) };
        configureInProcessBackend({ settings, snapshots: { writeSnapshot: () => null, readSnapshot: () => null, deleteSnapshot: () => {}, encrypting: () => false } } as never);
        const pty = fancyTermPort(inProcessBackend(), { defaultShell: () => resolveDefaultShell(settings) });
        const workspace = join(root, 'acme');
        const repo = join(workspace, 'repos', 'shop');
        mkdirSync(repo, { recursive: true });
        writeFileSync(join(repo, 'serve.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(mark)}, 'ran');\n`);
        writeFileSync(join(workspace, 'project.json'), JSON.stringify({
            name: 'Acme',
            repos: [{ name: 'shop', slug: 'shop', path: 'repos/shop' }],
            sites: { k1: { repo: 'shop', runMode: 'host', kind: 'http', enabled: true, name: 'shop', genName: 'shop.gen', hostPort: 4999, command: ['node', 'serve.cjs'] } },
        }));
        let port = 41000;
        const supervisor = new ProcessSupervisor(pty, { now: () => Date.now(), schedule: () => () => {} });
        const sites = new SiteManager({ supervisor, allocatePort: () => ++port, caddyBin: process.execPath, configDir: join(root, 'cfg'), writeConfig: () => {}, phpWorkers: 1 } as never);
        const logs: string[] = [];
        const envelope = new EnvelopeSites(sites, { fs: nodeEnvelopeFs(), runState: { load: async () => [], save: async () => {} }, envFor: () => ({}), log: (l: string) => logs.push(l) } as never);
        await envelope.sync([{ id: 'acme', path: workspace }]);
        await until(() => existsSync(mark), 8_000);
        console.log(`### first-run site-started-by-sync=${existsSync(mark)} sites=${JSON.stringify(sites.list()).slice(0, 300)} logs=${JSON.stringify(logs).slice(0, 300)}`);
        expect(existsSync(mark)).toBe(false);
        sites.list().forEach((s) => { try { sites.stop(s.id); } catch { /* gone */ } });
    }, 30_000);
});

describe("a folder's own git config", () => {
    let repo: string;
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const script = () => {
        const file = join(root, 'tool.sh');
        writeFileSync(file, `#!/bin/sh\necho ran > '${mark.replace(/\\/g, '/')}'\ncat\n`);
        chmodSync(file, 0o755);
        return file.replace(/\\/g, '/');
    };
    beforeEach(() => {
        repo = join(root, 'repo');
        mkdirSync(repo);
        git('init', '-q');
        writeFileSync(join(repo, 'a.txt'), 'one\n');
        git('add', '.');
        git('commit', '-q', '-m', 'one');
    });
    const row = async (name: string, work: () => Promise<unknown>) => {
        await work().catch(() => null);
        console.log(`### first-run git-config ${name} ran=${existsSync(mark)}`);
        expect(existsSync(mark)).toBe(false);
    };

    it('CONTROL: this git really runs it', () => {
        git('config', 'core.fsmonitor', script());
        git('status', '--porcelain');
        console.log(`### first-run git-config control-fsmonitor ran=${existsSync(mark)}`);
        expect(existsSync(mark)).toBe(true);
    });

    it('core.fsmonitor: gitTreeStatus', async () => { git('config', 'core.fsmonitor', script()); await row('fsmonitor-gitTreeStatus', () => gitTreeStatus(repo)); });
    it('core.fsmonitor: gitFileStatus', async () => { git('config', 'core.fsmonitor', script()); await row('fsmonitor-gitFileStatus', () => gitFileStatus(repo, 'a.txt')); });
    it('core.fsmonitor: repoStatus', async () => { git('config', 'core.fsmonitor', script()); await row('fsmonitor-repoStatus', () => repoStatus(repo, '.')); });
    it('core.fsmonitor: gitLogSince', async () => { git('config', 'core.fsmonitor', script()); await row('fsmonitor-gitLogSince', () => gitLogSince(repo, 0)); });
    it('core.fsmonitor: gitShowHead', async () => { git('config', 'core.fsmonitor', script()); await row('fsmonitor-gitShowHead', () => gitShowHead(repo, 'a.txt')); });
    it('diff.external: repoDiff', async () => { git('config', 'diff.external', script()); writeFileSync(join(repo, 'a.txt'), 'two\n'); await row('diff-external-repoDiff', () => repoDiff(repo, '.', 'a.txt', false)); });
    it('a filter: repoStatus on a changed file', async () => {
        writeFileSync(join(repo, '.gitattributes'), '*.txt filter=x\n');
        git('config', 'filter.x.clean', script());
        writeFileSync(join(repo, 'a.txt'), 'two\n');
        await row('filter-repoStatus', () => repoStatus(repo, '.'));
    });
    it('a filter: gitTreeStatus on a changed file', async () => {
        writeFileSync(join(repo, '.gitattributes'), '*.txt filter=x\n');
        git('config', 'filter.x.clean', script());
        writeFileSync(join(repo, 'a.txt'), 'two\n');
        await row('filter-gitTreeStatus', () => gitTreeStatus(repo));
    });
    it('a textconv: repoDiff', async () => {
        writeFileSync(join(repo, '.gitattributes'), '*.txt diff=x\n');
        git('config', 'diff.x.textconv', script());
        writeFileSync(join(repo, 'a.txt'), 'two\n');
        await row('textconv-repoDiff', () => repoDiff(repo, '.', 'a.txt', false));
    });
});
