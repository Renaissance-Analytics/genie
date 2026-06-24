import { useEffect, useState } from 'react';
import GithubCapabilitiesFlyout from '../components/Master/GithubCapabilitiesFlyout';
import { useGithubCapabilities } from '../lib/githubCapabilities';

/**
 * E2E harness page for the GitHub permissions RESOLVE flyout. NOT product UI —
 * it exists so a Playwright Electron test can drive the REAL
 * GithubCapabilitiesFlyout against the GENIE_E2E-mocked IPC surface (see
 * main/e2e/mock.ts), without standing up the whole master window.
 *
 * It reads the live capability status via the same `useGithubCapabilities` hook
 * the product uses (which the mock answers from its scriptable state), then
 * mounts the flyout OPEN with that status. The test scripts a missing `contents`
 * permission with a non-granting installation and asserts the per-install
 * approval list + the "add in App settings" deep-link render.
 */
export default function E2EGhCaps() {
    // Render only after mount so window.genie (preload) is attached before the
    // hook's first IPC call.
    const [ready, setReady] = useState(false);
    useEffect(() => setReady(true), []);
    const { caps } = useGithubCapabilities();

    return (
        <div data-testid="e2e-root" style={{ height: '100vh', background: '#0a0a0c' }}>
            {ready && (
                <GithubCapabilitiesFlyout
                    open
                    caps={caps}
                    onClose={() => {
                        /* no-op: the harness keeps it open */
                    }}
                />
            )}
        </div>
    );
}
