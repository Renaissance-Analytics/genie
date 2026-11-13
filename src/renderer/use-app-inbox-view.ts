import { useEffect, useState } from 'react';
import type { AppInboxBridge } from './bridge.js';
import type { AppInboxCardProps, AppInboxCardState } from './components/AppInboxCard.js';

export interface AppInboxView {
    workspaceId: string;
    state: AppInboxCardState | null;
    busy: AppInboxCardProps['busy'];
    revealed: AppInboxCardProps['revealed'];
    outcome: AppInboxCardProps['outcome'];
}

/** The workspace's initial local-only app-key read; the caller still owns all key-changing actions. */
export function useAppInboxView(appInboxBridge: AppInboxBridge | undefined, workspaceId: string | null, refresh: unknown) {
    const [appInboxView, setAppInboxView] = useState<AppInboxView | null>(null);
    useEffect(() => {
        if (!appInboxBridge || !workspaceId) { setAppInboxView(null); return; }
        let live = true;
        setAppInboxView({ workspaceId, state: null, busy: null, revealed: null, outcome: null });
        void appInboxBridge.state(workspaceId).then((r) => {
            if (live) setAppInboxView((v) => (v && v.workspaceId === workspaceId ? { ...v, state: r.ok ? r.state : null, outcome: r.ok ? v.outcome : { ok: false, text: r.reason } } : v));
        });
        return () => { live = false; };
    }, [appInboxBridge, workspaceId, refresh]);
    return [appInboxView, setAppInboxView] as const;
}
