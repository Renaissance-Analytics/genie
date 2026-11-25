import { describe, expect, it } from 'vitest';
import { HOST_TOOLS, planInstall, planUpdate, type ToolStatus } from '../src/core/toolchain.js';
import { dockerHealth, dockerStartBatch, isLinuxUserName, parseIdGroups, parseSystemctlActive } from '../src/core/docker-engine.js';
import type { ElevatedBatch, ElevatedResult } from '../src/core/elevation.js';
import { dockerAccount, probeDockerHealth, startDocker, withDockerHealth } from '../src/main/docker-engine.js';
import { installTool, type ToolchainOpsPorts } from '../src/main/toolchain-ops.js';
import type { CommandRunner } from '../src/main/toolchain-prober.js';
import { applyToolchainCoreFeatureAction, type ToolchainFeatureServices } from '../src/main/feature-toolchain.js';
import type { FeaturePorts, FeatureState } from '../src/main/feature-ipc.js';

/**
 * DOCKER ON LINUX (Tynn #970, from #958). Measured on omarchy-genie (VM job 1120-214302-7cadb6): docker 29.9.2 installed,
 * the user in the docker group, `systemctl is-active docker` = inactive, and the Toolchain row read "29.9.2" with no badge;
 * installing it was refused ("no package manager found"). Genie 1 (v0.7.0-beta.342 toolchain-adapters.ts) installed the
 * distro's engine; Genie 2 lost that. Here:
 *   - the distro's Docker ENGINE installs as ONE elevated batch (#973): the package, `systemctl enable --now` of its socket
 *     and service, and `usermod -aG docker <user>` when the user is not in the group;
 *   - "installed" is a HEALTH, not a version: `docker info` as the user, `systemctl is-active`, and the groups the account
 *     has against the groups THIS session has. Not running offers Start (the same enable and group, one batch); a group
 *     just added that this session does not have yet reads "Needs a new login".
 * Every runner and elevation is a fake; every test counts what ran.
 */

const ENABLE = { command: 'systemctl', args: ['enable', '--now', 'docker.socket', 'docker.service'] };
const GROUP = (user: string) => ({ command: 'usermod', args: ['-aG', 'docker', user] });
const ITEM_ENABLE = 'enable and start docker.socket and docker.service';
const ITEM_GROUP = (user: string) => `add ${user} to the docker group`;

