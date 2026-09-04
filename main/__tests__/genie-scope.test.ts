import { describe, expect, it } from 'vitest';
import {
    GENIE_SCOPE_KINDS,
    parseGenieScope,
    scopeRefOf,
    type GenieScope,
} from '../genie-scope';
import type { FlowScope } from '../flows/types';

/**
 * ONE scope ladder, spelled the same way in both systems (knowledge-graph spec
 * §11).
 *
 * Flows and the Knowledge Graph both answer "whose reasoning does this belong
 * in", and §11's whole point is that they answer it with the SAME type rather
 * than two that happen to agree today. `GenieScope` lives in a leaf module with
 * no imports so `db.ts`, the store and the MCP surface can take it without
 * pulling the Flows runtime in behind it — which means nothing structural stops
 * the two drifting apart.
 *
 * ★ These two assignments are the joint. They are compile-time, not runtime: if
 * either side adds a rung, renames a field, or changes one from required to
 * optional, THIS FILE stops type-checking. An earlier draft of `GenieScope` used
 * a single `ref` for both refs, which would have been assignable in neither
 * direction — so nothing would ever have noticed.
 */
describe('the knowledge scope ladder IS the Flows scope ladder', () => {
    it('a FlowScope is a GenieScope, and a GenieScope is a FlowScope', () => {
        const fromFlow: GenieScope = null as unknown as FlowScope;
        const fromGenie: FlowScope = null as unknown as GenieScope;

        // The assertions above are the type checker's; these keep the test
        // honest at runtime too, so a `// @ts-expect-error` slipped in above
        // would not leave an empty green test behind.
        expect(fromFlow).toBeNull();
        expect(fromGenie).toBeNull();
    });

    it('offers exactly the three rungs, in the order the ladder is stated', () => {
        expect([...GENIE_SCOPE_KINDS]).toEqual(['system', 'workspace', 'gapp']);
    });
});

describe('reading a stored (kind, ref) pair back', () => {
    it('round-trips each rung through the column shape', () => {
        const cases: GenieScope[] = [
            { kind: 'system' },
            { kind: 'workspace', workspaceId: 'ws-1' },
            { kind: 'gapp', appId: 'com.example.app' },
        ];
        for (const scope of cases) {
            expect(parseGenieScope(scope.kind, scopeRefOf(scope))).toEqual(scope);
        }
    });

    it('names the ref field after the rung, matching FlowScope', () => {
        expect(parseGenieScope('workspace', 'ws-1')).toEqual({
            kind: 'workspace',
            workspaceId: 'ws-1',
        });
        expect(parseGenieScope('gapp', 'app-a')).toEqual({ kind: 'gapp', appId: 'app-a' });
    });

    it('reads an unknown kind, or a rung with no ref, as system — the WIDE end', () => {
        // The same direction the memory class takes on read: a row we cannot
        // interpret stays VISIBLE rather than resolving to a scope nobody can see
        // it from. Showing too much is recoverable; hiding knowledge is not.
        expect(parseGenieScope('galaxy', 'x')).toEqual({ kind: 'system' });
        expect(parseGenieScope('workspace', null)).toEqual({ kind: 'system' });
        expect(parseGenieScope('workspace', '   ')).toEqual({ kind: 'system' });
        expect(parseGenieScope(undefined, undefined)).toEqual({ kind: 'system' });
    });

    it('system has no ref to store', () => {
        expect(scopeRefOf({ kind: 'system' })).toBeNull();
    });
});
