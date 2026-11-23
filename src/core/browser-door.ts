/**
 * WHAT THE GENIE BROWSER SAYS OF ITS FRONT DOOR (Tynn #1046 D2). The front door is genie-host's own: it stays up with no
 * window, so a window going says nothing here. It is down only when that host has no front door running (no hosting), and
 * then the browser says so, in these words. Pages already loaded stay as they are.
 */
export const DOOR_DOWN = 'Genie sites can’t load: Genie’s host has no front door running. Pages already here stay as they are.';

/** The browser's notice for its front door: none while it is up. */
export function doorNotice(up: boolean): string | null {
    return up ? null : DOOR_DOWN;
}
