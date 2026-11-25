import { HOST_TOOLS, type PackageManager } from '../core/toolchain.js';
import { OFFICIAL_REPOSITORIES, pacmanVersion, parsePacmanQ, parsePacmanSi, parsePacmanTargets, upgradedByInstall } from '../core/pacman.js';
import type { CommandRunner, LatestIndex } from './toolchain-prober.js';

/**
 * PACMAN'S SYNC DATABASE, READ WITHOUT ROOT (Tynn #968). Measured on omarchy-genie (jobs 1125-191309-39cf81 and
 * 1125-191913-5de173): the image has no sync databases at all, `pacman -Sy` needs root, and `fakeroot pacman -Sy` is
 * refused by pacman's own sandbox; `checkupdates` (pacman-contrib, on the image) refreshes a copy of its own, at
 * CHECKUPDATES_DB, as the user. Genie keeps that copy in its data folder and reads it with `pacman --dbpath`: what the
 * official repositories have now (`-Si`), and what an install would bring in (`-Sp`). The system's own databases are
 * left as they are until the person's elevated batch runs `pacman -Sy`.
 */

/** How long one refresh stands: a person's Check and an install right after it read the same databases. */
const REFRESH_MS = 30 * 60_000;

export interface PacmanSync {
    /** What the official repositories have for these packages; `null` when the databases could not be refreshed. */
    info(pkgs: readonly string[]): Promise<Map<string, { repository: string; version: string }> | null>;
    /** The transaction `pacman -S --needed <pkgs>` would be, from the same databases; `null` when it cannot be read. */
    targets(pkgs: readonly string[]): Promise<Array<{ name: string; version: string }> | null>;
    /** What is installed (`pacman -Q`). */
    installed(): Promise<Map<string, string>>;
}

export function pacmanSync(ports: { run: CommandRunner; dbPath: string; now?: () => number }): PacmanSync {
    const now = ports.now ?? Date.now;
    let refreshed: { at: number; ok: Promise<boolean> } | null = null;
    const refresh = (): Promise<boolean> => {
        if (refreshed && now() - refreshed.at < REFRESH_MS && now() >= refreshed.at) return refreshed.ok;
        // checkupdates: 0 = updates listed, 2 = none; both mean the copy is current. 1 = it failed.
        const ok = ports.run('checkupdates', ['--nocolor'], { env: { CHECKUPDATES_DB: ports.dbPath } }).then((r) => r.exitCode === 0 || r.exitCode === 2, () => false);
        refreshed = { at: now(), ok };
        void ok.then((good) => { if (!good) refreshed = null; });
        return ok;
    };
    const read = async (args: readonly string[]): Promise<string | null> => {
        try {
            // C locale: -Si's field names ("Repository", "Version") are translated in a person's own language.
            return (await ports.run('pacman', args, { env: { LC_ALL: 'C' } })).stdout;
        } catch {
            return null;
        }
    };
    return {
        info: async (pkgs) => {
            if (!(await refresh())) return null;
            const out = await read(['-Si', '--dbpath', ports.dbPath, ...pkgs]);
            return out === null ? null : parsePacmanSi(out);
        },
        targets: async (pkgs) => {
            if (!(await refresh())) return null;
            const out = await read(['-Sp', '--print-format', '%n %v', '--needed', '--dbpath', ports.dbPath, ...pkgs]);
            return out === null ? null : parsePacmanTargets(out);
        },
        installed: async () => parsePacmanQ((await read(['-Q'])) ?? ''),
    };
}

/** Where Genie keeps its copy of the sync databases. A Linux path, whatever the host it is planned on. */
export const pacmanDbPath = (dataDir: string): string => `${dataDir.replace(/[\\/]+$/, '')}/pacman-sync`;

/**
 * "LATEST" FOR A PACMAN TOOL: the version the official repositories have, as the tool itself says it (no epoch, no
 * pkgrel), so a card reads up-to-date or offers Update from what this machine could actually install. Every other tool,
 * and every other platform, asks `base` as before.
 */
export function withPacmanLatest(base: LatestIndex, ports: { packageManager: () => Promise<PackageManager | null>; sync: PacmanSync }): LatestIndex {
    return async (tool) => {
        const pkg = HOST_TOOLS.find((t) => t.name === tool)?.packages.pacman;
        if (!pkg || (await ports.packageManager()) !== 'pacman') return base(tool);
        try {
            const hit = (await ports.sync.info([pkg]))?.get(pkg);
            if (hit && OFFICIAL_REPOSITORIES.includes(hit.repository)) return { version: pacmanVersion(hit.version), source: `pacman (${hit.repository})` };
        } catch {
            // the honest unknown, below
        }
        return base(tool);
    };
}

/**
 * THE CHECK BEFORE ANY PACMAN INSTALL OR UPDATE (the sync rule): the package is in an official repository, and the
 * transaction upgrades no installed package but `pkg` itself (an update) — nothing, for an install. `null` = go ahead;
 * otherwise the refusal, in words the card shows.
 */
export async function pacmanPreflight(sync: PacmanSync, tool: string, pkgs: readonly string[], verb: 'install' | 'update'): Promise<string | null> {
    const ing = verb === 'install' ? 'installing' : 'updating';
    const info = await sync.info(pkgs);
    if (info === null) return `Genie could not read Arch's package databases (checkupdates failed), so it cannot check that ${ing} ${tool} upgrades nothing else; nothing was ${verb === 'install' ? 'installed' : 'changed'}`;
    const missing = pkgs.find((p) => { const hit = info.get(p); return !hit || !OFFICIAL_REPOSITORIES.includes(hit.repository); });
    if (missing !== undefined) {
        return `${missing} is not in Arch's official repositories here (${OFFICIAL_REPOSITORIES.join(', ')}); Genie does not install from the AUR, so yay is not used`;
    }
    const targets = await sync.targets(pkgs);
    if (targets === null) return `Genie could not work out what ${ing} ${tool} with pacman would change; nothing was ${verb === 'install' ? 'installed' : 'changed'}`;
    const moved = upgradedByInstall(targets, await sync.installed(), verb === 'update' ? pkgs : []);
    if (moved.length > 0) return `${ing} ${tool} with pacman would also upgrade ${moved.join(', ')}, a partial upgrade Arch does not support; update the whole system first (omarchy-update, or pacman -Syu), then ${verb} ${tool}`;
    return null;
}
