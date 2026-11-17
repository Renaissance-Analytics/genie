import { describe, expect, it } from 'vitest';
import { readEnvelopeSites } from '../src/core/envelope-sites.js';
import { portableSites } from '../src/core/workspace-sites.js';
import { scanForMachineState } from '../src/core/workspace-save-guard.js';

/**
 * SITES SAVE PORTABLY (Tynn #756, PR4; the design, section 2: "Rewrite absolute paths in command[] to workspace-relative before
 * save; if a path cannot be made relative (outside the envelope) refuse the save with the reason"). A site runs in its repo's
 * folder, so a path is made relative to THAT folder; a port Genie handed out becomes the `{port}` placeholder; the stored key,
 * `hostPort` (a port the person declared for a server already running) and every other member stay as they are.
 *
 * The first fixture is this envelope's own `tynn-c5` entry (project.json, key 998de12a1f1278a9).
 */

const WORKSPACE = 'C:/_Projects/tynn.ai';
const C5_KEY = '998de12a1f1278a9';
const C5 = {
    repo: 'tynn-c5-proof', runMode: 'host', kind: 'http', enabled: true, name: 'tynn-c5', genName: 'tynn-c5.gen',
    command: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:/_Projects/tynn.ai/.ai/sandbox/genie-marketplace-c5/serve-proof.ps1', '-Port', '{port}'],
};
const TYNN = { repo: 'tynn', runMode: 'host', kind: 'http', enabled: true, name: 'tynn', genName: 'tynn.gen', stack: 'php', framework: 'laravel', hostServe: { mode: 'php', root: 'public' } };

const manifestWith = (sites: Record<string, unknown>, workspaceRepos: unknown[] = [{ name: 'tynn', path: 'repos/tynn' }, { name: 'app', path: 'repos/app' }]) => ({ name: 'Tynn', repos: workspaceRepos, sites });
const one = (entry: Record<string, unknown>, workspace = WORKSPACE) => portableSites(manifestWith({ k1: { repo: 'app', runMode: 'host', kind: 'http', enabled: true, name: 'app', ...entry } }), workspace);
const commandOf = (r: ReturnType<typeof portableSites>) => ((r.manifest.sites as Record<string, { command: string[] }>).k1!).command;

describe('absolute paths become relative to the folder the site runs in', () => {
    it("this envelope's tynn-c5 command: the script under .ai/sandbox is reached from its repo folder, the key and everything else kept", () => {
        const r = portableSites(manifestWith({ adfaa1cb572c9c36: TYNN, [C5_KEY]: C5 }), WORKSPACE);
        const site = (r.manifest.sites as Record<string, { command: string[] }>)[C5_KEY]!;
        expect(site.command).toEqual(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '../../.ai/sandbox/genie-marketplace-c5/serve-proof.ps1', '-Port', '{port}']);
        expect(r.rewrites).toEqual([{ path: `sites.${C5_KEY}.command[5]`, from: 'C:/_Projects/tynn.ai/.ai/sandbox/genie-marketplace-c5/serve-proof.ps1', to: '../../.ai/sandbox/genie-marketplace-c5/serve-proof.ps1' }]);
        expect(Object.keys(r.manifest.sites as object)).toEqual(['adfaa1cb572c9c36', C5_KEY]);
        expect(r.manifest.sites).toMatchObject({ [C5_KEY]: { name: 'tynn-c5', genName: 'tynn-c5.gen', repo: 'tynn-c5-proof' } });
    });

    it('after the rewrite the guard finds nothing in the tynn-c5 entry, and found it before', () => {
        const before = scanForMachineState({ sites: { [C5_KEY]: C5 } });
        expect(before.length).toBeGreaterThan(0);
        const r = portableSites(manifestWith({ [C5_KEY]: C5 }), WORKSPACE);
        expect(scanForMachineState({ sites: r.manifest.sites })).toEqual([]);
    });

    it('a site that runs in the workspace folder itself gets ./ in front, so it is not looked up on PATH', () => {
        const r = portableSites(manifestWith({ k1: { repo: '', name: 'app', command: ['/w/acme/scripts/dev.sh', '--port={port}'] } }), '/w/acme');
        expect(commandOf(r)).toEqual(['./scripts/dev.sh', '--port={port}']);
    });

    it('a path after a flag (--config=/abs) is rewritten in place', () => {
        expect(commandOf(one({ command: ['node', 'server.js', '--config=C:/_Projects/tynn.ai/repos/app/conf/dev.json', '--port={port}'] })).slice(2, 3)).toEqual(['--config=./conf/dev.json']);
    });

    it('a drive letter in another case and backslashes are the same place', () => {
        const r = one({ command: ['pwsh', '-File', 'c:\\_projects\\TYNN.ai\\repos\\app\\tools\\run.ps1', '--port={port}'] });
        expect(commandOf(r)[2]).toBe('./tools/run.ps1');
    });

    it('a path OUTSIDE the workspace is left alone, so the guard refuses it; the same command with a path inside is rewritten (the control)', () => {
        const outside = one({ command: ['node', 'D:/elsewhere/server.js', '--port={port}'] });
        expect(commandOf(outside)[1]).toBe('D:/elsewhere/server.js');
        expect(outside.rewrites).toEqual([]);
        expect(scanForMachineState({ sites: outside.manifest.sites }).map((v) => v.rule)).toEqual(['absolute-path']);
        const inside = one({ command: ['node', 'C:/_Projects/tynn.ai/repos/app/server.js', '--port={port}'] });
        expect(commandOf(inside)[1]).toBe('./server.js');
        expect(inside.rewrites).toHaveLength(1);
    });

    it('hostServe.root given as an absolute path inside the repo folder becomes the folder name', () => {
        const r = portableSites(manifestWith({ k1: { repo: 'app', name: 'app', hostServe: { mode: 'php', root: 'C:/_Projects/tynn.ai/repos/app/public' } } }), WORKSPACE);
        expect((r.manifest.sites as Record<string, { hostServe: { root: string } }>).k1!.hostServe.root).toBe('public');
    });
});

