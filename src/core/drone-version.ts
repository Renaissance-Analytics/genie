import { REMOTE_PROTOCOL } from './remote-protocol.js';

/**
 * A DRONE ON AN OLDER GENIE, NAMED (Tynn #651; the owner's screenshot, 2026-11-12). A 61.2 Pilot connecting to a beta.60
 * drone stopped at "Open aion's Genie" with `"host.home" is not a bridge method`: the drone's validator refuses a method
 * it does not know (remote-protocol.ts `parseFrame`), and the Pilot showed that line as it was. The welcome already says
 * the drone's `build` and `protocol` (P10.1e); the Pilot reads them, and says what to do.
 *
 * REMOTE_PROTOCOL cannot tell beta.60 from beta.61 (both say 1): it is raised only for a change an older CLIENT cannot
 * read, and a method added is not one. So the Pilot also keeps the build it needs.
 */

/**
 * The oldest drone build with every bridge method this Pilot calls. beta.61 added `host.home` (104b37aa). Raise it when
 * the Pilot starts calling a method a released drone does not have; the fallback below catches one that was missed.
 */
export const DRONE_MIN_BUILD = '2.0.0-beta.61';

/** What a skewed drone is known to run (`null`: it did not say) and, when a call found it, the method it lacked. */
export interface DroneSkew {
    readonly build: string | null;
    readonly method?: string;
}

/** A build as shown: the version, without the host bundle's hash (`2.0.0-beta.60+0123abcd` → `2.0.0-beta.60`). */
export function shownBuild(build: string): string {
    return build.split('+')[0]!.trim();
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** semver order, prerelease parts compared number by number (beta.9 < beta.10), a release above its prereleases. */
export function compareVersions(a: string, b: string): number {
    const [coreA, preA] = splitVersion(a);
    const [coreB, preB] = splitVersion(b);
    for (let i = 0; i < 3; i++) {
        const d = (coreA[i] ?? 0) - (coreB[i] ?? 0);
        if (d !== 0) return d;
    }
    if (preA === null || preB === null) return preA === preB ? 0 : preA === null ? 1 : -1;
    const n = Math.max(preA.length, preB.length);
    for (let i = 0; i < n; i++) {
        const x = preA[i];
        const y = preB[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const nx = /^\d+$/.test(x) ? Number(x) : null;
        const ny = /^\d+$/.test(y) ? Number(y) : null;
        if (nx !== null && ny !== null) { if (nx !== ny) return nx - ny; continue; }
        if (nx !== null) return -1;
        if (ny !== null) return 1;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

function splitVersion(v: string): [number[], string[] | null] {
    const plain = shownBuild(v);
    const dash = plain.indexOf('-');
    const core = (dash === -1 ? plain : plain.slice(0, dash)).split('.').map((p) => Number(p) || 0);
    return [core, dash === -1 ? null : plain.slice(dash + 1).split('.')];
}

/**
 * Is the drone that said this welcome older than this Pilot needs? No build, or no protocol, is an older Genie (one from
 * before the handshake). A build that is not a version (`dev`, a local build) cannot be placed, and is not called older.
 */
export function welcomeSkew(welcome: { readonly protocol?: unknown; readonly build?: unknown }, min: string = DRONE_MIN_BUILD): DroneSkew | null {
    const build = typeof welcome.build === 'string' && welcome.build.trim() !== '' ? shownBuild(welcome.build) : null;
    if (build === null) return { build: null };
    if (typeof welcome.protocol !== 'number' || welcome.protocol < REMOTE_PROTOCOL) return { build };
    if (!VERSION.test(build)) return null;
    return compareVersions(build, min) < 0 ? { build } : null;
}

/** A drone's refusal of a call it does not know (`"host.home" is not a bridge method`): version skew, never a fault. */
export function refusalSkew(reason: string): { method: string } | null {
    const m = /^"([^"]+)" is not a bridge method$/.exec(reason.trim());
    return m ? { method: m[1]! } : null;
}

const who = (name: string | null): string => (name && name.trim() !== '' ? name.trim() : 'That machine');

/**
 * What the connect screen says. `pilot`: this Pilot's own build, the one to update to. The steps are the ones every
 * drone build has (the tray's and the menu's "Check for updates", beta.60 included).
 */
export function skewSentence(name: string | null, skew: { readonly drone: string | null; readonly pilot: string | null }): string {
    const machine = who(name);
    const runs = skew.drone === null ? `${machine} runs an older Genie.` : `${machine} runs Genie ${skew.drone}.`;
    const to = skew.pilot ? shownBuild(skew.pilot) : DRONE_MIN_BUILD;
    const where = name && name.trim() !== '' ? `On ${name.trim()}` : 'There';
    return `${runs} Update it to ${to} or later. ${where}, choose Check for updates in Genie's tray menu and install it. This window reconnects by itself.`;
}
