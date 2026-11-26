/**
 * DOCKER ON LINUX (Tynn #970, from #958). Pure.
 *
 * Every hosted service engine runs on Docker, so on Linux Genie installs the DISTRO'S ENGINE (pacman `docker`, apt
 * `docker.io`, dnf `moby-engine`; Genie 1, v0.7.0-beta.342 toolchain-adapters.ts, did the same) and makes it usable in
 * the same prompt: `systemctl enable --now` of its socket and service, and the person's account added to the `docker`
 * group when it is not in it. An engine that is installed and cannot be used is worse than none, which is why Genie 2
 * once had no Linux row at all.
 *
 * And "installed" is a HEALTH, not a version (measured on omarchy-genie, VM job 1120-214302-7cadb6: docker 29.9.2, the
 * user in the group, `systemctl is-active docker` = inactive, and the row read "29.9.2" with no word of it). The health
 * comes from `docker info` run AS THE USER, `systemctl is-active docker.service`, and two group lists: the account's
 * (`id -nG <user>`, the group database) and THIS session's (`id -nG`, what Genie's own processes carry). A group added
 * during this login is in the first and not the second until the person logs in again.
 */

import type { ElevatedBatch, ElevatedStep } from './elevation.js';

/** What the docker row says beside its version. `running` says nothing extra. */
export type DockerDaemon = 'running' | 'not-running' | 'needs-login' | 'no-access';

/** The Linux account name usermod is given: a lowercase name as useradd makes them. No option, no shell, no path. */
const LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

export function isLinuxUserName(name: string): boolean {
    return LINUX_USER.test(name);
}

/** Who Genie runs as, and whether the group database has them in `docker`. */
export interface DockerAccount {
    readonly user: string;
    readonly inGroup: boolean;
}

const ENABLE: ElevatedStep = { command: 'systemctl', args: ['enable', '--now', 'docker.socket', 'docker.service'] };
const ENABLE_ITEM = 'enable and start docker.socket and docker.service';

const badUser = (user: string): { readonly refused: string } => ({ refused: `${JSON.stringify(user)} is not a Linux account name Genie will add to the docker group` });

/** The steps that make an installed engine usable: enable and start it, and the group when the account is not in it. */
export function dockerServiceSteps(account: DockerAccount): { readonly steps: readonly ElevatedStep[]; readonly items: readonly string[] } | { readonly refused: string } {
    if (!isLinuxUserName(account.user)) return badUser(account.user);
    if (account.inGroup) return { steps: [ENABLE], items: [ENABLE_ITEM] };
    return { steps: [ENABLE, { command: 'usermod', args: ['-aG', 'docker', account.user] }], items: [ENABLE_ITEM, `add ${account.user} to the docker group`] };
}

/** Start: ONE batch, under one prompt. */
export function dockerStartBatch(account: DockerAccount): ElevatedBatch | { readonly refused: string } {
    const s = dockerServiceSteps(account);
    return 'refused' in s ? s : { title: 'Start Docker', items: s.items, steps: s.steps };
}

/** `systemctl is-active`'s state word, or `null` (no systemd, or anything it does not say). */
export function parseSystemctlActive(output: string): 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'reloading' | null {
    const word = output.split(/\r?\n/)[0]?.trim() ?? '';
    return word === 'active' || word === 'inactive' || word === 'failed' || word === 'activating' || word === 'deactivating' || word === 'reloading' ? word : null;
}

/** `id -nG`'s group names. */
export function parseIdGroups(output: string): string[] {
    return output.split(/\s+/).filter(Boolean);
}

const DOWN = /cannot connect to the docker daemon|is the docker daemon running|connect: no such file or directory|connect: connection refused/i;
const DENIED = /permission denied.*docker/i;

/** The health, from what the machine said. `null` = not known, never a guess. */
export function dockerHealth(input: {
    readonly info: { readonly exitCode: number; readonly output: string };
    readonly active: string | null;
    readonly userGroups: readonly string[];
    readonly sessionGroups: readonly string[];
}): DockerDaemon | null {
    if (input.info.exitCode === 0) return 'running';
    if (DENIED.test(input.info.output)) {
        return input.userGroups.includes('docker') && !input.sessionGroups.includes('docker') ? 'needs-login' : 'no-access';
    }
    if (DOWN.test(input.info.output)) return 'not-running';
    if (input.active === 'inactive' || input.active === 'failed') return 'not-running';
    return null;
}

/** The row's words for each health but `running`. */
export const DOCKER_DAEMON_WORDS: Readonly<Record<Exclude<DockerDaemon, 'running'>, { readonly badge: string; readonly why: string }>> = {
    'not-running': { badge: 'Not running', why: 'Docker is installed and its daemon is off, so no service can start. Start enables it and starts it.' },
    'no-access': { badge: 'No access', why: 'Docker runs, and this account is not in the docker group. Start adds it.' },
    'needs-login': { badge: 'Needs a new login', why: 'You were added to the docker group: log out and back in so Genie and its services can use it.' },
};
