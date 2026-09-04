import { describe, expect, it } from 'vitest';
import {
    knowledgeScopeLabel,
    parseKnowledgeScopeValue,
    scopePickerValue,
} from '../knowledge-scope';
import type { KnowledgeScope, WorkspaceRow } from '../genie';
// A pure leaf in main — no electron, no database — so the renderer's hand-written
// mirror of it can be pinned against the original.
import type { GenieScope } from '../../../main/genie-scope';

/**
 * How a memory's SCOPE reads in the Knowledge Graph window, and how the editor's
 * one picker round-trips it.
 *
 * The picker is deliberately FLAT — one control whose value is `system` or
 * `workspace:<id>` — rather than a kind selector plus a ref selector. Two
 * controls invent a state (`kind: workspace` with no ref) that cannot be saved,
 * and "which scope" and "which workspace" are one decision to the person making
 * it. The cost of flattening is a parse, which is what this pins.
 */

const workspaces = [
    { id: 'ws-1', project_name: 'Tynn.ai' },
    { id: 'ws-2', project_name: 'Genie' },
] as WorkspaceRow[];

/**
 * `renderer/lib/genie.ts` mirrors main's types BY HAND, because it declares the
 * contextBridge surface. That is exactly where a mirror drifts: nothing in the
 * build connects the two, so a field renamed on one side compiles cleanly on the
 * other and fails at runtime, in a window, on someone's machine.
 *
 * ★ These two assignments are compile-time, and they are the joint. Rename a
 * field, add a rung, or make one optional on either side and THIS FILE stops
 * type-checking.
 */
describe('the window’s scope type IS the main process’s', () => {
    it('a GenieScope is a KnowledgeScope, and a KnowledgeScope is a GenieScope', () => {
        const fromMain: KnowledgeScope = null as unknown as GenieScope;
        const fromRenderer: GenieScope = null as unknown as KnowledgeScope;

        // Runtime assertions so a `// @ts-expect-error` slipped in above would
        // not leave an empty green test standing where the check should be.
        expect(fromMain).toBeNull();
        expect(fromRenderer).toBeNull();
    });
});

describe('how a scope reads', () => {
    it('names the workstation rather than showing a sentinel', () => {
        expect(knowledgeScopeLabel({ kind: 'system' }, workspaces)).toBe('workstation');
    });

    it('shows a workspace by NAME, not by id', () => {
        // An id in the UI is a lookup the reader has to do by hand.
        expect(knowledgeScopeLabel({ kind: 'workspace', workspaceId: 'ws-2' }, workspaces)).toBe('Genie');
    });

    it('falls back to the id when the workspace is unknown, rather than lying', () => {
        // A workspace removed from Genie still has memories scoped to it. Showing
        // nothing, or "workstation", would misreport where they live.
        expect(knowledgeScopeLabel({ kind: 'workspace', workspaceId: 'ws-gone' }, workspaces)).toBe(
            'workspace · ws-gone',
        );
    });

    it('names the app for a gapp scope', () => {
        expect(knowledgeScopeLabel({ kind: 'gapp', appId: 'com.example.app' }, workspaces)).toBe(
            'app · com.example.app',
        );
    });

    it('survives an empty workspace list', () => {
        expect(knowledgeScopeLabel({ kind: 'workspace', workspaceId: 'ws-1' }, [])).toBe('workspace · ws-1');
    });
});

describe('the editor’s flat picker round-trips a scope', () => {
    const cases: KnowledgeScope[] = [
        { kind: 'system' },
        { kind: 'workspace', workspaceId: 'ws-1' },
        { kind: 'gapp', appId: 'com.example.app' },
    ];

    for (const scope of cases) {
        it(`round-trips ${scope.kind}`, () => {
            expect(parseKnowledgeScopeValue(scopePickerValue(scope))).toEqual(scope);
        });
    }

    it('round-trips a ref that itself contains a colon', () => {
        // The split has to be on the FIRST colon. A pack- or app-shaped ref with
        // one in it would otherwise be silently truncated into a different scope.
        const scope: KnowledgeScope = { kind: 'gapp', appId: 'com.example:beta' };
        expect(parseKnowledgeScopeValue(scopePickerValue(scope))).toEqual(scope);
    });

    it('reads an unparseable value as system — the WIDE end, so nothing hides', () => {
        expect(parseKnowledgeScopeValue('workspace:')).toEqual({ kind: 'system' });
        expect(parseKnowledgeScopeValue('nonsense')).toEqual({ kind: 'system' });
        expect(parseKnowledgeScopeValue('')).toEqual({ kind: 'system' });
    });
});
