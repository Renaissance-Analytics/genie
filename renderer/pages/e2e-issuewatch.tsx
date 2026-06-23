import { useEffect, useState } from 'react';
import IssueWatchFlyout from '../components/Master/IssueWatchFlyout';

/**
 * E2E harness page for the Issue Watch flyout. NOT part of the product UI — it
 * exists only so a Playwright Electron test can exercise the REAL
 * IssueWatchFlyout against the GENIE_E2E-mocked IPC surface (see main/e2e/mock.ts),
 * without standing up the whole master window (which needs a registered
 * workspace, an active selection, etc.).
 *
 * It mounts the flyout OPEN, pinned to a fixed workspace id. The component is
 * unchanged and drives the same `github:*` / `issue-watch:*` channels it does in
 * production — here those channels are answered by the scriptable mock, so the
 * test can reproduce the dead-session reconnect flow deterministically.
 *
 * This page is harmless in a normal build (it's just another exported route),
 * but it's only useful when the main process is in E2E mode.
 */
export default function E2EIssueWatch() {
    // Render only after mount so window.genie (preload) is definitely attached
    // before the flyout's open-effect fires its first IPC calls.
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);

    return (
        <div data-testid="e2e-root" style={{ height: '100vh', background: '#0a0a0c' }}>
            {ready && (
                <IssueWatchFlyout
                    open
                    workspaceId="e2e-workspace"
                    onClose={() => {
                        /* no-op: the harness keeps it open */
                    }}
                    onResolveGithub={() => {
                        /* no-op in the harness */
                    }}
                />
            )}
        </div>
    );
}
