import type { Headroom, ReadingStamp } from './headroom.js';

/** A reading held while Genie reads who is signed in, given back stamped with the account found. */
export interface HeldReading { readonly room: Headroom; readonly stamp: ReadingStamp }

/** STUB (RED): passes every reading through as stamped. */
export class ReadingAttribution {
    signedIn(_provider: string): void {}
    readStart(_provider: string, _activeId: string): void {}
    stamp(_provider: string, _room: Headroom, stamp: ReadingStamp): ReadingStamp | null { return stamp; }
    readEnd(_provider: string, _activeId: string): { readonly changed: boolean; readonly held: HeldReading | null } { return { changed: false, held: null }; }
}