describe('ports become the placeholder', () => {
    const cmd = (...tokens: string[]) => commandOf(one({ command: tokens }));

    it('--port=N, --port N, -p N', () => {
        expect(cmd('npm', 'run', 'dev', '--', '--port=8000')).toEqual(['npm', 'run', 'dev', '--', '--port={port}']);
        expect(cmd('php', 'artisan', 'serve', '--port', '8000')).toEqual(['php', 'artisan', 'serve', '--port', '{port}']);
        expect(cmd('vite', '-p', '5173')).toEqual(['vite', '-p', '{port}']);
    });

    it('host:port keeps loopback; a wildcard bind is told loopback; :N alone too', () => {
        expect(cmd('python', 'manage.py', 'runserver', '127.0.0.1:8000')).toEqual(['python', 'manage.py', 'runserver', '127.0.0.1:{port}']);
        expect(cmd('python', 'manage.py', 'runserver', '0.0.0.0:8000')).toEqual(['python', 'manage.py', 'runserver', '127.0.0.1:{port}']);
        expect(cmd('serve', 'localhost:3000')).toEqual(['serve', 'localhost:{port}']);
        expect(cmd('serve', ':3000')).toEqual(['serve', '127.0.0.1:{port}']);
    });

    it('CONTROL: a placeholder, a non-number and a number that is not a port flag stay as they are', () => {
        expect(cmd('app', '--port={port}')).toEqual(['app', '--port={port}']);
        expect(cmd('app', '--port', 'auto')).toEqual(['app', '--port', 'auto']);
        expect(cmd('app', '--workers', '4', '--retries=3')).toEqual(['app', '--workers', '4', '--retries=3']);
    });

    it('every rewritten port is reported with its place', () => {
        const r = one({ command: ['php', 'artisan', 'serve', '--port=8000'] });
        expect(r.rewrites).toEqual([{ path: 'sites.k1.command[3]', from: '--port=8000', to: '--port={port}' }]);
    });
});

describe('what is not touched', () => {
    it('CONTROL: hostPort (a port the person declared for a server already running), the stored keys and unknown members stay', () => {
        const entry = { repo: 'app', name: 'app', hostPort: 3000, stack: 'node', futureMember: { keep: true } };
        const r = portableSites(manifestWith({ zz: entry, aa: entry }), WORKSPACE);
        expect(Object.keys(r.manifest.sites as object)).toEqual(['zz', 'aa']);
        expect(r.manifest.sites).toEqual({ zz: entry, aa: entry });
        expect(r.rewrites).toEqual([]);
    });

    it('CONTROL: a manifest with no sites is returned as it is', () => {
        const manifest = { name: 'Tynn', repos: [] };
        const r = portableSites(manifest, WORKSPACE);
        expect(r.manifest).toEqual(manifest);
        expect(r.rewrites).toEqual([]);
        expect(r.notes).toEqual([]);
    });

    it('rewriting twice changes nothing the second time', () => {
        const first = portableSites(manifestWith({ [C5_KEY]: C5 }), WORKSPACE);
        expect(first.rewrites.length).toBeGreaterThan(0);
        const second = portableSites(first.manifest, WORKSPACE);
        expect(second.manifest).toEqual(first.manifest);
        expect(second.rewrites).toEqual([]);
    });

    it('the input manifest is not changed', () => {
        const manifest = manifestWith({ [C5_KEY]: C5 });
        const before = JSON.stringify(manifest);
        expect(portableSites(manifest, WORKSPACE).rewrites.length).toBeGreaterThan(0);
        expect(JSON.stringify(manifest)).toBe(before);
    });
});

describe('a site whose folder a clone would not have', () => {
    it('is noted: its repo is not in repos[]', () => {
        const r = portableSites(manifestWith({ [C5_KEY]: C5 }), WORKSPACE);
        expect(r.notes).toContain('Site tynn-c5: its repo "tynn-c5-proof" is not in repos[], so a clone has no folder for it.');
    });

    it('CONTROL: a site whose repo is in repos[] has no such note', () => {
        const r = portableSites(manifestWith({ adfaa1cb572c9c36: TYNN }), WORKSPACE);
        expect(r.notes).toEqual([]);
    });
});

describe('a clone', () => {
    it('CONTROL: restores each site under its STORED key, whatever the clone’s workspace id is', () => {
        const saved = portableSites(manifestWith({ adfaa1cb572c9c36: TYNN, [C5_KEY]: C5 }), WORKSPACE).manifest;
        expect(readEnvelopeSites(saved).map((s) => s.key)).toEqual(['adfaa1cb572c9c36', C5_KEY]);
    });
});
