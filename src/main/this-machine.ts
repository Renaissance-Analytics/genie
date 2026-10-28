/**
 * WHICH TYNN RECORDS ARE THIS MACHINE (the owner, 2026-10-28: "it shouldn't show the machine I am currently on").
 *
 * One machine can hold more than one Tynn identity, and "Your workstations" must leave out every one of them:
 *
 * - the one this launch registered (`registered`);
 * - the one Genie 2 has STORED (`~/.genie/workstation.json`) — this machine's even when this launch's registration has
 *   not finished, or failed (Tynn unreachable at boot, signed in later). beta.50 left out only `registered`, so before
 *   a finished registration this machine listed itself;
 * - the one GENIE 1 registered (`settings.workstation_id` in its genie.db, under the userData Genie 2 shares). Genie 1
 *   never sent a machine key (genie#1278 W2 came after it), so Tynn cannot tell that record and Genie 2's are one
 *   machine, and Tynn's `connectable` lists both. Measured on the owner's desktop, 2026-10-28: Genie 1's `01kxw523…` and
 *   Genie 2's `01m5epvk…`, both "AlphaR".
 *
 * Identity, never name: another machine may share this one's hostname.
 */
export function thisMachineWorkstationIds(input: {
    registered: string | null;
    stored: string | null;
    v1Settings: Readonly<Record<string, string>> | null;
}): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const id of [input.registered, input.stored, input.v1Settings?.['workstation_id'] ?? null]) {
        if (typeof id === 'string' && id.trim() !== '') ids.add(id.trim());
    }
    return ids;
}