describe('the Docker engine per package manager', () => {
    it('the table names the distro engine: pacman docker, apt docker.io, dnf moby-engine; Windows and macOS keep Docker Desktop', () => {
        const docker = HOST_TOOLS.find((t) => t.name === 'docker')!;
        expect(docker.packages).toEqual({ winget: 'Docker.DockerDesktop', brew: 'docker-desktop', pacman: 'docker', apt: 'docker.io', dnf: 'moby-engine' });
    });

    const cases = [
        ['pacman', 'docker', [{ command: 'pacman', args: ['-Sy'] }, { command: 'pacman', args: ['-S', '--needed', '--noconfirm', 'docker'] }]],
        ['apt', 'docker.io', [{ command: 'apt-get', args: ['update'] }, { command: 'apt-get', args: ['install', '-y', 'docker.io'] }]],
        ['dnf', 'moby-engine', [{ command: 'dnf', args: ['install', '-y', 'moby-engine'] }]],
    ] as const;
    for (const [pm, pkg, install] of cases) {
        it(`${pm}: install is ONE elevated batch: ${pkg}, then enable and start it, then the group when the user is not in it`, () => {
            const plan = planInstall({ tool: 'docker', platform: 'linux', packageManager: pm, account: { user: 'genie', inGroup: false } });
            expect(plan).toMatchObject({ manager: pm, elevated: true, items: [pkg, ITEM_ENABLE, ITEM_GROUP('genie')], steps: [...install, ENABLE, GROUP('genie')] });
            expect('label' in plan && plan.label).toMatch(/systemctl enable --now docker\.socket docker\.service && usermod -aG docker genie \(as administrator\)$/);
            expect(JSON.stringify(plan)).not.toMatch(/pkexec|sudo|sh -c/);
        });
        it(`${pm}: a user already in the docker group is not added again`, () => {
            const plan = planInstall({ tool: 'docker', platform: 'linux', packageManager: pm, account: { user: 'genie', inGroup: true } });
            expect(plan).toMatchObject({ items: [pkg, ITEM_ENABLE], steps: [...install, ENABLE] });
        });
    }

    it('with no account to add, Docker on Linux is refused before anyone is asked (an engine nobody can use is worse than none)', () => {
        expect(planInstall({ tool: 'docker', platform: 'linux', packageManager: 'apt' })).toEqual({ refused: 'Genie could not tell which account to add to the docker group, so it did not install Docker' });
    });

    it('the account name reaches usermod only when it is a Linux user name: no option, no shell, no path', () => {
        for (const ok of ['genie', 'wish_born', '_svc', 'a-b-c', 'user1']) expect(isLinuxUserName(ok)).toBe(true);
        for (const bad of ['', '-G', '--help', 'root;rm -rf /', 'a b', '../x', 'Genie', '1abc', 'x'.repeat(33), 'genie\n', 'a$b']) {
            expect(isLinuxUserName(bad)).toBe(false);
            expect(planInstall({ tool: 'docker', platform: 'linux', packageManager: 'pacman', account: { user: bad, inGroup: false } })).toEqual({ refused: `${JSON.stringify(bad)} is not a Linux account name Genie will add to the docker group` });
        }
    });

    it('Windows and macOS are unchanged: Docker Desktop, with no service or group steps', () => {
        expect(planInstall({ tool: 'docker', platform: 'win32', packageManager: 'winget' })).toMatchObject({ argv: ['winget', 'install', '--id', 'Docker.DockerDesktop', '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements'], elevated: false });
        expect(planInstall({ tool: 'docker', platform: 'darwin', packageManager: 'brew' })).toMatchObject({ argv: ['brew', 'install', 'docker-desktop'] });
    });

    it('an update is the engine package alone: enabling and the group are Start\'s, not an update\'s', () => {
        expect(planUpdate({ tool: 'docker', platform: 'linux', packageManager: 'apt' })).toMatchObject({ elevated: true, items: ['docker.io'], steps: [{ command: 'apt-get', args: ['install', '--only-upgrade', '-y', 'docker.io'] }] });
        expect(planUpdate({ tool: 'docker', platform: 'linux', packageManager: 'dnf' })).toMatchObject({ elevated: true, items: ['moby-engine'], steps: [{ command: 'dnf', args: ['upgrade', '-y', 'moby-engine'] }] });
    });
});

describe('Start Docker: ONE batch', () => {
    it('enable and start the socket and the service, and add the user to the group when they are not in it', () => {
        expect(dockerStartBatch({ user: 'genie', inGroup: false })).toEqual({ title: 'Start Docker', items: [ITEM_ENABLE, ITEM_GROUP('genie')], steps: [ENABLE, GROUP('genie')] });
        expect(dockerStartBatch({ user: 'genie', inGroup: true })).toEqual({ title: 'Start Docker', items: [ITEM_ENABLE], steps: [ENABLE] });
        expect(dockerStartBatch({ user: '-G wheel', inGroup: false })).toEqual({ refused: '"-G wheel" is not a Linux account name Genie will add to the docker group' });
    });
});

// --- the health, from what the machine says (output captured on omarchy-genie and Ubuntu) ------------------------------

const DOWN = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
const DENIED = 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied';

