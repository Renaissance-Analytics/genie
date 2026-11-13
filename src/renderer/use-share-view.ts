import { useState } from 'react';
import type { ShareLink } from '../main/tynn-share-links.js';
import type { TynnNetworkBridge } from './relay-transport.js';
import type { ShareWorkspaceModalProps } from './components/ShareWorkspaceModal.js';

export interface ShareView {
    workspaceId: string | null;
    name: string;
    links: ShareLink[] | null;
    minted: ShareLink | null;
    problem: string | null;
    busy: boolean;
}

/** The selected owner's share list and create-link request; selection/authorization stay with the caller. */
export function useShareView(shares: TynnNetworkBridge['shares']) {
    const [share, setShare] = useState<ShareView | null>(null);
    const readShares = (forWorkspace: string | null) => {
        const failed = (error: unknown): void => {
            try { console.error('[shares] Could not read share links.', error); }
            catch { /* Diagnostic reporting must not reject the read. */ }
            setShare((s) => (s && s.workspaceId === forWorkspace ? { ...s, problem: 'Share links could not be loaded. Reopen this panel to try again.' } : s));
        };
        try {
            void shares?.list(forWorkspace).then((r) => setShare((s) => (s && s.workspaceId === forWorkspace ? { ...s, links: r.ok ? r.links : s.links, problem: r.ok ? s.problem : r.reason } : s))).catch(failed);
        } catch (error) { failed(error); }
    };
    const mintShare = (input: Parameters<ShareWorkspaceModalProps['onMint']>[0]) => {
        if (!share || !shares) return;
        const forWorkspace = share.workspaceId;
        const failed = (error: unknown): void => {
            try { console.error('[shares] Did not receive a newly created share link.', error); }
            catch { /* Diagnostic reporting must not reject the action. */ }
            // Delivery is uncertain. Say so without inventing a URL or replaying the creation request.
            setShare((s) => (s && s.workspaceId === forWorkspace ? { ...s, busy: false, minted: null, problem: 'Genie did not receive a new share link. Reopen this panel to check existing links before trying again.' } : s));
        };
        setShare((s) => (s ? { ...s, busy: true, problem: null, minted: null } : s));
        try {
            void shares.mint({ workspaceId: input.whole ? null : forWorkspace, capability: input.capability, expiresInDays: input.expiresInDays }).then((r) => {
                setShare((s) => (s && s.workspaceId === forWorkspace ? { ...s, busy: false, minted: r.ok ? r.link : null, problem: r.ok ? null : r.reason } : s));
                if (r.ok) readShares(forWorkspace);
            }).catch(failed);
        } catch (error) { failed(error); }
    };
    return { share, setShare, readShares, mintShare };
}
