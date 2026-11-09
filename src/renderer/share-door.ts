/**
 * WHICH SHARE LINKS A WINDOW OFFERS (Tynn #587). This machine's own while nothing is connected; the host's while its owner
 * drives it, because the host being shared makes the link. A guest is offered none, and never this machine's instead.
 */
export function shareDoor<S>(input: { connected: boolean; isOwner: boolean; own: S | undefined; remote: S | undefined }): S | undefined {
    if (!input.connected) return input.own;
    return input.isOwner ? input.remote : undefined;
}
