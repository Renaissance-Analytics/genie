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

/** A local Tynn registration is represented by discovery, never as cloud. */
export function cloudWorkstationsOnly<T extends Pick<ConnectableWorkstation, 'is_local'>>(
    workstations: readonly T[],
): T[] {
    return workstations.filter((workstation) => !workstation.is_local);
}
