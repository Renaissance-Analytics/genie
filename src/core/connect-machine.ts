/**
 * THE WAY IN TO ANOTHER MACHINE (genie#1278 row C1; the owner: "I have no UI for connecting to any of my other registered
 * workstations"). One route, one name and one set of steps, shared by the title bar's button and its menu, the Command
 * Window and Settings → Remote access, so none of them drifts into a second name for the same thing.
 *
 * Genie 1 (v0.7.0-beta.342, renderer/pages/master.tsx `HostsButton` :4803 / `HostsPanel` :4879) put a stacked-servers
 * icon in the title bar, on the local window only (hidden in a host window, :4804-4805): a row per machine, Open is a
 * click, and an empty list said what to do on the other machine. Genie 2 had the same list four levels deep in Settings
 * and drew nothing when it was empty.
 */
import { mayBrowse, type WorkstationRole } from './workstation-role.js';

/** Settings → Remote access, where "Drive another machine" is. */
export const CONNECT_ROUTE = 'genie://settings/remote';

/** What the button and its menu are called. */
export const CONNECT_LABEL = 'Connect to another machine';

/** The Command Window's two ways in (the owner, 2026-10-27): paste a share link, or find my own workstations. */
export const OPEN_SHARE_LINK_ACTION = { id: 'open-share-link', label: 'Open a share link…' } as const;
export const CONNECT_WORKSTATIONS_ACTION = { id: 'connect-workstations', label: 'Connect to my workstations' } as const;

/**
 * What the Command Window offers, for the role Tynn gave this machine. A drone is offered neither: Tynn refuses a drone's
 * list and every connect-grant (genie#1278 S1, `RefuseDroneCaller`), including the one a share link leads to, so it
 * offers nothing it would only be refused. Signed out (no role) offers both; each then says to sign in.
 */
export function connectPaletteActions(role: WorkstationRole | null): ReadonlyArray<{ readonly id: string; readonly label: string }> {
    return mayBrowse(role) ? [OPEN_SHARE_LINK_ACTION, CONNECT_WORKSTATIONS_ACTION] : [];
}

/**
 * Where one connect action stands (the owner's rule, 2026-10-27: every action shows it is in progress with its step, then
 * success, or failure with Retry; never silent).
 */
export type ConnectProgress =
    | { readonly kind: 'idle' }
    | { readonly kind: 'working'; readonly step: string }
    | { readonly kind: 'done'; readonly note: string }
    | { readonly kind: 'failed'; readonly reason: string };

/**
 * A FRESH READ OF TYNN'S LIST (genie#1278, M0 finding 1: a share accepted after sign-in did not appear until a reload,
 * because the list was read at sign-in only). The menu and the Command Window read again each time they open; a fresh
 * answer replaces the list; a FAILED refresh keeps the last list on screen and gives its reason as the problem (with
 * Retry). With no list yet, a failure IS the list (its reason, then the steps).
 */
export type WorkstationRead<T> = { readonly ok: true; readonly workstations: readonly T[] } | { readonly ok: false; readonly reason: string };
export function mergeWorkstationRead<T>(prev: WorkstationRead<T> | null, next: WorkstationRead<T>): { list: WorkstationRead<T>; problem: string | null } {
    if (next.ok || prev === null || !prev.ok) return { list: next, problem: null };
    return { list: prev, problem: next.reason };
}

/**
 * What to do ON THE OTHER MACHINE when Tynn lists none. An empty list used to draw nothing, so "that machine is not
 * set up yet" read as "there is no such feature".
 */
export const CONNECT_EMPTY_GUIDANCE = 'Install Genie, sign in to Tynn, and turn on Remote access on the machine you want to reach.';
