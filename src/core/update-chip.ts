import type { SignalAction, UpdateSignalInput } from './deck.js';

/**
 * THE UPDATE, IN THE HEADER (the owner, 2026-10-13: "the update notice should be in the header, not buried in the deck
 * page"). Silent in idle / checking / none / error: there is nothing to act on, and "no update" is furniture. From
 * `available` on it is true, and its door is the next step rather than a place: download, then restart to install.
 * The title bar draws it on every surface; the Deck no longer does — one notice, in one place.
 */
export interface UpdateChip {
    readonly phase: 'available' | 'downloading' | 'downloaded' | 'installing';
    readonly label: string;
    /** The next step, or `null` while one is already under way. */
    readonly action: SignalAction | null;
    readonly version: string;
    /** What the version brings — its release notes' "What's new" (Tynn #762) — shown on hover; absent = none. */
    readonly notes?: string;
}

export function updateChip(u: UpdateSignalInput | null | undefined): UpdateChip | null {
    if (!u || !u.version) return null;
    const chip = phaseChip(u);
    return chip ? { ...chip, version: u.version, ...(u.notes ? { notes: u.notes } : {}) } : null;
}

function phaseChip(u: UpdateSignalInput): Omit<UpdateChip, 'version' | 'notes'> | null {
    switch (u.phase) {
        case 'available':
            return { phase: 'available', label: `Genie ${u.version} is available — download`, action: 'update-download' };
        case 'downloading':
            return { phase: 'downloading', label: `Downloading Genie ${u.version}${u.percent === null ? '' : ` ${Math.round(u.percent)}%`}`, action: null };
        case 'downloaded':
            return { phase: 'downloaded', label: `Genie ${u.version} is ready — restart to install`, action: 'update-install' };
        case 'installing':
            return { phase: 'installing', label: `Installing Genie ${u.version}…`, action: null };
        default:
            return null;
    }
}
