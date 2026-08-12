import { describe, expect, it } from 'vitest';
import {
    DEFAULT_TOOLCHAIN,
    detectToolchain,
    parseToolVersion,
    probeHostTool,
    TOOL_SPECS,
} from '../toolchain-detect';
import type { CommandResult, CommandRunner, StreamHandle } from '../container-runtime';

/**
 * The host-toolchain auto-install work (Tynn #240) begins here: before Genie can
 * install what a fresh machine is missing, it has to say — reviewably, and
 * without crashing — what IS there. This is the same contract `runtime-detect`
 * holds for Docker, generalised to git/node/npm/php/composer + the agent TUIs: a
 * missing tool is the ordinary first-run state, never an exception.
 *
 * Docker is the one tool where "installed" and "running" differ and need
 * OPPOSITE follow-up (start it vs install it), so its probe delegates to the
 * container-runtime detector and carries `running` through — a stopped Docker is
 * PRESENT (do not reinstall), just not usable yet.
 */

const OK = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: '' });
/** What the real runner returns for an executable that is not on PATH — it
 *  RESOLVES (see `seams.ts`), it does not reject. */
const MISSING: CommandResult = { code: null, stdout: '', stderr: 'spawn ENOENT' };
/** Docker CLI present, engine unreachable. */
const DAEMON_DOWN: CommandResult = {
    code: 1,
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
};

/** Realistic `--version` output per tool — the strings a probe must survive. */
const VERSION_OUTPUT: Record<string, string> = {
    git: 'git version 2.42.0\n',
    node: 'v20.11.0\n',
    npm: '10.2.4\n',
    php: 'PHP 8.3.2 (cli) (built: Jan 16 2024 10:22:36) (NTS)\n',
    composer: 'Composer version 2.6.5 2024-01-31 15:30:12\n',
    claude: '1.0.44 (Claude Code)\n',
    codex: 'codex-cli 0.5.0\n',
};

function runner(handle: (command: string, args: string[]) => CommandResult): CommandRunner {
    return {
        async run(command, args) {
            return handle(command, args);
        },
        stream(): StreamHandle {
            throw new Error('detection never streams');
        },
    };
}

/** `docker version --format {{.Server.Version}}` (engine) vs `docker --version` (CLI). */
const isServerProbe = (args: string[]) => args.includes('--format');

describe('parseToolVersion', () => {
    it('extracts the first dotted version from each tool\u2019s prose', () => {
        expect(parseToolVersion('git version 2.42.0')).toBe('2.42.0');
        expect(parseToolVersion('v20.11.0')).toBe('20.11.0');
        expect(parseToolVersion('10.2.4\n')).toBe('10.2.4');
        expect(parseToolVersion('PHP 8.3.2 (cli) (built: Jan 16 2024 10:22:36)')).toBe('8.3.2');
        expect(parseToolVersion('Composer version 2.6.5 2024-01-31 15:30:12')).toBe('2.6.5');
    });

    it('returns undefined when there is no version to find', () => {
        expect(parseToolVersion('')).toBeUndefined();
        expect(parseToolVersion('command not found')).toBeUndefined();
    });
});

describe('probeHostTool', () => {
    it('reports a tool present with its parsed version', async () => {
        const probe = await probeHostTool(
            TOOL_SPECS.git,
            runner((cmd) => (cmd === 'git' ? OK(VERSION_OUTPUT.git) : MISSING)),
        );
        expect(probe).toEqual({ name: 'git', installed: true, version: '2.42.0' });
    });

    it('reports a tool missing without throwing, and keeps a detail crumb', async () => {
        const probe = await probeHostTool(
            TOOL_SPECS.codex,
            runner(() => MISSING),
        );
        expect(probe.name).toBe('codex');
        expect(probe.installed).toBe(false);
        expect(probe.version).toBeUndefined();
        expect(probe.detail).toContain('ENOENT');
    });

    it('honours a bin override — an install that is not on PATH', async () => {
        const asked: string[] = [];
        await probeHostTool(
            TOOL_SPECS.php,
            runner((cmd) => {
                asked.push(cmd);
                return OK(VERSION_OUTPUT.php);
            }),
            'C:/Users/x/.config/herd/bin/php',
        );
        expect(asked).toEqual(['C:/Users/x/.config/herd/bin/php']);
    });

    it('survives a runner that rejects', async () => {
        const probe = await probeHostTool(TOOL_SPECS.node, {
            run: () => Promise.reject(new Error('boom')),
            stream: () => {
                throw new Error('unused');
            },
        });
        expect(probe.installed).toBe(false);
        expect(probe.name).toBe('node');
    });
});

