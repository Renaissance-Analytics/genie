import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OnboardingState } from '../src/core/settings.js';
import { AddWorkspacePreview } from '../src/renderer/components/AddWorkspacePreview.js';
import { Dashboard } from '../src/renderer/components/Dashboard.js';
import { Onboarding } from '../src/renderer/components/Onboarding.js';

/**
 * ADD FROM TYNN ON SCREEN (§6.1). One more door beside "Add a workspace" and "From a git URL" — drawn only
 * when the app offers it, and in onboarding only when Tynn is signed in (signed out, the row is annotated
 * elsewhere; a door that opens onto "sign in first" is a gate, §6.9). The preview card names the Tynn
 * project, the folder it will create and the link it will record; Confirm creates the envelope.
 */

const state = (over: Partial<OnboardingState> = {}): OnboardingState => ({ workspaces: 0, agents: 0, providers: ['claude'], githubConnected: null, tynnSignedIn: true, ...over });

describe('the Dashboard first-run invitation', () => {
    it('offers From Tynn when the app does; not otherwise', () => {
        const withTynn = renderToStaticMarkup(<Dashboard rows={[]} workspaces={[]} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} onAddWorkspaceFromGit={() => {}} onAddWorkspaceFromTynn={() => {}} />);
        expect(withTynn).toContain('data-action="add-from-tynn"');
        expect(withTynn).toMatch(/From Tynn/);
        const without = renderToStaticMarkup(<Dashboard rows={[]} workspaces={[]} onOpenAgent={() => {}} onAddAgent={() => {}} onAddWorkspace={() => {}} onAddWorkspaceFromGit={() => {}} />);
        expect(without).not.toContain('data-action="add-from-tynn"');
    });
});

describe('onboarding', () => {
    it('offers From Tynn only while signed in; signed out, the step says where to sign in instead of a door onto a gate', () => {
        const signedIn = renderToStaticMarkup(<Onboarding state={state()} onAddWorkspace={() => {}} onAddWorkspaceFromTynn={() => {}} onAddAgent={() => {}} onNavigate={() => {}} />);
        expect(signedIn).toContain('data-action="add-from-tynn"');
        const signedOut = renderToStaticMarkup(<Onboarding state={state({ tynnSignedIn: false })} onAddWorkspace={() => {}} onAddWorkspaceFromTynn={() => {}} onAddAgent={() => {}} onNavigate={() => {}} />);
        expect(signedOut).not.toContain('data-action="add-from-tynn"');
        const unknown = renderToStaticMarkup(<Onboarding state={state({ tynnSignedIn: null })} onAddWorkspace={() => {}} onAddWorkspaceFromTynn={() => {}} onAddAgent={() => {}} onNavigate={() => {}} />);
        expect(unknown).not.toContain('data-action="add-from-tynn"');
    });
});

describe('AddWorkspacePreview for a Tynn source', () => {
    it('names the project, the folder and the link; Confirm creates the envelope', () => {
        const html = renderToStaticMarkup(
            <AddWorkspacePreview
                preview={{
                    ok: true,
                    source: 'tynn',
                    project: { id: '42', name: 'Tynn.ai', slug: 'tynn', vision: 'Agentic project management.' },
                    host: 'https://tynn.ai',
                    parent: '/w',
                    path: '/w/tynn',
                    kind: 'empty',
                    steps: [{ action: 'create /w/tynn', path: '/w/tynn', writes: true }, { action: 'link to Tynn project Tynn.ai (https://tynn.ai)', path: '/w/tynn', writes: true }, { action: 'register in Genie', path: '/w/tynn', writes: false }],
                }}
                onConfirm={() => {}}
                onCancel={() => {}}
                onConfirmTynn={() => {}}
            />,
        );
        expect(html).toContain('data-add-source="tynn"');
        expect(html).toContain('data-add-preview="empty"');
        expect(html).toMatch(/Tynn\.ai/);
        expect(html).toMatch(/\/w\/tynn/);
        expect(html).toMatch(/link to Tynn project/);
        expect(html).toContain('data-action="confirm-add"');
        expect(html).toMatch(/Create and add/);
        expect(html).not.toMatch(/git clone/);
    });
});
