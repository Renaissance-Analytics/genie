import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NO PROCESS IS CREATED ON ELECTRON MAIN'S THREAD (genie#1397). Windows creates a process synchronously on the calling
 * thread, and on the owner's machine that held main 600 s in one session (the Docker CLI) and 20 s more (supervised
 * ptys). Every `execFileRunner` call and every supervised pty is made by the spawn host (main/spawn-host*.ts).
 *
 * This guard holds the line. A main-process module may import `node:child_process` only if it is:
 *  - the spawn host's own implementation (`spawn-exec.ts`: what the child runs; in main only as the logged fallback
 *    when the child cannot start), or the client that forks the child (`spawn-host-client.ts`: one spawn, at boot);
 *  - the launcher of the agent host (`engine-launch.ts`, the host split #1387: one DETACHED spawn of genie-host at boot,
 *    again only when the host was lost). It cannot go through the spawn host: that child ends every process it made
 *    when the window ends, and genie-host must outlive the window;
 *  - on the KNOWN list below: modules that still spawn on main, each with its reason and owner. The list may only
 *    SHRINK. A new module that spawns goes through `execFileRunner` (or the spawn host) instead.
 *
 * `main.ts` and `toolchain-runner.ts` — Electron main itself and the runner every Docker call goes through — are on
 * neither list, on purpose.
 */

// `spawn-relay.ts` runs in genie-host, never in Electron main: it forks the spawn host's children there (the host split,
// P2.1), which is what takes process creation out of the window entirely.
const SPAWN_HOST = new Set(['src/main/spawn-exec.ts', 'src/main/spawn-host-client.ts', 'src/main/engine-launch.ts', 'src/main/spawn-relay.ts']);

/** Still spawning on main, by name. Remove a line when its module moves; never add one. */
const KNOWN: Readonly<Record<string, string>> = {
    'src/core/process-tree.ts': 'agent spawn tracking and process trees: the agent engine, moving to genie-host (#1387 P1)',
    'src/main/prism-supervisor.ts': "the agents' prism-acp supervisor build: the agent engine (#1387 P1)",
    'src/main/private-credentials.ts': "agents' private credential helper: the agent engine (#1387 P1/P3)",
    'src/main/leftover-sweep.ts': 'boot-time leftover provider sweep (asynchronous listing since #1390)',
    'src/main/process-list.ts': 'the OS process table, read off the loop since #1390',
    'src/main/git-ports.ts': 'repo panel git calls (files host, #1387 P2)',
    'src/main/repo-git.ts': 'repo panel git calls (files host, #1387 P2)',
    'src/main/service-exec.ts': "a person's or an agent's `services exec` command, streamed (#1387 P5)",
    'src/main/plugin-runner.ts': 'plugin processes (#1387 P3)',
    'src/main/tailscale-cli.ts': 'Tailscale install/up, on a person\'s click (#1387 P5)',
    'src/main/remote-firewall.ts': 'the Windows firewall rule, elevated, on a person\'s click',
    'src/main/linux-password-store.ts': 'Linux keyring reads (#1387 P3, keychain in the host)',
};

const IMPORT = /(?:from\s+|require\()\s*['"](?:node:)?child_process['"]/;

function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name).replaceAll('\\', '/')] : []));
}

it('the Windows helper is never started on Electron main, and spawns nothing of its own', () => {
    expect(readFileSync('src/main/windows-helper.ts', 'utf8')).not.toMatch(/node:child_process/);
    expect(readFileSync('src/main/private-credentials.ts', 'utf8')).toMatch(/\.type === 'browser' \? null : windowsHelper\(\)/);
});

describe('no process is created on Electron main (genie#1397)', () => {
    const spawning = [...files('src/main'), ...files('src/core')].filter((f) => IMPORT.test(readFileSync(f, 'utf8')));

    it('only the spawn host and the KNOWN list import node:child_process', () => {
        const unexpected = spawning.filter((f) => !SPAWN_HOST.has(f) && !(f in KNOWN));
        expect(unexpected, 'spawn through execFileRunner or the spawn host instead').toEqual([]);
    });

    it('Electron main itself and the runner every Docker call goes through spawn nothing', () => {
        expect(spawning).not.toContain('src/main/main.ts');
        expect(spawning).not.toContain('src/main/toolchain-runner.ts');
    });

    it('the KNOWN list only shrinks: every entry still spawns (a moved module is taken off it)', () => {
        expect(Object.keys(KNOWN).filter((f) => !spawning.includes(f))).toEqual([]);
    });

    it('CONTROL: the scan finds a child_process import where one is (the spawn host\'s own exec)', () => {
        expect(spawning).toContain('src/main/spawn-exec.ts');
    });

    it('main.ts routes execFileRunner through the spawn host and gives the supervisor its ptys', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/routeExecThroughSpawnHost\(/);
        expect(main).toMatch(/processPty:\s*spawnHost/);
    });
});
