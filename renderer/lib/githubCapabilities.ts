import { useEffect, useState } from 'react';
import {
    api,
    hasGenieBridge,
    type GithubCapabilities,
    type GithubCapabilityKey,
    type GithubPermission,
} from './genie';

/**
 * Renderer-side helpers for the GitHub capability gate: a hook that tracks the
 * live status (boot check + push events), plus the human-readable copy that
 * the resolve modal and per-feature gated states share. Detection lives in
 * main; this is purely presentation + subscription.
 */

/** Human-readable name for each gated capability (modal + gated-state copy). */
export const CAPABILITY_LABEL: Record<GithubCapabilityKey, string> = {
    'issue-watch.issues': 'Issue Watch — Issues',
    'issue-watch.pulls': 'Issue Watch — Pull Requests',
    'issue-watch.dependabot': 'Issue Watch — Dependabot alerts',
    'github.provision': 'Repo provisioning, clone & fork',
};

/** Human-readable name for each GitHub App permission. */
export const PERMISSION_LABEL: Record<GithubPermission, string> = {
    metadata: 'Metadata',
    issues: 'Issues',
    pull_requests: 'Pull requests',
    vulnerability_alerts: 'Dependabot alerts',
    contents: 'Repository contents',
    administration: 'Administration',
};

/** A disconnected / not-yet-checked default (gate inert). */
const EMPTY: GithubCapabilities = {
    connected: false,
    satisfiedFeatures: [],
    missing: [],
    missingPermissions: [],
    checked: false,
};

/**
 * Track the GitHub capability status. Fetches once on mount and subscribes to
 * the `github:capabilities-changed` push (boot check, connect, reconnect,
 * disconnect, explicit recheck) so every consumer stays live without polling.
 *
 * `hasMissing` is the single flag the header warning + boot modal key off:
 * true only when GitHub is connected AND at least one required permission is
 * missing (we never nag a user who hasn't connected GitHub).
 */
export function useGithubCapabilities(): {
    caps: GithubCapabilities;
    hasMissing: boolean;
    refresh: () => void;
} {
    const [caps, setCaps] = useState<GithubCapabilities>(EMPTY);

    const refresh = () => {
        if (!hasGenieBridge()) return;
        api()
            .github.capabilities()
            .then(setCaps)
            .catch(() => {});
    };

    useEffect(() => {
        refresh();
        if (!hasGenieBridge()) return;
        return api().on.githubCapabilities?.(setCaps);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const hasMissing = caps.connected && caps.missing.length > 0;
    return { caps, hasMissing, refresh };
}
