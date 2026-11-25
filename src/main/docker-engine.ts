import { dockerHealth, dockerStartBatch, parseIdGroups, parseSystemctlActive, type DockerAccount, type DockerDaemon } from '../core/docker-engine.js';
import type { Elevate } from '../core/elevation.js';
import type { Platform, ToolStatus } from '../core/toolchain.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * DOCKER ON LINUX, THE MACHINE SIDE (Tynn #970; the pure half is core/docker-engine.ts). Reads the health as the user
 * (nothing here runs as root), and Start: one elevated batch through the host's elevation for the client that clicked
 * (#973), judged by `docker info` afterwards, never by the batch's exit code.
 */

const quiet = async (run: CommandRunner, binary: string, args: readonly string[]): Promise<{ stdout: string; exitCode: number } | null> => {
    try {
        return await run(binary, args);
    } catch {
        return null;
    }
};

/** The account and whether the group database has it in `docker`. */
export async function dockerAccount(run: CommandRunner, user: string): Promise<DockerAccount> {
    const r = await quiet(run, 'id', ['-nG', user]);
    return { user, inGroup: r !== null && r.exitCode === 0 && parseIdGroups(r.stdout).includes('docker') };
}

/** What `docker info` said, as the user. `null` = there is no docker to ask. */
async function dockerInfo(run: CommandRunner): Promise<{ exitCode: number; output: string } | null> {
    const r = await quiet(run, 'docker', ['info', '--format', '{{.ServerVersion}}']);
    return r === null ? null : { exitCode: r.exitCode, output: r.stdout };
}

/** The health here, or `null` when docker is not installed or its state cannot be told. */
export async function probeDockerHealth(run: CommandRunner, user: string): Promise<DockerDaemon | null> {
    const info = await dockerInfo(run);
    if (info === null) return null;
    const [active, mine, session] = await Promise.all([
        quiet(run, 'systemctl', ['is-active', 'docker.service']),
        quiet(run, 'id', ['-nG', user]),
        quiet(run, 'id', ['-nG']),
    ]);
    return dockerHealth({
        info,
        active: active === null ? null : parseSystemctlActive(active.stdout),
        userGroups: mine === null ? [] : parseIdGroups(mine.stdout),
        sessionGroups: session === null ? [] : parseIdGroups(session.stdout),
    });
}

/** The docker row with its health beside its version. Running, unknown, and not installed say nothing more. */
export function withDockerHealth<T extends ToolStatus>(statuses: readonly T[], daemon: DockerDaemon | null): T[] {
    if (daemon === null || daemon === 'running') return [...statuses];
    return statuses.map((s) => (s.tool === 'docker' && s.installed !== null ? { ...s, daemon } : s));
}

export type DockerStartOutcome =
    | { readonly kind: 'started' }
    | { readonly kind: 'needs-login' }
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'not-started'; readonly reason: string };

const tail = (text: string): string => {
    const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    return line ? ` (“${line.slice(0, 200)}”)` : '';
};

/** Start Docker: enable and start it, and the group when the account is not in it, under ONE prompt; then measured. */
export async function startDocker(ports: { readonly platform: Platform; readonly run: CommandRunner; readonly user: string; readonly elevate?: Elevate | undefined }): Promise<DockerStartOutcome> {
    if (ports.platform !== 'linux') return { kind: 'refused', reason: 'Genie starts Docker itself only on Linux; open Docker Desktop to start it' };
    if (!ports.elevate) return { kind: 'refused', reason: 'starting Docker needs your password, and no Genie window here can ask for it; nothing was changed' };
    const batch = dockerStartBatch(await dockerAccount(ports.run, ports.user));
    if ('refused' in batch) return { kind: 'refused', reason: batch.refused };
    const r = await ports.elevate(batch);
    if (r.kind === 'refused') return { kind: 'refused', reason: `Docker was not started: ${r.reason}` };
    if (r.failedStep !== null) {
        const step = batch.steps[r.failedStep];
        return { kind: 'not-started', reason: `${step ? [step.command, ...step.args].join(' ') : 'a step'} exited ${r.exitCode}${tail(r.output)}` };
    }
    const health = await probeDockerHealth(ports.run, ports.user);
    if (health === 'running') return { kind: 'started' };
    if (health === 'needs-login') return { kind: 'needs-login' };
    const info = await dockerInfo(ports.run);
    return { kind: 'not-started', reason: `the steps ran, and Docker still does not answer${tail(info?.output ?? '')}` };
}
