import type { HostReconcileEffects } from './host-reconcile';
import type { GenCaMaterial } from './host-ca';
import { trustStoreInstallCommand } from './host-ca';
import { applyHostCaddy } from './host-caddy';
import { isProcessElevated, runPrivilegedBatch, type PrivilegedStep } from './elevate';

/**
 * Wire {@link HostReconcileEffects} to the real host: the on-disk CA + leaf store,
 * the OS hosts file (via an elevated copy), the trust-store install (elevated), and
 * the host Caddy. This is the seam between the pure reconcile brain and the
 * machine — kept thin, with the fs/spawn primitives injected so the ORCHESTRATION
 * (write-then-install, temp-then-copy, loud throw on privileged failure) is unit-
 * tested and only the leaves need CI/real-machine validation.
 *
 * The privileged verbs come in two halves (genie#604): `prepare…` does the
 * UNPRIVILEGED staging — dropping the CA cert on disk, writing the new hosts
 * content to a temp file — and returns the command that would install it, while
 * {@link HostReconcileEffects.applyPrivileged} runs everything the pass staged
 * under one elevation. Splitting them is what turns two administrator prompts
 * into one; keeping each step's `label` here is what keeps a batched failure as
 * legible as the two separate ones were.
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

/** Step ids for the two privileged actions a reconcile can owe — stable strings
 *  so a batch failure can be matched on in tests and logs without depending on
 *  the user-facing label. */
export const CA_TRUST_STEP_ID = 'ca-trust';
export const HOSTS_FILE_STEP_ID = 'hosts-file';

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
        prepareCaTrust: async (caPem: string) => {
            // The trust command reads the cert from disk — make sure it's there.
            await io.writeFile(paths.caCertPath, caPem);
            const cmd = trustStoreInstallCommand(paths.caCertPath, io.platform);
            return {
                id: CA_TRUST_STEP_ID,
                label: 'install its local CA into the trust store',
                run: { cmd: cmd.cmd, args: cmd.args },
            };
        },
        hostsIo: {
            read: async () => (await io.readFile(paths.hostsFilePath)) ?? '',
            prepareWrite: async (next: string) => {
                // Editing the hosts file needs elevation; stage the new content in a
                // temp file now, and hand back the copy for the pass's one elevation.
                const tmp = await io.tempFile(next);
                return {
                    id: HOSTS_FILE_STEP_ID,
                    label: 'update the hosts file',
                    run: hostsCopyCommand(tmp, paths.hostsFilePath, io.platform),
                };
            },
        },
        applyPrivileged: async (steps: PrivilegedStep[]) => {
            const res = await runPrivilegedBatch(steps, { platform: io.platform, isElevated, spawn: io.spawn });
            if (res.ok) return;
            // Name the ACTION, not the batch. A step we can attribute keeps exactly
            // the sentence it had when it prompted on its own; a failure of the
            // elevation itself (prompt dismissed) blames no step but must still say
            // what Genie was trying to do — an opaque "elevated batch failed" would
            // be a worse trade than the two prompts this replaced.
            if (res.step) throw new Error(`Genie could not ${res.step.label}: ${res.error}`);
            const wanted = steps.map((s) => s.label).join(' and ');
            throw new Error(`Genie could not get Administrator approval to ${wanted}: ${res.error}`);
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
