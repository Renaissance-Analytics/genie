import { describe, expect, it } from 'vitest';
import { manifestWithTui, parseAgentManifest } from '../src/core/agent-manifest.js';

/**
 * WHAT A PERSON'S SWITCH WRITES INTO AGENT.md (genie#1569; the owner, 2026-11-05: "I should never be restricted to a
 * provider. I need to be able to switch them any time I want to."). `tuis:` is the persona's default and description,
 * not a lock on the person, so after the person switches, Genie puts the chosen provider FIRST in it — the first entry is
 * the agent's default driver (Genie 1's agent-file.ts), which is what adoption on another machine starts it on.
 *
 * The file belongs to a person and is tracked in git: ONLY the `tuis:` entry changes. Every other byte stays, line
 * endings included.
 */
const lines = (text: string) => text.split('\n');

describe('manifestWithTui', () => {
    it('an inline list gains the chosen provider FIRST; every other line is unchanged, CRLF kept', () => {
        const before = '---\r\nname: miapa\r\npurpose: Write.\r\ntuis: [codex]\r\nmodel: gpt-5.1\r\n---\r\n\r\nYou are miapa.\r\nKeep it short.\r\n';
        const out = manifestWithTui(before, 'claude');
        expect(out).toEqual({ kind: 'written', text: before.replace('tuis: [codex]', 'tuis: [claude, codex]'), tuis: ['claude', 'codex'] });
        if (out.kind !== 'written') return;
        // CONTROL: the rest of the file, line by line, is the original's.
        const a = lines(before);
        const b = lines(out.text);
        expect(b).toHaveLength(a.length);
        a.forEach((line, i) => { if (!line.startsWith('tuis:')) expect(b[i]).toBe(line); });
        expect(out.text.match(/\r\n/g)?.length).toBe(before.match(/\r\n/g)?.length);
        expect(parseAgentManifest(out.text, 'x').tuis).toEqual(['claude', 'codex']);
    });

    it('a dash list gains an item of the same indent at its top; a later entry of the same provider moves up, nothing else moves', () => {
        const before = '---\nname: wren\ntuis:\n    - codex\n    - aider\n    - claude\nscope: app\n---\nbody\n';
        const out = manifestWithTui(before, 'claude');
        expect(out).toEqual({ kind: 'written', text: '---\nname: wren\ntuis:\n    - claude\n    - codex\n    - aider\nscope: app\n---\nbody\n', tuis: ['claude', 'codex', 'aider'] });
    });

    it('already first: nothing to write', () => {
        expect(manifestWithTui('---\nname: a\ntuis: [claude, codex]\n---\n', 'claude')).toEqual({ kind: 'unchanged' });
    });

    it('front matter without `tuis:` gains one line, `tuis: [<provider>]`, at the end of the front matter, in the file’s line ending', () => {
        const before = '---\r\nname: a\r\npurpose: P.\r\n---\r\nbody\r\n';
        expect(manifestWithTui(before, 'codex')).toEqual({ kind: 'written', text: '---\r\nname: a\r\npurpose: P.\r\ntuis: [codex]\r\n---\r\nbody\r\n', tuis: ['codex'] });
    });

    it('a file with no front matter is not rewritten: the reason says so', () => {
        expect(manifestWithTui('You are a.\n', 'codex')).toEqual({ kind: 'refused', reason: 'it has no front matter (the --- block at its top) to hold tuis:' });
    });
});