describe('the health parser', () => {
    it('systemctl is-active: the state word, or null for anything else', () => {
        expect(parseSystemctlActive('active\n')).toBe('active');
        expect(parseSystemctlActive('inactive\n')).toBe('inactive');
        expect(parseSystemctlActive('failed')).toBe('failed');
        expect(parseSystemctlActive('activating\n')).toBe('activating');
        expect(parseSystemctlActive('')).toBeNull();
        expect(parseSystemctlActive('System has not been booted with systemd as init system (PID 1). Can\'t operate.')).toBeNull();
    });

    it('id -nG: the group names', () => {
        expect(parseIdGroups('genie wheel docker\n')).toEqual(['genie', 'wheel', 'docker']);
        expect(parseIdGroups('')).toEqual([]);
    });

    const groups = { userGroups: ['genie', 'docker'], sessionGroups: ['genie', 'docker'] };
    it('docker info answers: running, whatever systemctl says', () => {
        expect(dockerHealth({ info: { exitCode: 0, output: '29.9.2' }, active: 'inactive', ...groups })).toBe('running');
    });
    it('the daemon is down: not running (by docker\'s words, or by systemctl when docker says nothing)', () => {
        expect(dockerHealth({ info: { exitCode: 1, output: DOWN }, active: 'inactive', ...groups })).toBe('not-running');
        expect(dockerHealth({ info: { exitCode: 1, output: DOWN }, active: null, ...groups })).toBe('not-running');
        expect(dockerHealth({ info: { exitCode: 1, output: '' }, active: 'failed', ...groups })).toBe('not-running');
    });
    it('permission denied while the ACCOUNT is in the group and THIS session is not: needs a new login', () => {
        expect(dockerHealth({ info: { exitCode: 1, output: DENIED }, active: 'active', userGroups: ['genie', 'docker'], sessionGroups: ['genie'] })).toBe('needs-login');
    });
    it('permission denied with the account not in the group: no access (Start adds it)', () => {
        expect(dockerHealth({ info: { exitCode: 1, output: DENIED }, active: 'active', userGroups: ['genie'], sessionGroups: ['genie'] })).toBe('no-access');
    });
    it('anything else is not known: null, never a guess', () => {
        expect(dockerHealth({ info: { exitCode: 1, output: 'Error response from daemon: something odd' }, active: 'active', ...groups })).toBeNull();
    });
});

// --- the machine side -----------------------------------------------------------------------------------------------

type Call = { binary: string; args: readonly string[] };
/** A Linux box with docker installed: `daemon` says whether docker info answers; `session` the groups this process has. */
function linux(opts: { daemon: 'up' | 'down'; userGroups: string; session: string; installed?: boolean }) {
    const calls: Call[] = [];
    const state = { ...opts, installed: opts.installed ?? true };
    const run: CommandRunner = async (binary, args) => {
        calls.push({ binary, args });
        if (binary === 'docker' && !state.installed) throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
        if (binary === 'docker' && args[0] === '--version') return { stdout: 'Docker version 29.9.2, build 1234567', exitCode: 0 };
        if (binary === 'docker' && args[0] === 'info') {
            if (state.daemon === 'down') return { stdout: DOWN, exitCode: 1 };
            return state.session.split(' ').includes('docker') ? { stdout: '29.9.2', exitCode: 0 } : { stdout: DENIED, exitCode: 1 };
        }
        if (binary === 'systemctl') return { stdout: state.daemon === 'up' ? 'active\n' : 'inactive\n', exitCode: state.daemon === 'up' ? 0 : 3 };
        if (binary === 'id' && args.length === 2) return { stdout: `${state.userGroups}\n`, exitCode: 0 };
        if (binary === 'id') return { stdout: `${state.session}\n`, exitCode: 0 };
        if (binary === 'apt-get' || binary === 'pacman') return { stdout: 'apt-get 2.9.8', exitCode: 0 };
        throw Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' });
    };
    const batches: ElevatedBatch[] = [];
    const elevate = async (batch: ElevatedBatch): Promise<ElevatedResult> => {
        batches.push(batch);
        if (batch.steps.some((s) => s.command === 'systemctl')) state.daemon = 'up';
        if (batch.steps.some((s) => s.command === 'usermod') && !state.userGroups.split(' ').includes('docker')) state.userGroups += ' docker';
        if (batch.steps.some((s) => s.args.includes('docker.io'))) state.installed = true;
        return { kind: 'ran', exitCode: 0, output: '', failedStep: null };
    };
    return { calls, batches, run, elevate, state };
}

