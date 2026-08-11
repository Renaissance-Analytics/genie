/**
 * Pure view logic for Settings → Plugins.
 *
 * The installed list collapses to one summary line per plugin, so what that line
 * says is a real decision: it has to carry enough that you never expand a row
 * just to find out whether a plugin is doing anything. Kept framework-free here
 * so it is unit-testable (the renderer has no DOM harness).
 */

import type { InstalledPluginView } from './genie';

function plural(n: number, noun: string): string {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The one-line summary under a COLLAPSED plugin's name: its version, namespace,
 * what it contributes, and — only when something is missing — how many of its
 * declared permissions are actually granted. A half-granted plugin looks enabled
 * but silently can't do its job, and once the row is collapsed the permission
 * switches are out of sight, so that gap has to survive the collapse.
 */
export function pluginSummaryLine(plugin: InstalledPluginView): string {
    const parts = [`v${plugin.version}`, plugin.namespace];

    if (plugin.tools.length > 0) parts.push(plural(plugin.tools.length, 'tool'));
    if (plugin.editors.length > 0) parts.push(plural(plugin.editors.length, 'editor'));
    if (plugin.panels.length > 0) parts.push(plural(plugin.panels.length, 'panel'));

    const declared = plugin.permissions.length;
    const granted = plugin.permissions.filter((p) => p.granted).length;
    if (declared > 0 && granted < declared) parts.push(`${granted} of ${declared} permissions granted`);

    return parts.join(' · ');
}

/**
 * How long ago a marketplace's index was last read. A cached plugin list is only
 * as current as its last fetch, and a list with no age on it reads as live when
 * it isn't — which is exactly how a newly published plugin goes unnoticed.
 */
export function checkedAgoLabel(isoTimestamp: string | null, nowMs: number): string {
    if (!isoTimestamp) return 'Never checked';
    const checkedAt = Date.parse(isoTimestamp);
    if (!Number.isFinite(checkedAt)) return 'Never checked';

    const ms = Math.max(0, nowMs - checkedAt);
    if (ms < 60_000) return 'Checked just now';
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `Checked ${plural(minutes, 'minute')} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Checked ${plural(hours, 'hour')} ago`;
    return `Checked ${plural(Math.floor(hours / 24), 'day')} ago`;
}
