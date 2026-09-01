import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { handoffPath, readHandoff, renderHandoff, writeHandoff } from '../handoff';

/**
 * The note an agent leaves for its own next run.
 *
 * Agents restart constantly and the next one started from nothing. Genie cannot
 * fill that gap itself — `imDone` knows a terminal ended, not what the agent was
 * in the middle of — so the outgoing agent supplies it on the call it already
 * makes when it stops.
 */

function tmpWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'genie-handoff-'));
}

describe('the handoff note', () => {
    it('is keyed by AGENT NAME, not terminal id', () => {
        // A terminal id changes on every restart — the exact identity that fails
        // to survive the gap this exists to bridge.
        const p = handoffPath('/ws', 'Tynn Builder');

        expect(p).toContain(path.join('.ai', 'handoff'));
        expect(p.endsWith('tynn-builder.md')).toBe(true);
    });

    it('round-trips what the agent wrote', () => {
        const ws = tmpWorkspace();

        expect(writeHandoff({ workspaceRoot: ws, agentName: 'tynn', note: 'Mid-way through #310.' })).toBe(true);

        expect(readHandoff(ws, 'tynn')).toContain('Mid-way through #310.');
    });

    it('records who left it and when, so a stale note is obvious', () => {
        const out = renderHandoff({
            agentName: 'tynn',
            note: 'Paused on the migration.',
            at: new Date('2026-09-01T12:00:00Z'),
        });

        expect(out).toContain('tynn');
        expect(out).toContain('2026-09-01T12:00:00.000Z');
    });

    it('writes NOTHING when the agent had nothing to say', () => {
        // An empty note is worse than none: the next agent reads a handoff that
        // tells it nothing and concludes the previous run reported nothing.
        const ws = tmpWorkspace();

        expect(writeHandoff({ workspaceRoot: ws, agentName: 'tynn', note: '   ' })).toBe(false);
        expect(readHandoff(ws, 'tynn')).toBeNull();
    });

    it('reports null when no note was ever left', () => {
        expect(readHandoff(tmpWorkspace(), 'never-ran')).toBeNull();
    });

    it('never throws when the note cannot be written', () => {
        // A failed handoff must not take down the imDone carrying it — the glow
        // telling a human their agent finished matters more than the note.
        const bogus = path.join(os.tmpdir(), 'genie-handoff-nope\0bad');

        expect(() => writeHandoff({ workspaceRoot: bogus, agentName: 'x', note: 'hi' })).not.toThrow();
        expect(writeHandoff({ workspaceRoot: bogus, agentName: 'x', note: 'hi' })).toBe(false);
    });

    it('replaces the previous note rather than appending', () => {
        // POSITIVE CONTROL: a handoff that accumulated would hand the next agent
        // every past run's note, oldest first, which is the opposite of useful.
        const ws = tmpWorkspace();
        writeHandoff({ workspaceRoot: ws, agentName: 'tynn', note: 'first' });
        writeHandoff({ workspaceRoot: ws, agentName: 'tynn', note: 'second' });

        const out = readHandoff(ws, 'tynn')!;
        expect(out).toContain('second');
        expect(out).not.toContain('first');
    });
});
