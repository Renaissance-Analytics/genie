/**
 * WORDING TYNN'S REFUSAL FROM A FRESH ROLE (genie#1278, M0 finding 3).
 *
 * Genie reads this machine's role from Tynn at launch and every 5 minutes. In the two-VM proof a machine demoted to
 * drone still believed it was a pilot, asked Tynn for a grant, got Tynn's 404 (Tynn answers every refusal with 404 and
 * never says why) and told the person to "sign in to Tynn" — the wrong way to send them. So when Tynn refuses this
 * caller, the role is read again from Tynn FIRST, and a drone is told it is a drone. The re-read also closes the
 * 5-minute lag at the moment it matters. Anything else — success, Tynn unreachable, a 500 — passes through untouched,
 * without a re-read.
 */
import { droneRefusal, type WorkstationRole } from '../core/workstation-role.js';

export async function wordTynnRefusal<R extends { ok: boolean; refusedByTynn?: true }>(
    result: R,
    rereadRole: () => Promise<WorkstationRole | null>,
): Promise<R | { ok: false; reason: string }> {
    if (result.ok || result.refusedByTynn !== true) return result;
    const refused = droneRefusal(await rereadRole());
    return refused ? { ok: false, reason: refused } : result;
}