describe('the health, measured', () => {
    it('reads docker info AS THE USER, systemctl, and both group lists; nothing runs as root', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie docker', session: 'genie docker' });
        expect(await probeDockerHealth(m.run, 'genie')).toBe('not-running');
        expect(m.calls).toEqual(expect.arrayContaining([
            { binary: 'docker', args: ['info', '--format', '{{.ServerVersion}}'] },
            { binary: 'systemctl', args: ['is-active', 'docker.service'] },
            { binary: 'id', args: ['-nG', 'genie'] },
            { binary: 'id', args: ['-nG'] },
        ]));
        expect(m.calls.some((c) => ['sudo', 'pkexec', 'usermod'].includes(c.binary))).toBe(false);
    });
    it('no docker on the machine: no health (the row is Not installed already)', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie', session: 'genie', installed: false });
        expect(await probeDockerHealth(m.run, 'genie')).toBeNull();
    });
    it('the account and whether it is in the group', async () => {
        expect(await dockerAccount(linux({ daemon: 'up', userGroups: 'genie wheel', session: 'genie' }).run, 'genie')).toEqual({ user: 'genie', inGroup: false });
        expect(await dockerAccount(linux({ daemon: 'up', userGroups: 'genie docker', session: 'genie' }).run, 'genie')).toEqual({ user: 'genie', inGroup: true });
    });

    const docker: ToolStatus = { tool: 'docker', installed: '29.9.2', latest: null, tone: 'unknown', source: null };
    const git: ToolStatus = { tool: 'git', installed: '2.56.0', latest: '2.56.0', tone: 'up-to-date', source: 'x' };
    it('the row carries the health beside its version; running says nothing extra; other rows are untouched', () => {
        expect(withDockerHealth([git, docker], 'not-running')).toEqual([git, { ...docker, daemon: 'not-running' }]);
        expect(withDockerHealth([git, docker], 'needs-login')).toEqual([git, { ...docker, daemon: 'needs-login' }]);
        expect(withDockerHealth([git, docker], 'running')).toEqual([git, docker]);
        expect(withDockerHealth([git, docker], null)).toEqual([git, docker]);
        // Not installed stays Not installed.
        const missing: ToolStatus = { ...docker, installed: null, tone: 'not-installed' };
        expect(withDockerHealth([missing], 'not-running')).toEqual([missing]);
    });
});

describe('Start Docker, run', () => {
    it('ONE elevated batch, then judged by docker info as the user: running', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie docker', session: 'genie docker' });
        expect(await startDocker({ platform: 'linux', run: m.run, user: 'genie', elevate: m.elevate })).toEqual({ kind: 'started' });
        expect(m.batches).toEqual([{ title: 'Start Docker', items: [ITEM_ENABLE], steps: [ENABLE] }]);
    });
    it('a group just added that this session does not have: started, and it needs a new login', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie', session: 'genie' });
        expect(await startDocker({ platform: 'linux', run: m.run, user: 'genie', elevate: m.elevate })).toEqual({ kind: 'needs-login' });
        expect(m.batches).toEqual([{ title: 'Start Docker', items: [ITEM_ENABLE, ITEM_GROUP('genie')], steps: [ENABLE, GROUP('genie')] }]);
    });
    it('no way to ask for the password: refused before anything runs', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie docker', session: 'genie docker' });
        expect(await startDocker({ platform: 'linux', run: m.run, user: 'genie' })).toEqual({ kind: 'refused', reason: 'starting Docker needs your password, and no Genie window here can ask for it; nothing was changed' });
        expect(m.batches).toEqual([]);
    });
    it('the prompt refused: refused with its words', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie docker', session: 'genie docker' });
        expect(await startDocker({ platform: 'linux', run: m.run, user: 'genie', elevate: async () => ({ kind: 'refused', reason: 'you cancelled' }) })).toEqual({ kind: 'refused', reason: 'Docker was not started: you cancelled' });
    });
    it('a step that failed says which, with its own words, and Docker is not called started', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie docker', session: 'genie docker' });
        const r = await startDocker({ platform: 'linux', run: m.run, user: 'genie', elevate: async () => ({ kind: 'ran', exitCode: 1, output: 'Failed to enable unit: Unit docker.socket does not exist', failedStep: 0 }) });
        expect(r).toEqual({ kind: 'not-started', reason: 'systemctl enable --now docker.socket docker.service exited 1 (“Failed to enable unit: Unit docker.socket does not exist”)' });
    });
    it('the batch ran and docker still does not answer: not started, by the measurement', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie docker', session: 'genie docker' });
        const r = await startDocker({ platform: 'linux', run: m.run, user: 'genie', elevate: async () => ({ kind: 'ran', exitCode: 0, output: '', failedStep: null }) });
        expect(r).toEqual({ kind: 'not-started', reason: 'the steps ran, and Docker still does not answer (“Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?”)' });
    });
    it('not Linux: refused (Docker Desktop starts itself)', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie', session: 'genie' });
        expect(await startDocker({ platform: 'win32', run: m.run, user: 'genie', elevate: m.elevate })).toEqual({ kind: 'refused', reason: 'Genie starts Docker itself only on Linux; open Docker Desktop to start it' });
        expect(m.batches).toEqual([]);
    });
});

