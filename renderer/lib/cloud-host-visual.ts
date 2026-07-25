import type { ConnectableWorkstation } from './genie';

export interface CloudHostVisual {
    color: 'green' | 'yellow' | 'red' | 'blue';
    pulse: boolean;
    title: string;
}

const UPDATE_STATUSES = new Set(['updating', 'upgrading', 'rotating']);

/** Status treatment for the cloud glyph in the unified Hosts picker. */
export function cloudHostVisual(
    workstation: Pick<ConnectableWorkstation, 'status' | 'connectable'>,
    connected: boolean,
    activeTerminals = false,
): CloudHostVisual {
    const status = workstation.status.trim().toLowerCase();
    if (UPDATE_STATUSES.has(status)) {
        return { color: 'blue', pulse: true, title: 'Installing an update' };
    }
    if (activeTerminals) {
        return { color: 'green', pulse: true, title: 'Connected with active terminals' };
    }
    if (connected) {
        return { color: 'green', pulse: false, title: 'Connected' };
    }
    if (status === 'active' && workstation.connectable) {
        return { color: 'yellow', pulse: false, title: 'Online — not connected' };
    }
    return { color: 'red', pulse: false, title: 'Offline or unavailable' };
}

/** Return only cloud rows that are not this Genie and are not already represented
 * by the desktop host discovery list. Tynn can return the same workstation more
 * than once through owner/grant paths, so id de-duplication happens here too. */
export function unifiedCloudWorkstations<
    T extends Pick<ConnectableWorkstation, 'id' | 'name' | 'is_local'>,
>(
    workstations: readonly T[],
    desktopHosts: ReadonlyArray<{ name?: string; hostname: string }>,
    localWorkstationId?: string | null,
): T[] {
    const desktopNames = new Set(
        desktopHosts
            .flatMap((host) => [host.name, host.hostname])
            .filter((name): name is string => !!name)
            .map((name) => name.trim().toLocaleLowerCase()),
    );
    const seen = new Set<string>();
    return workstations.filter((workstation) => {
        if (workstation.is_local || workstation.id === localWorkstationId) {
            return false;
        }
        if (seen.has(workstation.id)) return false;
        seen.add(workstation.id);
        return !desktopNames.has(workstation.name.trim().toLocaleLowerCase());
    });
}
