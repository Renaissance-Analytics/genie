import { describe, expect, it } from 'vitest';
import { parseAgentManifest } from '../src/core/agent-manifest.js';

/**
 * THE PERSONA'S OWN WORD (§6.2) — `.agents/<name>/AGENT.md` front matter. `tuis:` is the agent
 * saying which providers may run it; absent means any. Parsed from the two shapes the envelope
 * actually uses (inline list, and a YAML dash list), never from a YAML library.
 */

describe('parseAgentManifest', () => {
    it('reads name and an inline tuis list', () => {
        expect(parseAgentManifest('---\nname: tynn\npurpose: Plan.\ntuis: [claude, codex]\n---\n\nYou are tynn.', 'fallback')).toEqual({ name: 'tynn', tuis: ['claude', 'codex'] });
    });

    it('reads a dash list, trims and lower-cases providers, and falls back to the folder name when there is no name', () => {
        expect(parseAgentManifest('---\ntuis:\n  - Codex\n  -  claude \n---\nbody', 'wren')).toEqual({ name: 'wren', tuis: ['codex', 'claude'] });
    });

    it('no front matter, or no tuis, means ANY provider — tuis is absent, not an empty list', () => {
        expect(parseAgentManifest('You are atlas.', 'atlas')).toEqual({ name: 'atlas' });
        expect(parseAgentManifest('---\nname: atlas\n---\n', 'x')).toEqual({ name: 'atlas' });
        expect(parseAgentManifest(null, 'atlas')).toEqual({ name: 'atlas' });
    });
});
