/**
 * PILOT / DRONE, AS THIS GENIE SEES IT (genie#1278 W5; the owner, 2026-10-27: "no agent running on a workstation should
 * ever be able to change this setting by hacking the db or flipping a bool in a config file").
 *
 * The role lives in Tynn. Genie's ONLY input is Tynn's answer to `GET /api/v1/workstations/me`; nothing here reads a
 * setting, a file or a database value. Signed in to Tynn, anything but a plain "pilot" is a drone (an unreadable
 * answer, an unbound pairing, Tynn unreachable): fail closed. Signed out, this Genie is not on the Tynn network and
 * there is no Tynn role to apply.
 *
 * CONNECTING OUT IS NEVER JUDGED BY THE ROLE (Tynn #423; the owner, 2026-11-18: "Every host is effectively a drone and
 * every client a pilot"). Every desktop after an account's first registers as a drone, so a role gate on the way out
 * refused the owner's own second machine everything. Tynn decides who may connect (its entitlement: the owner, a share,
 * a link), and the host decides whom it admits (relay-grant.ts principalOf). What stays a pilot's: changing roles.
 */

export type WorkstationRole = 'pilot' | 'drone';

/** What Tynn said this pairing is, if anything. */
export type RoleReading = { readonly signedIn: false } | { readonly signedIn: true; readonly role: WorkstationRole | null };

/** The role in Tynn's `me` answer: exactly "pilot" or "drone", else no answer. */
export function parseMeRole(body: unknown): WorkstationRole | null {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    const role = (body as { role?: unknown }).role;
    return role === 'pilot' || role === 'drone' ? role : null;
}

/** Signed in: pilot only when Tynn says so, otherwise drone. Signed out: null (not on the Tynn network). */
export function effectiveRoleOf(reading: RoleReading): WorkstationRole | null {
    if (!reading.signedIn) return null;
    return reading.role === 'pilot' ? 'pilot' : 'drone';
}

/** The words a drone is refused a ROLE CHANGE with (Tynn keeps that a pilot's); null for a pilot or no role. */
export function droneRefusal(role: WorkstationRole | null): string | null {
    return role === 'drone'
        ? 'This workstation is a drone: only a pilot changes workstation roles. Its owner can make it a pilot in Tynn, with an authenticator code.'
        : null;
}
