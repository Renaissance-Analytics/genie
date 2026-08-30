import { describe, expect, it } from 'vitest';
import { installationLoadState, isGitHubAuthenticationFailure } from '../github-installations';

describe('GitHub installation discovery state', () => {
    it('does not misreport a failed refresh as an empty installation list', () => {
        expect(installationLoadState({ connected: true, error: new Error('GitHub returned 403') }))
            .toEqual({ loaded: false, error: 'GitHub returned 403' });
    });

    it('represents a successful empty response distinctly', () => {
        expect(installationLoadState({ connected: true, installations: [] }))
            .toEqual({ loaded: true, installations: [], error: null });
    });
});

describe('GitHub authentication recovery', () => {
    it('recognizes the no-token failure returned across Electron IPC', () => {
        expect(isGitHubAuthenticationFailure(
            "Error invoking remote method 'github:installations': GitHubAuthError: No GitHub token.",
        )).toBe(true);
    });

    it('does not misclassify an installation permission error as a missing token', () => {
        expect(isGitHubAuthenticationFailure('GitHub returned 403 for this organization')).toBe(false);
    });
});
