import { launcherLink } from '../core/launcher-link.js';

/**
 * WHO RESTORES THE AGENTS AT BOOT (Tynn #1058 L6). What a drain recorded (`running-at-quit.json`, the agents cut off
 * mid-turn) is started again once, by ONE process. Without a launcher it is the window's boot, as since §7.6:
 * electron-updater's install always relaunched a window. The launcher swaps the host with no window open, so a host the
 * launcher started restores its own agents, and a window the launcher started does not: the record is read, not taken
 * (Tynn #754), so two restores of it could start an agent twice.
 */
export function restoresAtBoot(side: 'host' | 'window', env: Readonly<Record<string, string | undefined>>): boolean {
    const launched = launcherLink(env) !== null;
    return side === 'host' ? launched : !launched;
}
