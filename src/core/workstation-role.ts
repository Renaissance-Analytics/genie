/**
 * PILOT / DRONE, AS THIS GENIE SEES IT (genie#1278 W5; the owner, 2026-10-27: "no agent running on a workstation should
 * ever be able to change this setting by hacking the db or flipping a bool in a config file").
 *
 * The role lives in Tynn. Genie's ONLY input is Tynn's answer to `GET /api/v1/workstations/me`; nothing here reads a
 * setting, a file or a database value. Signed in to Tynn, anything but a plain "pilot" is a drone (an unreadable
 * answer, an unbound pairing, Tynn unreachable): fail closed. Signed out, this Genie is not on the Tynn network and
 * there is no Tynn role to apply.
 *
 * What the UI hides here is not the security boundary: Tynn refuses a drone's list, grants and shares (404), and the
 * relay refuses a member without a Tynn grant. A drone simply offers nothing it would only be refused.
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

/** May this Genie browse and open other workstations, and show what its network holds? */
export function mayBrowse(role: WorkstationRole | null): boolean {
    return role !== 'drone';
}

/** The words a drone answers a browse with; null when browsing is allowed. */
export function droneRefusal(role: WorkstationRole | null): string | null {
    return mayBrowse(role)
        ? null
        : 'This workstation is a drone: it cannot browse or open other workstations. Its owner can make it a pilot in Tynn, with an authenticator code.';
}