describe('installing Docker on Linux, through installTool', () => {
    it('ONE elevated batch with the account the port names; judged by the re-probe', async () => {
        const m = linux({ daemon: 'down', userGroups: 'genie', session: 'genie', installed: false });
        const ports: ToolchainOpsPorts = {
            platform: 'linux', run: m.run, elevate: m.elevate, dataDir: '/d', systemRoot: '', packageManager: async () => 'apt',
            env: { get: () => undefined, set: () => {} }, fs: { exists: () => false, readText: () => null, writeText: () => {}, mkdirp: () => {}, remove: () => {} },
            dockerAccount: () => dockerAccount(m.run, 'genie'),
        };
        expect(await installTool('docker', true, ports)).toMatchObject({ kind: 'installed', version: '29.9.2' });
        expect(m.batches).toHaveLength(1);
        expect(m.batches[0]).toMatchObject({ items: ['docker.io', ITEM_ENABLE, ITEM_GROUP('genie')], steps: [{ command: 'apt-get', args: ['update'] }, { command: 'apt-get', args: ['install', '-y', 'docker.io'] }, ENABLE, GROUP('genie')] });
        expect(m.batches[0]!.title).toMatch(/docker/i);
    });
});

describe('the Start action on the Toolchain', () => {
    const services = { sites: { list: () => [], restart: () => {} }, supervisor: { status: () => null, restart: () => false } } as unknown as ToolchainFeatureServices;
    const off: ToolStatus = { tool: 'docker', installed: '29.9.2', latest: null, tone: 'unknown', source: null, daemon: 'not-running' };
    const on: ToolStatus = { tool: 'docker', installed: '29.9.2', latest: null, tone: 'unknown', source: null };
    const state = (): FeatureState => ({ toolStatuses: [off], knowledgeQuery: '', toolchainCheckedAt: 1 } as FeatureState);
    const tcPorts = (start?: () => Promise<Awaited<ReturnType<typeof startDocker>>>, after: ToolStatus = on) => ({
        toolchain: { probe: async () => [after], update: async () => ({ kind: 'refused' as const, reason: 'no' }), now: () => 2, ...(start ? { startDocker: start } : {}) },
    }) as unknown as Pick<FeaturePorts, 'toolchain'>;

    it('runs Start and shows the RE-PROBE; the result says it runs', async () => {
        let started = 0;
        const s = state(); const next = { ...s };
        await applyToolchainCoreFeatureAction(services, { kind: 'toolchain.startDocker' }, s, next, tcPorts(async () => { started++; return { kind: 'started' }; }));
        expect(started).toBe(1);
        expect(next.toolStatuses).toEqual([on]);
        expect(next.toolchainResult).toBe('Docker is running.');
    });
    it('needs a new login: said, as the result', async () => {
        const s = state(); const next = { ...s };
        await applyToolchainCoreFeatureAction(services, { kind: 'toolchain.startDocker' }, s, next, tcPorts(async () => ({ kind: 'needs-login' }), { ...on, daemon: 'needs-login' }));
        expect(next.toolchainResult).toBe('Docker is running. You were added to the docker group: log out and back in so Genie and its services can use it.');
    });
    it('a refusal is said ON the docker row', async () => {
        const s = state(); const next = { ...s };
        await applyToolchainCoreFeatureAction(services, { kind: 'toolchain.startDocker' }, s, next, tcPorts(async () => ({ kind: 'refused', reason: 'Docker was not started: you cancelled' }), off));
        expect(next.toolchainRefusals).toEqual([{ tool: 'docker', reason: 'Docker was not started: you cancelled' }]);
    });
    it('no Start wired: refused on the row, nothing runs', async () => {
        const s = state(); const next = { ...s };
        await applyToolchainCoreFeatureAction(services, { kind: 'toolchain.startDocker' }, s, next, tcPorts());
        expect(next.toolchainRefusals).toEqual([{ tool: 'docker', reason: 'starting Docker is not wired into this Genie; nothing was changed' }]);
    });
});
