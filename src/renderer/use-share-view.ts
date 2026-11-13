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
        void shares?.list(forWorkspace).then((r) => setShare((s) => (s && s.workspaceId === forWorkspace ? { ...s, links: r.ok ? r.links : [], problem: r.ok ? s.problem : r.reason } : s)));
    };
    const mintShare = (input: Parameters<ShareWorkspaceModalProps['onMint']>[0]) => {
        if (!share || !shares) return;
        const forWorkspace = share.workspaceId;
        setShare((s) => (s ? { ...s, busy: true, problem: null, minted: null } : s));
        void shares.mint({ workspaceId: input.whole ? null : forWorkspace, capability: input.capability, expiresInDays: input.expiresInDays }).then((r) => {
            setShare((s) => (s && s.workspaceId === forWorkspace ? { ...s, busy: false, minted: r.ok ? r.link : null, problem: r.ok ? null : r.reason } : s));
            if (r.ok) readShares(forWorkspace);
        });
    };
    return { share, setShare, readShares, mintShare };
}
