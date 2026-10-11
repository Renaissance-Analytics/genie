import { describe, expect, it } from 'vitest';
import { serviceFormDefaults, validateServiceForm } from '../src/core/forms.js';

/**
 * THE FORM BEHIND "Add an engine" — a pure model. Defaults pick the newest major of the catalog's
 * first engine for the workspace, dedicated; validation names every problem at once, and refuses a
 * dedicated scope for a shared-only engine with the same words the registry uses.
 */

describe('Add an engine', () => {
    it('defaults to the newest postgres, dedicated to the workspace', () => {
        expect(serviceFormDefaults({ workspaceId: 'tynn' })).toEqual({ workspaceId: 'tynn', engine: 'postgres', major: '17', scope: 'dedicated' });
    });

    it('validation names an unknown engine, a major the catalog does not know, and a dedicated shared-only engine — all at once', () => {
        expect(validateServiceForm({ workspaceId: 'tynn', engine: 'postgres', major: '17', scope: 'dedicated' })).toEqual([]);
        expect(validateServiceForm({ workspaceId: 'tynn', engine: 'oracle', major: '1', scope: 'dedicated' })).toEqual([
            { field: 'engine', message: 'oracle is not an engine Genie manages.' },
        ]);
        expect(validateServiceForm({ workspaceId: 'tynn', engine: 'postgres', major: '12', scope: 'dedicated' })).toEqual([
            { field: 'major', message: 'postgres 12 is not a version Genie knows (14, 15, 16, 17).' },
        ]);
        expect(validateServiceForm({ workspaceId: 'tynn', engine: 'reverb', major: '1', scope: 'dedicated' })).toEqual([
            { field: 'scope', message: 'reverb is a shared service — one per workstation, never per workspace.' },
        ]);
    });
});
