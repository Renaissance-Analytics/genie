import { classifyConnectLink } from './connect-link';

/**
 * What to DO with a link somebody pasted into "Connect to…".
 *
 * `classifyConnectLink` says which kind it is; this routes it, and the split is
 * the part worth having in one tested place rather than inline in a click
 * handler:
 *
 *  - an INVITE has to leave Genie. It is redeemed by a signed-in person on
 *    Tynn's own page, and until somebody accepts it this machine holds no
 *    entitlement at all — there is nothing here to act on.
 *  - a `genie://` link must NOT leave Genie. `shell:open-external` deliberately
 *    refuses any protocol that is not http(s), and rightly so: handing arbitrary
 *    schemes to the OS is how a paste turns into a launched application. It goes
 *    to the same `handleGenieUrl` the OS protocol handler uses, so a pasted link
 *    and a clicked one take one code path.
 *
 * Routing either the other way fails SILENTLY, which is the worst outcome for a
 * box whose whole job is to say whether something worked.
 *
 * Never throws: the caller is a click handler in a flyout, and an exception over
 * a bad paste would take the panel down.
 */
export interface ConnectDispatchDeps {
    /** Open an http(s) URL in the machine browser. Reports refusal. */
    openExternal: (url: string) => Promise<{ ok: boolean }>;
    /** Hand a `genie://` URL to Genie's own protocol router. */
    openGenieUrl: (url: string) => Promise<void>;
}

export interface ConnectDispatchResult {
    ok: boolean;
    /** What to show the person who pasted it — always something. */
    note: string;
}

export async function dispatchConnectLink(
    pasted: string,
    tynnHost: string,
    deps: ConnectDispatchDeps,
): Promise<ConnectDispatchResult> {
    const link = classifyConnectLink(pasted, tynnHost);
    if (link.kind === 'unknown') return { ok: false, note: link.reason };

    try {
        if (link.kind === 'invite') {
            const opened = await deps.openExternal(link.url);
            return opened.ok
                ? {
                      ok: true,
                      note: 'Opened the invite — accept it there and Genie will take it from here.',
                  }
                : { ok: false, note: 'Could not open that link in your browser.' };
        }

        await deps.openGenieUrl(
            `genie://workstation/open?id=${encodeURIComponent(link.workstationId)}`,
        );
        return {
            ok: true,
            note: link.name ? `Connecting to ${link.name}…` : 'Connecting…',
        };
    } catch (e) {
        return { ok: false, note: e instanceof Error ? e.message : String(e) };
    }
}
