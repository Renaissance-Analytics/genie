import { clientVersionArgv, serverVersionArgv } from './argv';
import { PREFERRED_RUNTIMES } from './container-runtime';
import type {
    CommandRunner,
    ContainerRuntimeKind,
    RuntimeDetection,
    RuntimeProbe,
} from './container-runtime';

/**
 * "Is there a container runtime here, and if not, what do I tell the user?"
 *
 * The owner's P1 decision was **detect Docker OR Podman; guide the install if
 * absent** — so the contract of this module is that it NEVER throws. A desktop
 * without Docker is the ordinary first-run state, not an error, and an exception
 * out of a probe is precisely how that ordinary state turns into a crash in
 * whatever handler happened to call it.
 *
 * ## Installed is not running
 *
 * The distinction this module exists for. `docker` on PATH with Docker Desktop
 * stopped is extremely common (it is the state of the machine this was written
 * on), and the two cases need OPPOSITE advice:
 *
 *   - not installed  → here is where to get one;
 *   - not running    → you already have one, start it.
 *
 * Telling someone to install Docker when Docker is installed sends them round a
 * loop they cannot exit. So each candidate is probed twice at most: the ENGINE
 * first (`version --format {{.Server.Version}}`, which only succeeds when the
 * daemon answers), and only if that fails, the CLI (`--version`).
 *
 * ## Preference ranks what WORKS
 *
 * Docker is preferred for Genie-Cloud parity, but a stopped Docker must not
 * shadow a working Podman — so the loop selects the first candidate that is
 * RUNNING, and falls back to reporting `none` only when nothing answers.
 *
 * Pure but for the injected {@link CommandRunner}, so every branch above is
 * tested on a machine that has neither runtime.
 */

export interface DetectOptions {
    runner: CommandRunner;
    platform?: NodeJS.Platform | string;
    /** Override the executable for one kind (a non-PATH install). */
    binFor?: (kind: ContainerRuntimeKind) => string;
}

/** Probe ONE candidate. Never throws. */
export async function probeRuntime(
    kind: ContainerRuntimeKind,
    runner: CommandRunner,
    bin: string = kind,
): Promise<RuntimeProbe> {
    try {
        const engine = await runner.run(bin, serverVersionArgv());
        const version = engine.code === 0 ? engine.stdout.trim() : '';
        // Exit 0 with no output happens when the CLI's context points at an
        // engine that is gone. Empty is not a version.
        if (version) return { kind, installed: true, running: true, version };

        const cli = await runner.run(bin, clientVersionArgv());
        const clientVersion = cli.code === 0 ? cli.stdout.trim() : '';
        const installed = !!clientVersion;
        const detail = (engine.stderr || cli.stderr || '').trim().slice(0, 400);
        return {
            kind,
            installed,
            running: false,
            // Carried, not discarded: it is the only proof the thing is on the
            // machine when the daemon cannot speak for it.
            ...(clientVersion ? { clientVersion } : {}),
            ...(detail ? { detail } : {}),
        };
    } catch (e) {
        // A CommandRunner is not supposed to reject (see `seams.ts`), but a
        // caller may inject one that does, and detection is load-bearing enough
        // that it must survive its own dependencies.
        return { kind, installed: false, running: false, detail: String(e) };
    }
}

export async function detectContainerRuntime(opts: DetectOptions): Promise<RuntimeDetection> {
    const platform = opts.platform ?? process.platform;
    const probes: RuntimeProbe[] = [];

    for (const kind of PREFERRED_RUNTIMES) {
        const probe = await probeRuntime(kind, opts.runner, opts.binFor?.(kind) ?? kind);
        probes.push(probe);
        if (probe.running) {
            return { kind, ...(probe.version ? { version: probe.version } : {}), probes };
        }
    }

    const stopped = probes.find((p) => p.installed);
    if (stopped) {
        return {
            kind: 'none',
            reason: 'not-running',
            installHint: notRunningHintFor(stopped.kind, platform),
            probes,
        };
    }
    return { kind: 'none', reason: 'not-installed', installHint: installHintFor(platform), probes };
}

// --- what to tell the user -------------------------------------------------

/** The guided-install path: a real, per-OS route to each runtime. */
export function installHintFor(platform: NodeJS.Platform | string): string {
    const lead = 'Genie needs a container runtime for workspace dev servers.';
    switch (platform) {
        case 'win32':
            return (
                `${lead} Install Docker Desktop ` +
                '(https://docs.docker.com/desktop/setup/install/windows-install/) or Podman Desktop ' +
                '(https://podman-desktop.io/downloads), then reopen the workspace.'
            );
        case 'darwin':
            return (
                `${lead} Install Docker Desktop ` +
                '(https://docs.docker.com/desktop/setup/install/mac-install/) or Podman ' +
                '(`brew install podman && podman machine init && podman machine start`), ' +
                'then reopen the workspace.'
            );
        default:
            return (
                `${lead} Install Docker Engine (https://docs.docker.com/engine/install/) or Podman ` +
                '(`sudo apt install podman` / `sudo dnf install podman`), then reopen the workspace.'
            );
    }
}

/** The other half: it IS installed, so say how to wake it. */
export function notRunningHintFor(
    kind: ContainerRuntimeKind,
    platform: NodeJS.Platform | string,
): string {
    if (kind === 'podman') {
        return (
            'Podman is installed but its engine is not reachable — ' +
            'run `podman machine start` (or start the Podman service), then try again.'
        );
    }
    const start =
        platform === 'linux'
            ? 'run `sudo systemctl start docker`'
            : 'start Docker Desktop and wait for the whale to settle';
    return `Docker is installed but its engine is not running — ${start}, then try again.`;
}
