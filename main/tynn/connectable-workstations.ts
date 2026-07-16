import type { ConnectableWorkstation } from '../backend/tynn';

/** Remove duplicate API rows and never offer this Genie as its own remote target. */
export function visibleConnectableWorkstations(
    workstations: ConnectableWorkstation[],
    localWorkstationId?: string,
): ConnectableWorkstation[] {
    const byId = new Map<string, ConnectableWorkstation>();

    for (const workstation of workstations) {
        if (workstation.id !== localWorkstationId) {
            byId.set(workstation.id, workstation);
        }
    }

    return [...byId.values()];
}
