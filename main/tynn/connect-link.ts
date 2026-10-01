/**
 * What somebody just pasted into "Connect to…".
 *
 * The owner wants one box that takes *"any genie link"*. There are two, and they
 * resolve through completely different paths:
 *
 *  - a Tynn **invite url** (`<tynn>/invites/accept/<token>`), which has to be
 *    opened and redeemed by a signed-in person before this machine holds any
 *    entitlement at all;
 *  - a **`genie://workstation/open`** deep link, which is what the redemption
 *    page hands back afterwards and which Genie can act on directly.
 *
 * Guessing is bad in both directions: an invite treated as a deep link tries to
 * connect to a workstation whose id is a token, and a deep link treated as a url
 * opens a browser for nothing.
 *
 * The HOST CHECK is load-bearing rather than tidiness. This box opens what it is
 * given, so accepting any `https` url would make it a way to get Genie to open an
 * arbitrary page on somebody's behalf — and a link to a Tynn that is not the one
 * this Genie is signed in to cannot be redeemed here regardless.
 *
 * Pure, so the renderer and main can share it and so every refusal is a sentence
 * rather than a silent no-op. "I do not recognise this" is the answer this box
 * gives most often — it is where somebody pastes the wrong half of an email.
 */
export type ConnectLink =
    /** A Tynn invite to open and redeem in a browser. */
    | { kind: 'invite'; url: string }
    /** An entitlement this machine already holds — connect straight away. */
    | { kind: 'workstation'; workstationId: string; name?: string }
    /** Not something this box can act on, and why. */
    | { kind: 'unknown'; reason: string };

const INVITE_PATH = /^\/invites\/accept\/([^/]+)\/?$/;

export function classifyConnectLink(raw: string, tynnHost: string): ConnectLink {
    const text = (raw ?? '').trim();
    if (!text) {
        return { kind: 'unknown', reason: 'Paste a Genie link to connect to.' };
    }

    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return {
            kind: 'unknown',
            reason: 'That does not look like a link. Paste the whole thing, starting with https:// or genie://.',
        };
    }

    if (url.protocol === 'genie:') {
        // `genie://oauth/callback?token=…` is also one of ours and carries a
        // session token, so this matches the workstation link exactly rather than
        // accepting any `genie://`.
        if (url.host !== 'workstation' || url.pathname.replace(/\/$/, '') !== '/open') {
            return { kind: 'unknown', reason: 'That is a Genie link, but not one that connects to anything.' };
        }
        const workstationId = url.searchParams.get('id')?.trim();
        if (!workstationId) {
            return { kind: 'unknown', reason: 'That workstation link is missing its id.' };
        }
        const name = url.searchParams.get('name')?.trim();
        return name ? { kind: 'workstation', workstationId, name } : { kind: 'workstation', workstationId };
    }

    let expected: string;
    try {
        expected = new URL(tynnHost).host;
    } catch {
        expected = tynnHost;
    }
    if (url.host !== expected) {
        return {
            kind: 'unknown',
            reason: `That link is for ${url.host}, and this Genie is signed in to ${expected}.`,
        };
    }

    // Matching the host is necessary and NOT sufficient — otherwise this would
    // open any page on Tynn.
    const token = INVITE_PATH.exec(url.pathname)?.[1];
    if (!token) {
        return { kind: 'unknown', reason: 'That is a Tynn link, but not a share link.' };
    }

    return { kind: 'invite', url: url.toString() };
}
