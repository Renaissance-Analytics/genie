import { describe, expect, it } from 'vitest';
import { personaView } from '../src/core/agent-view.js';

/**
 * THE PERSONA BLOCK'S CONTENT (the board's empty state: the AGENT.md itself, mono, pre-wrap, under the path). The
 * block shows the first lines of the file as they are written — clipped, not summarised — and says when it is
 * clipped. Nothing when there is no text: the path alone is still a fact.
 */
describe('personaView', () => {
    it('the first twelve lines, as written; says when more follow', () => {
        const text = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join('\n');
        expect(personaView(text)).toEqual({ lines: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`), truncated: true });
        expect(personaView('# sable\n\nSecurity reviewer for tynn.')).toEqual({ lines: ['# sable', '', 'Security reviewer for tynn.'], truncated: false });
    });

    it('no text, blank text, or nothing read → null, not an empty box', () => {
        expect(personaView(null)).toBeNull();
        expect(personaView(undefined)).toBeNull();
        expect(personaView('   \n  ')).toBeNull();
    });
});
