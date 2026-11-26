/**
 * WHAT SOMEBODY PASTED INTO "Open a share link…" (genie#1278 row C1). Genie 1's `main/tynn/connect-link.ts` and
 * `main/tynn/connect-dispatch.ts` (v0.7.0-beta.342), ported.
 *
 * Two links, two different paths:
 *  - a Tynn **invite URL** (`<tynn>/invites/accept/<token>`), the share link Tynn mints (`storeShareLink`). It must be
 *    opened and accepted by a signed-in person before this machine holds any entitlement, so it opens in the browser;
 *    Tynn's page then opens `genie://workstation/open?id=…`, which main already handles (`openGenieUrl`).
 *  - a **`genie://workstation/open`** link: an entitlement already held, so the workstation opens straight away.
 *
 * The HOST CHECK is load-bearing: this box opens what it is given, so accepting any https URL would make it a way to get
 * Genie to open an arbitrary page, and a link for another Tynn cannot be redeemed here anyway.
 *
 * Share access stays separate from the owner's own machines (design §5): a guest's grant is scoped by Tynn, never
 * `src = owner`. Nothing here decides access; Tynn and the host do.
 */
import { workstationOpenFrom } from './tynn-sign-in.js';
import type { WorkstationRole } from './workstation-role.js';

export type ConnectLink =
    | { readonly kind: 'invite'; readonly url: string }
    | { readonly kind: 'workstation'; readonly workstationId: string; readonly name?: string }
    | { readonly kind: 'unknown'; readonly reason: string };

const INVITE_PATH = /^\/invites\/accept\/([^/]+)\/?$/;

export function classifyConnectLink(raw: string, tynnHost: string): ConnectLink {
    const text = (raw ?? '').trim();
    if (!text) return { kind: 'unknown', reason: 'Paste a share link to open.' };
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return { kind: 'unknown', reason: 'That does not look like a link. Paste the whole thing, starting with https:// or genie://.' };
    }
    if (url.protocol === 'genie:') {
        // `genie://` also carries sign-in links with a session code, so only the workstation link is accepted, through the
        // same parser (and id rule) as main's genie:// handler.
        const open = workstationOpenFrom(text);
        if (open === null) return { kind: 'unknown', reason: 'That is a Genie link, but not one that opens a workstation.' };
        return open.name ? { kind: 'workstation', workstationId: open.id, name: open.name } : { kind: 'workstation', workstationId: open.id };
    }
    let expected: string;
    try {
        expected = new URL(tynnHost).host;
    } catch {
        expected = tynnHost;
    }
    if (url.host !== expected) return { kind: 'unknown', reason: `That link is for ${url.host}, and this Genie is signed in to ${expected}.` };
    // The host matching is necessary and NOT sufficient: otherwise this would open any page on Tynn.
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'unknown', reason: 'That is not a share link.' };
    if (!INVITE_PATH.exec(url.pathname)?.[1]) return { kind: 'unknown', reason: 'That is a Tynn link, but not a share link.' };
    return { kind: 'invite', url: url.toString() };
}

export interface ConnectLinkDeps {
    /** Open an https URL in the person's browser; false when it could not. */
    openExternal(url: string): Promise<boolean>;
    /** Open a Tynn workstation in its own window, over the relay. */
    openWorkstation(workstationId: string, name?: string | null): void;
}

/** What the host decided a pasted link is (Tynn #896, 2b-4): a refusal in words, or the one thing to open. */
export type ConnectLinkDecision =
    | { readonly ok: false; readonly note: string }
    | { readonly ok: true; readonly link: Exclude<ConnectLink, { kind: 'unknown' }> };

/**
 * DECIDE (the host's, `tynnNetwork.classifyLink`): `tynnHost` null = signed out of Tynn. The role is NOT a gate here
 * (Tynn #963): a share link is the way a drone opens another host (the owner: remote access is never refused any
 * feature), and Tynn decides the grant the link leads to. An invite only opens in the browser; it dials nothing.
 */
export function decideConnectLink(pasted: string, tynnHost: string | null, _role?: WorkstationRole | null): ConnectLinkDecision {
    if (tynnHost === null) return { ok: false, note: 'Sign in to Tynn first: a share link opens through your Tynn account.' };
    const link = classifyConnectLink(pasted, tynnHost);
    if (link.kind === 'unknown') return { ok: false, note: link.reason };
    return { ok: true, link };
}

/**
 * The host's answer as the window reads it, strictly: only an http(s) invite or a workstation id the genie:// handler
 * would accept is ever acted on; anything else is null (not acted on). The window opens what it is told, so this is the
 * check that a page or a file cannot be opened through it.
 */
export function connectLinkDecisionOf(raw: unknown): ConnectLinkDecision | null {
    if (typeof raw !== 'object' || raw === null) return null;
    const r = raw as { ok?: unknown; note?: unknown; link?: unknown };
    if (r.ok === false) return typeof r.note === 'string' ? { ok: false, note: r.note } : null;
    if (r.ok !== true || typeof r.link !== 'object' || r.link === null) return null;
    const link = r.link as { kind?: unknown; url?: unknown; workstationId?: unknown; name?: unknown };
    if (link.kind === 'invite') {
        if (typeof link.url !== 'string') return null;
        try {
            const url = new URL(link.url);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        } catch {
            return null;
        }
        return { ok: true, link: { kind: 'invite', url: link.url } };
    }
    if (link.kind === 'workstation') {
        if (typeof link.workstationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(link.workstationId)) return null;
        return { ok: true, link: typeof link.name === 'string' && link.name !== '' ? { kind: 'workstation', workstationId: link.workstationId, name: link.name } : { kind: 'workstation', workstationId: link.workstationId } };
    }
    return null;
}

/** ACT (the window's own): the person's browser for an invite, the workstation's window. Always answers with a sentence. */
export async function actOnConnectLink(decision: ConnectLinkDecision, deps: ConnectLinkDeps): Promise<{ ok: boolean; note: string }> {
    if (!decision.ok) return { ok: false, note: decision.note };
    const link = decision.link;
    try {
        if (link.kind === 'invite') {
            return (await deps.openExternal(link.url))
                ? { ok: true, note: 'Opened the invite in your browser: accept it there and Genie opens the machine.' }
                : { ok: false, note: 'Could not open that link in your browser.' };
        }
        deps.openWorkstation(link.workstationId, link.name ?? null);
        return { ok: true, note: `Opening ${link.name ?? 'the workstation'} in its own window` };
    } catch (error) {
        return { ok: false, note: error instanceof Error ? error.message : String(error) };
    }
}

/** Decide and act in one process (what Genie 1 did, and the tests' reference). */
export async function dispatchConnectLink(pasted: string, tynnHost: string | null, role: WorkstationRole | null, deps: ConnectLinkDeps): Promise<{ ok: boolean; note: string }> {
    return actOnConnectLink(decideConnectLink(pasted, tynnHost, role), deps);
}
