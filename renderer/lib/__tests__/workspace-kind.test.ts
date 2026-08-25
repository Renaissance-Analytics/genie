import { describe, expect, it } from 'vitest';
import {
    WORKSPACE_KIND_CLASS,
    resolveWorkspaceKind,
    workspaceKindClass,
    workspaceKindLabel,
    type WorkspaceKind,
} from '../workspace-kind';

/**
 * WHICH treatment a workspace's chrome wears, and — the load-bearing half —
 * what CANNOT decide it.
 *
 * A GApp declares its own window and pill styling; it does NOT get to style the
 * workspace around it. That boundary is structural, not a convention: the
 * resolver reads exactly two Genie-owned fields, narrows each against a closed
 * literal set, and the class comes out of a frozen record. There is no string
 * path from a developer's manifest to workspace chrome.
 */

describe('resolveWorkspaceKind — precedence', () => {
    it('a workspace with neither mark has no kind', () => {
        expect(resolveWorkspaceKind({})).toBeNull();
        expect(resolveWorkspaceKind({ app_kind: null, gapp_dev: 0 })).toBeNull();
    });

    it('recognises each kind on its own', () => {
        expect(resolveWorkspaceKind({ app_kind: 'app' })).toBe('app');
        expect(resolveWorkspaceKind({ app_kind: 'app-dev' })).toBe('app-dev');
        expect(resolveWorkspaceKind({ app_kind: 'app-preview' })).toBe('app-preview');
        expect(resolveWorkspaceKind({ gapp_dev: 1 })).toBe('gapp-dev-workspace');
    });

    it('a PREVIEW outranks everything — it is about to be deleted', () => {
        // The preview workspace is a throwaway on the developer's own folder,
        // swept when the window closes. Whatever else it is, that is the fact the
        // user needs on screen.
        expect(resolveWorkspaceKind({ app_kind: 'app-preview', gapp_dev: 1 })).toBe('app-preview');
    });

    it('an INSTALLED app outranks development — it is not the developer’s source', () => {
        // `app` is a Genie-created envelope that HOSTS somebody's installed GApp.
        // Being a place a GApp RUNS is not being a place a GApp is BUILT, and the
        // dev affordances must not appear there.
        expect(resolveWorkspaceKind({ app_kind: 'app', gapp_dev: 1 })).toBe('app');
    });

    it('a GDW outranks `app-dev` — the richer, human-declared statement wins', () => {
        // `app-dev` is a mechanical consequence of choosing "Install for
        // development…" on a folder. `gapp_dev` is a human marking the Tynn
        // project as the place this app is developed. When a workspace is both,
        // the second says more.
        expect(resolveWorkspaceKind({ app_kind: 'app-dev', gapp_dev: 1 })).toBe(
            'gapp-dev-workspace',
        );
    });
});

describe('the manifest boundary', () => {
    it('nothing a manifest can carry becomes workspace chrome — with a positive control', () => {
        // POSITIVE CONTROL, first and deliberately: the resolver IS alive and DOES
        // move chrome. Without this, every "produces no chrome" assertion below
        // would pass just as happily against a function that returns null always.
        expect(workspaceKindClass(resolveWorkspaceKind({ gapp_dev: 1 }))).toBe('ws-gapp-dev');
        expect(workspaceKindClass(resolveWorkspaceKind({ app_kind: 'app' }))).toBe('ws-app');
        expect(workspaceKindClass(resolveWorkspaceKind({}))).toBe('');

        // Now the boundary. These are the values a developer would reach for if
        // they wanted the shell to wear their brand — class names, colours, CSS,
        // even Genie's own internal class strings copied verbatim. Every one is
        // fed through BOTH fields the resolver reads, which is the entire surface
        // a manifest would have to cross.
        const fromAManifest: unknown[] = [
            'ws-gapp-dev',
            'ws-app',
            'gold',
            '#fcd34d',
            'background: red',
            'app-preview ws-gapp-dev',
            'Genie',
            '1',
            true,
            {},
            ['app'],
        ];

        for (const value of fromAManifest) {
            expect(resolveWorkspaceKind({ app_kind: value, gapp_dev: value })).toBeNull();
            expect(workspaceKindClass(resolveWorkspaceKind({ app_kind: value, gapp_dev: value })))
                .toBe('');
        }

        // …and the control still holds AFTER the hostile pass, so nothing above
        // mutated the frozen table on its way through.
        expect(workspaceKindClass(resolveWorkspaceKind({ gapp_dev: 1 }))).toBe('ws-gapp-dev');
    });

    it('every class the shell can wear comes from ONE frozen, first-party table', () => {
        // The structural guarantee: `workspaceKindClass` is a lookup, never a
        // concatenation or a passthrough, so its range is finite and auditable.
        expect(Object.isFrozen(WORKSPACE_KIND_CLASS)).toBe(true);
        expect(WORKSPACE_KIND_CLASS).toEqual({
            app: 'ws-app',
            'app-dev': 'ws-app-dev',
            'app-preview': 'ws-app-preview',
            'gapp-dev-workspace': 'ws-gapp-dev',
        });

        const kinds: WorkspaceKind[] = ['app', 'app-dev', 'app-preview', 'gapp-dev-workspace'];
        const allowed = new Set([...Object.values(WORKSPACE_KIND_CLASS), '']);
        for (const k of [...kinds, null]) {
            expect(allowed.has(workspaceKindClass(k))).toBe(true);
        }
    });

    it('a frozen table cannot be reassigned into', () => {
        // Belt and braces: a GApp runs in its own renderer with its own globals,
        // but a future in-process surface must not be able to redecorate the
        // shell by writing to this table.
        const before = WORKSPACE_KIND_CLASS['gapp-dev-workspace'];
        try {
            (WORKSPACE_KIND_CLASS as Record<string, string>)['gapp-dev-workspace'] = 'ws-app';
        } catch {
            // strict mode throws; non-strict silently ignores. Either is fine.
        }
        expect(WORKSPACE_KIND_CLASS['gapp-dev-workspace']).toBe(before);
    });
});

describe('workspaceKindLabel', () => {
    it('names each kind for a tooltip, and says nothing for an ordinary workspace', () => {
        expect(workspaceKindLabel('gapp-dev-workspace')).toBe('GApp Development Workspace');
        expect(workspaceKindLabel('app')).toBe('Genie App');
        expect(workspaceKindLabel('app-dev')).toBe('Genie App · in development');
        expect(workspaceKindLabel('app-preview')).toBe('Genie App · preview');
        expect(workspaceKindLabel(null)).toBeNull();
    });
});
