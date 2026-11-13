import type { SignalAction, UpdateSignalInput } from './deck.js';
import type { UpdateChangelog } from './update-notes.js';

/**
 * THE UPDATE, IN THE HEADER (the owner, 2026-10-13: "the update notice should be in the header, not buried in the deck
 * page"). Idle and none stay silent, as do background checks/failures with no known offer. A user request or an open
 * update window keeps checking/error visible; a known offer keeps its door to the reason and Retry.
 * The title bar draws it on every surface; the Deck no longer does — one notice, in one place.
 */
export interface UpdateChip {
    readonly phase: 'checking' | 'error' | 'available' | 'downloading' | 'downloaded' | 'installing';
    readonly label: string;
    /** The next step, or `null` while one is already under way. */
    readonly action: SignalAction | null;
    readonly version: string | null;
    readonly error?: string;
    /** What is in the update, for the update window (core/update-notes.ts); absent = not fetched. */
    readonly changelog?: UpdateChangelog | 'unavailable' | null;
}

export function updateChip(u: UpdateSignalInput | null | undefined): UpdateChip | null {
    if (!u) return null;
    const requested = u.userInitiated === true && (u.phase === 'checking' || u.phase === 'error');
    if (!u.version && !requested) return null;
    const chip = phaseChip(u);
    return chip ? { ...chip, version: u.version, ...(u.changelog !== undefined ? { changelog: u.changelog } : {}) } : null;
}

function phaseChip(u: UpdateSignalInput): Omit<UpdateChip, 'version' | 'changelog'> | null {
    switch (u.phase) {
        case 'checking':
            return { phase: 'checking', label: 'Checking for Genie updates…', action: null };
        case 'error':
            return { phase: 'error', label: 'Genie update failed — retry', action: 'update-check', error: u.error?.trim() || 'The update could not be checked or downloaded. Try again.' };
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
