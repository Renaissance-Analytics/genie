import type { HostReconcileEffects } from './host-reconcile';
import type { GenCaMaterial } from './host-ca';
import { trustStoreInstallCommand } from './host-ca';
import { applyHostCaddy } from './host-caddy';
import { elevationLauncherArgv, isProcessElevated, runPrivileged } from './elevate';

/**
 * Wire {@link HostReconcileEffects} to the real host: the on-disk CA + leaf store,
 * the OS hosts file (via an elevated copy), the trust-store install (elevated), and
 * the host Caddy. This is the seam between the pure reconcile brain and the
 * machine — kept thin, with the fs/spawn primitives injected so the ORCHESTRATION
 * (write-then-install, temp-then-copy, loud throw on privileged failure) is unit-
 * tested and only the leaves need CI/real-machine validation.
 */

export interface HostEffectPaths {
    /** Genie data dir (host-only). */
    caCertPath: string;
    caKeyPath: string;
    leafCertPath: string;
    leafKeyPath: string;
    caddyfilePath: string;
    /** The OS hosts file. */
    hostsFilePath: string;
    /** The caddy binary Genie ships/locates on the host. */
    caddyBin: string;
}

export interface HostEffectIo {
    platform: NodeJS.Platform;
    /** Read a file, or null when it does not exist. */
    readFile: (path: string) => Promise<string | null>;
    /** Write a file in the Genie data dir (unprivileged); `mode` for the 0600 key. */
    writeFile: (path: string, content: string, opts?: { mode?: number }) => Promise<void>;
    /** Stage content in a temp file, returning its path (for the elevated hosts copy). */
    tempFile: (content: string) => Promise<string>;
    /** Spawn a command to completion. */
    spawn: (cmd: string, args: string[]) => Promise<{ code: number; stderr?: string }>;
    /** Start a detached, long-lived process (the host Caddy). */
    spawnDetached: (argv: string[]) => Promise<{ ok: boolean; error?: string }>;
    /** Override the privilege check (defaults to {@link isProcessElevated}). */
    isElevated?: () => boolean;
}

/** The command that copies the staged hosts file over the real one, per OS. */
export function hostsCopyCommand(
    src: string,
    dest: string,
    platform: NodeJS.Platform,
): { cmd: string; args: string[] } {
    if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'copy', '/y', src, dest] };
    return { cmd: 'cp', args: ['-f', src, dest] };
}

export function buildHostReconcileEffects(paths: HostEffectPaths, io: HostEffectIo): HostReconcileEffects {
    const isElevated = io.isElevated ?? (() => isProcessElevated(io.platform));
    const privileged = (cmd: string, args: string[]) =>
        runPrivileged(
            { cmd, args },
            {
                platform: io.platform,
                isElevated,
                spawnDirect: (c, a) => io.spawn(c, a),
                spawnElevated: (c, a) => {
                    const [lc, ...la] = elevationLauncherArgv(c, a, io.platform);
                    return io.spawn(lc, la);
                },
            },
        );

    return {
        caStore: {
            readCert: () => io.readFile(paths.caCertPath),
            readKey: () => io.readFile(paths.caKeyPath),
            write: async (m: GenCaMaterial) => {
                await io.writeFile(paths.caCertPath, m.caPem);
                await io.writeFile(paths.caKeyPath, m.caKeyPem, { mode: 0o600 });
            },
        },
        writeLeaf: async (leaf) => {
            await io.writeFile(paths.leafCertPath, leaf.certPem);
            await io.writeFile(paths.leafKeyPath, leaf.keyPem, { mode: 0o600 });
            return { certPath: paths.leafCertPath, keyPath: paths.leafKeyPath };
        },
        installCaTrust: async (caPem: string) => {
            // The trust command reads the cert from disk — make sure it's there.
            await io.writeFile(paths.caCertPath, caPem);
            const cmd = trustStoreInstallCommand(paths.caCertPath, io.platform);
            const res = await privileged(cmd.cmd, cmd.args);
            if (!res.ok) {
                throw new Error(`Genie could not install its local CA into the trust store: ${res.error}`);
            }
        },
        hostsIo: {
            read: async () => (await io.readFile(paths.hostsFilePath)) ?? '',
            write: async (next: string) => {
                // Editing the hosts file needs elevation; stage the new content in a
                // temp file, then privilege-copy it over the real one.
                const tmp = await io.tempFile(next);
                const copy = hostsCopyCommand(tmp, paths.hostsFilePath, io.platform);
                const res = await privileged(copy.cmd, copy.args);
                if (!res.ok) {
                    throw new Error(`Genie could not update the hosts file: ${res.error}`);
                }
            },
        },
        writeCaddyfileAndReload: async (caddyfile: string) => {
            const res = await applyHostCaddy(caddyfile, {
                caddyBin: paths.caddyBin,
                configPath: paths.caddyfilePath,
                writeFile: (p, c) => io.writeFile(p, c),
                run: (argv) => io.spawn(argv[0], argv.slice(1)),
                startDetached: (argv) => io.spawnDetached(argv),
            });
            if (!res.ok) {
                throw new Error(`Genie could not apply the host Caddy config: ${res.error}`);
            }
        },
    };
}
