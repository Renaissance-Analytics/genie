import type { DownloadInstallCommand } from './toolchain-adapters';

/**
 * PURE. How to RUN a downloaded installer artifact.
 *
 * The argv depends only on the artifact kind and where it was saved, so it is
 * decided here and executed by the impure primitive — keeping the one thing worth
 * asserting (the exact installer command) out of the spawn. Artifacts that need
 * multi-step handling not built yet (extracting a zip onto PATH, mounting a dmg,
 * placing a phar) return `unsupported` so the executor fails that tool loudly
 * rather than a best-guess command silently installing nothing.
 */

export type ArtifactRun =
    | { run: { command: string; args: string[] } }
    | { unsupported: DownloadInstallCommand['artifact'] };

export function artifactRunCommand(command: DownloadInstallCommand, localPath: string): ArtifactRun {
    switch (command.artifact) {
        case 'exe':
            // A vendor installer that takes its own silent-mode args (Docker
            // Desktop `install --quiet`, Git for Windows `/VERYSILENT`).
            return { run: { command: localPath, args: command.run?.args ?? [] } };
        case 'msi':
            return { run: { command: 'msiexec', args: ['/i', localPath, '/quiet', '/norestart'] } };
        case 'pkg':
            return { run: { command: 'installer', args: ['-pkg', localPath, '-target', '/'] } };
        case 'script':
            // The get.docker.com convenience script — run through sh (elevated by
            // the caller when the step needs it).
            return { run: { command: 'sh', args: [localPath] } };
        case 'zip':
        case 'dmg':
        case 'phar':
            // Extract-onto-PATH / mount-and-copy / place-a-phar are follow-ups
            // (they are the rarer direct paths — most installs go through a package
            // manager). Named so the executor reports exactly what it couldn't do.
            return { unsupported: command.artifact };
    }
}