describe('detectToolchain', () => {
    /** A machine with the base dev tools but no agent TUIs and no Docker —
     *  the common state Genie has to install INTO. Only the base bins answer;
     *  `claude`/`codex`/`docker` are absent. */
    const BASE_BINS = new Set(['git', 'node', 'npm', 'php', 'composer']);
    const freshDevMachine = runner((cmd) =>
        BASE_BINS.has(cmd) ? OK(VERSION_OUTPUT[cmd]) : MISSING,
    );

    it('checks the full default toolchain', async () => {
        const report = await detectToolchain({ runner: freshDevMachine, platform: 'linux' });
        expect(report.probes.map((p) => p.name)).toEqual([...DEFAULT_TOOLCHAIN]);
    });

    it('partitions the wanted set into present and missing', async () => {
        const report = await detectToolchain({ runner: freshDevMachine, platform: 'linux' });
        expect(report.present).toEqual(['git', 'node', 'npm', 'php', 'composer']);
        expect(report.missing).toEqual(['docker', 'claude-code', 'codex']);
    });

    it('records each present tool\u2019s parsed version', async () => {
        const report = await detectToolchain({ runner: freshDevMachine, platform: 'linux' });
        const byName = Object.fromEntries(report.probes.map((p) => [p.name, p]));
        expect(byName.node.version).toBe('20.11.0');
        expect(byName.php.version).toBe('8.3.2');
        expect(byName.composer.version).toBe('2.6.5');
    });

    it('reports docker PRESENT and RUNNING when the engine answers', async () => {
        const report = await detectToolchain({
            runner: runner((cmd, args) =>
                cmd === 'docker' && isServerProbe(args) ? OK('27.3.1\n') : MISSING,
            ),
            platform: 'win32',
            wanted: ['docker'],
        });
        expect(report.probes[0]).toMatchObject({
            name: 'docker',
            installed: true,
            running: true,
            version: '27.3.1',
        });
        expect(report.present).toEqual(['docker']);
        expect(report.missing).toEqual([]);
    });

    it('reports docker installed-but-not-running as PRESENT — start it, do not reinstall', async () => {
        const report = await detectToolchain({
            runner: runner((cmd, args) => {
                if (cmd !== 'docker') return MISSING;
                return isServerProbe(args) ? DAEMON_DOWN : OK('Docker version 27.3.1, build abc');
            }),
            platform: 'win32',
            wanted: ['docker'],
        });
        expect(report.probes[0]).toMatchObject({
            name: 'docker',
            installed: true,
            running: false,
        });
        // Installed means we do NOT queue an install — it belongs in present.
        expect(report.present).toEqual(['docker']);
        expect(report.missing).toEqual([]);
    });

    it('reports docker MISSING when the CLI is not there', async () => {
        const report = await detectToolchain({
            runner: runner(() => MISSING),
            platform: 'win32',
            wanted: ['docker'],
        });
        expect(report.probes[0]).toMatchObject({ name: 'docker', installed: false, running: false });
        expect(report.missing).toEqual(['docker']);
    });

    it('respects a narrowed wanted set', async () => {
        const report = await detectToolchain({
            runner: freshDevMachine,
            platform: 'linux',
            wanted: ['git', 'node'],
        });
        expect(report.probes.map((p) => p.name)).toEqual(['git', 'node']);
    });

    it('routes each tool through binFor when given', async () => {
        const asked: string[] = [];
        await detectToolchain({
            runner: runner((cmd) => {
                asked.push(cmd);
                return MISSING;
            }),
            platform: 'linux',
            wanted: ['php'],
            binFor: (name) => (name === 'php' ? '/opt/herd/php' : name),
        });
        expect(asked).toContain('/opt/herd/php');
    });

    it('carries the platform through, for the installer that reads it next', async () => {
        const report = await detectToolchain({ runner: freshDevMachine, platform: 'darwin' });
        expect(report.platform).toBe('darwin');
    });

    it('never throws when the runner rejects', async () => {
        const report = await detectToolchain({
            runner: {
                run: () => Promise.reject(new Error('boom')),
                stream: () => {
                    throw new Error('unused');
                },
            },
            platform: 'linux',
        });
        expect(report.missing).toEqual([...DEFAULT_TOOLCHAIN]);
    });
});
