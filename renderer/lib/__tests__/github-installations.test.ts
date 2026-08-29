import { describe, expect, it } from 'vitest';
import { installationLoadState } from '../github-installations';

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
