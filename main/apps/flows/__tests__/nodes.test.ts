import { describe, expect, it } from 'vitest';
import {
    GENIE_NODE_PREFIX,
    listGenieNodeKinds,
    nodeKindForTool,
    paletteForCapabilities,
    toolForNodeKind,
} from '../nodes';
import { APP_CAPABILITIES, UNGRANTABLE_TOOLS } from '../../capabilities';

/**
 * The flow palette is DERIVED from the capability model, never written by hand.
 *
 * A flow node that reaches Genie is a Genie tool call wearing a different hat, so
 * the set of nodes must be exactly the set of tools an app could already have
 * been granted — no more. Deriving it (rather than maintaining a second list)
 * means the property `capabilities.ts` already defends extends to flows for
 * free: a tool nobody classified cannot become a node, and an ungrantable tool
 * has no node at all.
 *
 * The alternative — a hand-written node registry — would drift the first time
 * someone added a tool, and the drift would be a silent capability grant rather
 * than a failure. That is the whole reason these tests exist.
 */

describe('the palette is derived from APP_CAPABILITIES', () => {
    it('gives every classified tool exactly one node kind', () => {
        const classified = APP_CAPABILITIES.flatMap((c) => c.tools);
        const kinds = listGenieNodeKinds();

        expect(kinds).toHaveLength(classified.length);
        expect(kinds.map((k) => k.tool).sort()).toEqual([...classified].sort());
    });

    it('carries the capability that governs each node, so consent can be explained', () => {
        const terminals = listGenieNodeKinds().find((k) => k.tool === 'manageTerminals');

        expect(terminals).toMatchObject({
            kind: 'genie.manageTerminals',
            tool: 'manageTerminals',
            capability: 'terminals',
            risk: 'high',
        });
    });

    it('namespaces every kind, so a Genie node can never collide with a Fancy builtin', () => {
        // `@particle-academy/api_request` and friends live in the same id space.
        for (const k of listGenieNodeKinds()) {
            expect(k.kind.startsWith(GENIE_NODE_PREFIX)).toBe(true);
        }
    });
});

describe('what may NOT become a node', () => {
    it('gives an ungrantable tool no node kind at all', () => {
        // Not "a node that refuses at run time" — no node. A tool nobody may ever
        // be granted should be unreachable by construction.
        for (const tool of Object.keys(UNGRANTABLE_TOOLS)) {
            expect(listGenieNodeKinds().some((k) => k.tool === tool)).toBe(false);
        }
    });

    it('refuses to resolve a FORGED kind naming an ungrantable tool', () => {
        // The attack: an app writes `genie.submitFeedback` into a graph by hand and
        // hopes the executor trusts the string. Resolution is a lookup against the
        // derived set, not string surgery, so there is nothing to forge.
        expect(toolForNodeKind('genie.submitFeedback')).toBeNull();
        expect(toolForNodeKind('genie.genieGuide')).toBeNull();
    });

    it('refuses a kind naming a tool that does not exist', () => {
        expect(toolForNodeKind('genie.rmMinusRf')).toBeNull();
    });

    it('refuses a Fancy builtin kind — those are not Genie tools', () => {
        expect(toolForNodeKind('@particle-academy/api_request')).toBeNull();
        expect(toolForNodeKind('@particle-academy/manual_trigger')).toBeNull();
    });

    it('refuses a kind that merely starts with the prefix', () => {
        expect(toolForNodeKind('genie.')).toBeNull();
        expect(toolForNodeKind('genie')).toBeNull();
        expect(toolForNodeKind('')).toBeNull();
    });
});

describe('round-tripping a tool through its node kind', () => {
    it('resolves back to the same tool for every classified tool', () => {
        for (const { tool } of listGenieNodeKinds()) {
            expect(toolForNodeKind(nodeKindForTool(tool))).toBe(tool);
        }
    });
});

describe('the palette an app actually sees', () => {
    it('offers only nodes the granted capabilities cover', () => {
        const palette = paletteForCapabilities(['hosting']);

        expect(palette.map((k) => k.tool).sort()).toEqual(['manageService', 'manageSite']);
    });

    it('offers nothing at all when nothing was granted', () => {
        expect(paletteForCapabilities([])).toEqual([]);
    });

    it('ignores a capability key that is not real', () => {
        // A hand-edited or migrated grant row must not widen the palette.
        expect(paletteForCapabilities(['terminals', 'root', 'everything'])).toHaveLength(1);
    });

    it('unions several granted capabilities', () => {
        const palette = paletteForCapabilities(['files', 'issues']);

        expect(palette.map((k) => k.tool).sort()).toEqual(['checkIssues', 'openFileForUser']);
    });
});
