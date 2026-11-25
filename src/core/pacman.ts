/**
 * PACMAN'S OUTPUT, READ (Tynn #968) — pure parsers over what pacman prints, captured on omarchy-genie, and the
 * partial-upgrade rule. Nothing here runs a process; main/pacman.ts asks pacman and hands the text here.
 */

/** The repositories Genie installs from: Arch's official ones. Never the AUR, never a third-party repository. */
export const OFFICIAL_REPOSITORIES: readonly string[] = ['core', 'extra', 'multilib'];

/** `pacman -Q`: `<name> <version>` per line. Warnings and errors (on any stream) are skipped. */
export function parsePacmanQ(output: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
        const m = /^([a-z0-9@._+-]+) (\S+)$/.exec(line.trim());
        if (m && !/^(warning|error):?$/.test(m[1]!)) out.set(m[1]!, m[2]!);
    }
    return out;
}

/** A pacman version as the tool itself reports it: `1:29.9.2-1` → `29.9.2` (no epoch, no pkgrel). */
export function pacmanVersion(version: string): string {
    return version.replace(/^\d+:/, '').replace(/-[^-]+$/, '');
}

/** `pacman -Si`: each package block's repository and version, by name. */
export function parsePacmanSi(output: string): Map<string, { repository: string; version: string }> {
    const out = new Map<string, { repository: string; version: string }>();
    for (const block of output.split(/\r?\n\s*\r?\n/)) {
        const field = (key: string) => new RegExp(`^${key}\\s*:\\s*(\\S+)`, 'm').exec(block)?.[1];
        const name = field('Name');
        const repository = field('Repository');
        const version = field('Version');
        if (name && repository && version) out.set(name, { repository, version });
    }
    return out;
}

/** `pacman -Sp --print-format '%n %v'`: the packages a transaction would install. */
export function parsePacmanTargets(output: string): Array<{ name: string; version: string }> {
    const out: Array<{ name: string; version: string }> = [];
    for (const line of output.split(/\r?\n/)) {
        const m = /^([a-z0-9@._+-]+) (\S+)$/.exec(line.trim());
        if (m && !/^(warning|error|::)/.test(line)) out.push({ name: m[1]!, version: m[2]! });
    }
    return out;
}

/**
 * THE PARTIAL-UPGRADE RULE. The installed packages a transaction would upgrade, other than the ones asked for (`own`:
 * an update moves its own package), as `name old → new`. Empty = the transaction only adds packages, so refreshing
 * the sync database for it upgrades nothing behind the person's back. Arch does not support a partial upgrade; an
 * install that would make one is refused by these names.
 */
export function upgradedByInstall(targets: ReadonlyArray<{ readonly name: string; readonly version: string }>, installed: ReadonlyMap<string, string>, own: readonly string[]): string[] {
    return targets
        .filter((t) => !own.includes(t.name) && installed.has(t.name) && installed.get(t.name) !== t.version)
        .map((t) => `${t.name} ${installed.get(t.name)} → ${t.version}`);
}
