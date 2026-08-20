import { describe, expect, it } from 'vitest';
import { GENIE_TOOL_NAMES } from '../../mcp/protocol';
import {
    APP_CAPABILITIES,
    UNGRANTABLE_TOOLS,
    capabilityForTool,
    isAppCapability,
} from '../capabilities';

/**
 * What a GApp may ask Genie for (Tynn #250).
 *
 * The owner's model is a mobile app store: an app declares the permissions it
 * wants, the user consents at install, and nothing else is reachable. So a GApp
 * does not declare raw TOOL names — it declares CAPABILITIES ("run commands",
 * "host sites"), which is what a consent prompt can actually be written about.
 *
 * The load-bearing property is the one the last test asserts: no tool may exist
 * outside this model. Adding a tool to Genie without classifying it is a build
 * failure, not a silent grant — otherwise the security surface grows every time
 * someone adds a feature elsewhere in the codebase.
 */

describe('the capability catalogue', () => {
    it('maps a tool to the capability that governs it', () => {
        expect(capabilityForTool('manageTerminals')).toBe('terminals');
        expect(capabilityForTool('manageSite')).toBe('hosting');
        expect(capabilityForTool('knowledge')).toBe('knowledge');
    });

    it('returns null for a tool it does not know — never a guess', () => {
        // A tool with no capability is unreachable, which is the correct default:
        // the bridge denies what it cannot classify.
        expect(capabilityForTool('somethingNewNobodyClassified')).toBeNull();
        expect(capabilityForTool('')).toBeNull();
    });

    it('never maps the same tool to two capabilities', () => {
        // Two homes means two consent prompts and an ambiguous denial reason.
        const seen = new Set<string>();
        for (const cap of APP_CAPABILITIES) {
            for (const tool of cap.tools) {
                expect(seen.has(tool), `${tool} is classified twice`).toBe(false);
                seen.add(tool);
            }
        }
    });

    it('gives every capability something a consent prompt can say', () => {
        for (const cap of APP_CAPABILITIES) {
            expect(cap.label.length, cap.key).toBeGreaterThan(0);
            // "Grant terminals?" is unanswerable. "Run any command on your machine,
            // as you" is a decision.
            expect(cap.grantDescription.length, cap.key).toBeGreaterThan(20);
            expect(cap.tools.length, cap.key).toBeGreaterThan(0);
        }
    });

    it('marks the capabilities that hand over the machine as high risk', () => {
        const high = APP_CAPABILITIES.filter((c) => c.risk === 'high').map((c) => c.key);
        // Arbitrary commands, autonomous agents, background/scheduled execution and
        // secrets. Anything here is asked on its own and starts denied.
        expect(high).toEqual(
            expect.arrayContaining(['terminals', 'agents', 'processes', 'secrets']),
        );
    });

    it('requires attribution on anything that speaks to the user', () => {
        // The anti-impersonation rule, in machine-readable form: a GApp that can
        // raise an OS-level modal could dress it as a Genie system prompt. Genie
        // stamps the app's name on it, and the bridge test enforces that this flag
        // is honoured rather than admired.
        const ask = APP_CAPABILITIES.find((c) => c.key === 'ask');
        expect(ask?.mustAttribute).toBe(true);
        expect(ask?.tools).toContain('ForceTheQuestion');
    });

    it('recognises its own keys and rejects anything else', () => {
        expect(isAppCapability('hosting')).toBe(true);
        expect(isAppCapability('everything')).toBe(false);
    });
});

describe('tools a GApp may never reach', () => {
    it('states WHY each one is off limits', () => {
        for (const [tool, reason] of Object.entries(UNGRANTABLE_TOOLS)) {
            expect(reason.length, tool).toBeGreaterThan(20);
        }
    });

    it('keeps them out of the grantable catalogue entirely', () => {
        for (const tool of Object.keys(UNGRANTABLE_TOOLS)) {
            expect(capabilityForTool(tool), tool).toBeNull();
        }
    });
});

describe('completeness — the property that keeps this honest', () => {
    it('classifies EVERY tool Genie advertises', () => {
        // If this fails, someone added a Genie tool and did not decide whether a
        // GApp may use it. The fix is to classify it — never to relax this test.
        const unclassified = GENIE_TOOL_NAMES.filter(
            (name) => capabilityForTool(name) === null && !(name in UNGRANTABLE_TOOLS),
        );
        expect(unclassified).toEqual([]);
    });

    it('does not classify tools that do not exist', () => {
        // The mirror check: a stale entry here would advertise a capability that
        // grants access to nothing, which reads as protection that is not there.
        const known = new Set(GENIE_TOOL_NAMES);
        const phantom = [
            ...APP_CAPABILITIES.flatMap((c) => c.tools),
            ...Object.keys(UNGRANTABLE_TOOLS),
        ].filter((t) => !known.has(t));
        expect(phantom).toEqual([]);
    });
});
