import { createContext, useContext } from 'react';
import { NO_CUES, type SoundCue, type SoundCues } from '../core/sound-cues.js';

/**
 * WHAT SOUNDED, FOR EVERY SURFACE THAT SHOWS IT (Tynn #1057): the sidebar's rows, the Dashboard's activity and each
 * workspace dashboard's read the one list App keeps (core/sound-cues.ts), through this context, so no surface is handed
 * it through a chain of props it could drop.
 */
export interface SoundCuesView {
    readonly cues: SoundCues;
    /** Genie's own agent (its rail row is `genie`); `null` = none here. */
    readonly osAgentId: string | null;
    /** Open what a cue is about: its agent, else its workspace, else the Dashboard. Opening marks it seen. */
    readonly onOpen?: ((cue: SoundCue) => void) | undefined;
    /** Mark one cue seen, where it is shown (the Deck's rule: cleared without navigating). */
    readonly onSee?: ((id: string) => void) | undefined;
    /** Mark every cue seen. */
    readonly onSeeAll?: (() => void) | undefined;
}

export const NO_SOUND_CUES: SoundCuesView = Object.freeze({ cues: NO_CUES, osAgentId: null });

export const SoundCuesContext = createContext<SoundCuesView>(NO_SOUND_CUES);

export function useSoundCues(): SoundCuesView {
    return useContext(SoundCuesContext);
}
