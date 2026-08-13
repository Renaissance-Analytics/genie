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

// --- the FULL install plan, including the artifacts that need more than a run ---

/** Where Genie keeps the tools it installed itself. */
export interface ArtifactContext {
    /** Genie-owned root for installed tools (`<userData>/tools`). */
    toolsDir: string;
    /** Where launchers/shims live, and what goes on PATH for them. */
    binDir: string;
    os: NodeJS.Platform | string;
}

/**
 * What the impure layer must DO to install a downloaded artifact.
 *
 * `run` was the only shape before, which is why php and composer could not be
 * installed on Windows at all: winget has neither, so php arrives as a ZIP of
 * loose binaries and composer as a PHAR that cannot execute itself. Those need a
 * destination and (for composer) a launcher, not an installer invocation.
 */
export type ArtifactInstall =
    | { kind: 'run'; command: string; args: string[] }
    | {
          kind: 'extract';
          zip: string;
          dest: string;
          command: string;
          args: string[];
          /** Directory to put on PATH once extracted. */
          pathAdd: string;
      }
    | {
          kind: 'phar';
          from: string;
          to: string;
          shimPath: string;
          shimBody: string;
          /** posix: the shim needs the executable bit. */
          executable: boolean;
          pathAdd: string;
      }
    | { kind: 'unsupported'; artifact: DownloadInstallCommand['artifact'] };

/** Join without importing `path` — this module stays pure and platform-agnostic
 *  so a win32 plan can be asserted on a posix CI runner and vice versa. */
function joinFor(os: NodeJS.Platform | string, ...parts: string[]): string {
    const sep = os === 'win32' ? '\\' : '/';
    return parts.join(sep);
}

/**
 * The Windows composer launcher. `%~dp0` resolves beside the shim (so moving the
 * tools directory does not break it) and `%*` forwards every argument — without
 * it `composer require x` would run as a bare `composer`.
 */
function winPharShim(pharName: string): string {
    return `@echo off\r\nphp "%~dp0${pharName}" %*\r\n`;
}

function posixPharShim(pharName: string): string {
    return `#!/bin/sh\nexec php "$(dirname "$0")/${pharName}" "$@"\n`;
}

export function artifactInstallPlan(
    command: DownloadInstallCommand,
    localPath: string,
    ctx: ArtifactContext,
): ArtifactInstall {
    const isWin = ctx.os === 'win32';
    switch (command.artifact) {
        case 'exe':
        case 'msi':
        case 'pkg':
        case 'script': {
            const legacy = artifactRunCommand(command, localPath);
            return 'run' in legacy
                ? { kind: 'run', command: legacy.run.command, args: legacy.run.args }
                : { kind: 'unsupported', artifact: command.artifact };
        }
        case 'zip': {
            // Its own directory under Genie: no elevation, nothing of the
            // user's is overwritten, and removing the tool is deleting a folder.
            const dest = joinFor(ctx.os, ctx.toolsDir, command.tool);
            return {
                kind: 'extract',
                zip: localPath,
                dest,
                // `-Force` so a re-run overwrites a half-extracted attempt
                // rather than failing on "already exists".
                ...(isWin
                    ? {
                          command: 'powershell',
                          args: [
                              '-NoProfile',
                              '-NonInteractive',
                              '-Command',
                              `Expand-Archive -Path '${localPath}' -DestinationPath '${dest}' -Force`,
                          ],
                      }
                    : { command: 'unzip', args: ['-o', localPath, '-d', dest] }),
                // The archives Genie fetches (php-windows, nodejs-dist) put the
                // executables at the root, so the extract dir IS the PATH entry.
                pathAdd: dest,
            };
        }
        case 'phar': {
            const name = `${command.tool}.phar`;
            return {
                kind: 'phar',
                from: localPath,
                to: joinFor(ctx.os, ctx.binDir, name),
                shimPath: joinFor(ctx.os, ctx.binDir, isWin ? `${command.tool}.bat` : command.tool),
                shimBody: isWin ? winPharShim(name) : posixPharShim(name),
                executable: !isWin,
                pathAdd: ctx.binDir,
            };
        }
        case 'dmg':
            // Mount-and-copy is genuinely not built. Named so the executor can
            // say WHAT it couldn't do rather than guessing at a command.
            return { kind: 'unsupported', artifact: command.artifact };
    }
}
