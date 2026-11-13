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
        let reading = false;
        const failed = (error: unknown): void => {
            reading = false;
            if (!live) return;
            try { console.error('[app inbox] Could not read apps and scripts.', error); }
            catch { /* Diagnostic reporting must not reject the read. */ }
            setAppInboxView((v) => (v && v.workspaceId === workspaceId ? { ...v, outcome: { ok: false, text: 'Apps and scripts could not be loaded. Try again.', retry: read } } : v));
        };
        const read = (): void => {
            if (!live || reading) return;
            reading = true;
            setAppInboxView({ workspaceId, state: null, busy: null, revealed: null, outcome: null });
            try {
                void appInboxBridge.state(workspaceId).then((r) => {
                    reading = false;
                    if (live) setAppInboxView((v) => (v && v.workspaceId === workspaceId ? { ...v, state: r.ok ? r.state : null, outcome: r.ok ? v.outcome : { ok: false, text: r.reason, retry: read } } : v));
                }).catch(failed);
            } catch (error) { failed(error); }
        };
        read();
        return () => { live = false; };
    }, [appInboxBridge, workspaceId, refresh]);
    return [appInboxView, setAppInboxView] as const;
}
