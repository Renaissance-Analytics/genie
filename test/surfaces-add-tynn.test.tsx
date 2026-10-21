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

/** The parts of a Tynn project these screens do not look at. */
const P = { vision: null, isWorkspace: true, repositories: [], envelope: null } as const;

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
                    project: { ...P, id: '42', name: 'Tynn.ai', slug: 'tynn', vision: 'Agentic project management.' },
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

    /* What the project brings is said before Confirm: Tynn's envelope cloned, its repos as submodules, or nothing yet. */
    it('says what comes with the project: the envelope Tynn names, its repositories, or none', () => {
        const view = (content: { kind: 'envelope'; url: string; branch: string | null } | { kind: 'repos'; repos: { url: string; branch: string | null; name: string }[] } | { kind: 'empty' }) =>
            renderToStaticMarkup(
                <AddWorkspacePreview
                    preview={{ ok: true, source: 'tynn', project: { ...P, id: '42', name: 'Tynn.ai', slug: 'tynn' }, host: 'https://tynn.ai', parent: '/w', path: '/w/tynn.agi', kind: content.kind === 'envelope' ? 'full-envelope' : 'empty', content, steps: [] }}
                    onConfirm={() => {}}
                    onCancel={() => {}}
                    onConfirmTynn={() => {}}
                />,
            );
        const envelope = view({ kind: 'envelope', url: 'https://github.com/example-org/tynn.agi.git', branch: 'main' });
        expect(envelope).toContain('data-tynn-content="envelope"');
        expect(envelope).toMatch(/https:\/\/github\.com\/example-org\/tynn\.agi\.git/);
        expect(envelope).toMatch(/Clone and add/);
        const repos = view({ kind: 'repos', repos: [{ url: 'https://github.com/a/api', branch: 'develop', name: 'api' }, { url: 'https://github.com/a/web', branch: null, name: 'web' }] });
        expect(repos).toContain('data-tynn-content="repos"');
        expect(repos).toMatch(/2 repositories/);
        expect(repos).toMatch(/Create and add/);
        const empty = view({ kind: 'empty' });
        expect(empty).toContain('data-tynn-content="empty"');
        expect(empty).toMatch(/no repositories/i);
        // The old promise that is no longer true is gone from every one.
        for (const html of [envelope, repos, empty]) expect(html).not.toMatch(/added afterwards through the registry/);
    });
});

/**
 * PICK THE PROJECT (Genie 1's Add-workspace: "your Tynn projects"). Signed in, From Tynn lists the person's own projects;
 * choosing one goes on to the folder picker and the plan. Loading, none, and Tynn's refusal each say so.
 */
describe('TynnProjectPicker', () => {
    it('lists each project by name with its slug, each a button that picks THAT project', async () => {
        const { TynnProjectPicker } = await import('../src/renderer/components/TynnProjectPicker.js');
        const html = renderToStaticMarkup(<TynnProjectPicker state={{ ok: true, host: 'https://tynn.ai', projects: [{ ...P, id: '42', name: 'Tynn.ai', slug: 'tynn' }, { ...P, id: 'p2', name: 'Acme', slug: 'acme' }] }} onPick={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-tynn-projects="2"');
        expect(html).toMatch(/data-tynn-project="42"[^>]*>(?:<[^>]+>)*Tynn\.ai/);
        expect(html).toMatch(/data-tynn-project="p2"[^>]*>(?:<[^>]+>)*Acme/);
        expect(html).toContain('https://tynn.ai');
        expect(html).toContain('data-action="cancel-tynn-pick"');
    });

    /*
     * ALREADY ADDED (Genie 1's AddWorkspaceModal "— already added"): a project whose workspace is here is still listed —
     * a project silently missing reads as Tynn having lost it — marked, and choosing it OPENS that workspace instead of
     * starting a second clone.
     */
    it('a project already added here is marked and opens its workspace; the others still pick', async () => {
        const { TynnProjectPicker } = await import('../src/renderer/components/TynnProjectPicker.js');
        const projects = [{ ...P, id: '42', name: 'Tynn.ai', slug: 'tynn' }, { ...P, id: 'p2', name: 'Acme', slug: 'acme' }];
        const picked: string[] = [];
        const opened: string[] = [];
        const element = TynnProjectPicker({ state: { ok: true, host: 'https://tynn.ai', projects, added: { '42': 'tynn-old' } }, onPick: (id) => picked.push(id), onOpen: (id) => opened.push(id), onCancel: () => {} });
        const html = renderToStaticMarkup(element);
        expect(html).toMatch(/data-tynn-project="42"[^>]*data-tynn-added="tynn-old"[^>]*>(?:<[^>]+>)*Tynn\.ai(?:<[^>]+>|[^<])*— already added/);
        expect(html).toMatch(/data-tynn-project="42"[\s\S]*?Open workspace/);
        // Positive control: the one not added carries no mark.
        expect(html).toMatch(/data-tynn-project="p2"(?![^>]*data-tynn-added)/);
        expect(html.match(/— already added/g)?.length).toBe(1);

        // The buttons' own handlers: the added project opens its workspace, the other is picked.
        const buttons: Array<{ props: Record<string, unknown> }> = [];
        const walk = (node: unknown): void => {
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (typeof node !== 'object' || node === null || !('props' in node)) return;
            const n = node as { type: unknown; props: Record<string, unknown> };
            if (n.type === 'button' && n.props['data-tynn-project'] !== undefined) buttons.push(n);
            walk(n.props.children);
        };
        walk(element);
        for (const b of buttons) (b.props.onClick as () => void)();
        expect(opened).toEqual(['tynn-old']);
        expect(picked).toEqual(['p2']);
    });

    it('loading, no projects, and Tynn’s refusal each say so — no empty list drawn as if it were the answer', async () => {
        const { TynnProjectPicker } = await import('../src/renderer/components/TynnProjectPicker.js');
        expect(renderToStaticMarkup(<TynnProjectPicker state={null} onPick={() => {}} onCancel={() => {}} />)).toContain('data-skeleton');
        const none = renderToStaticMarkup(<TynnProjectPicker state={{ ok: true, host: 'https://tynn.ai', projects: [] }} onPick={() => {}} onCancel={() => {}} />);
        expect(none).toMatch(/no projects on Tynn yet/i);
        expect(none).not.toContain('data-tynn-project=');
        const refused = renderToStaticMarkup(<TynnProjectPicker state={{ ok: false, reason: 'Tynn answered 403: Invalid token' }} onPick={() => {}} onCancel={() => {}} />);
        expect(refused).toMatch(/Tynn answered 403: Invalid token/);
        expect(refused).not.toContain('data-tynn-project=');
    });
});
