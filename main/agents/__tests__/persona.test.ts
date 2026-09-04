import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPersonaEdit, personaView } from '../persona';

/**
 * Editing an agent's `AGENT.md` from the app (Tynn #709).
 *
 * The owner asked for "a full agent manager with agent prompt and rules and MCP
 * management" and got a driver picker. The plumbing was already here —
 * `parseAgentFile` / `renderAgentFile` — with no way to reach it, so this is the
 * edit path over it.
 *
 * The rule the whole surface stands on: **an edit changes what it names and
 * NOTHING else.** The file is tracked in git and a human owns it; a save that
 * quietly reformatted the prompt, dropped a header key, or reset a field the
 * form did not draw would be worse than no editor at all, because the diff
 * would look intentional.
 */
describe('applyPersonaEdit', () => {
    const raw = [
        '---',
        'name: moic',
        'purpose: agent management',
        'scope: repos/genie',
        'tuis: [claude, codex]',
        'model: opus',
        '---',
        '',
        '# Role',
        '',
        'You are moic. Be precise.',
        '',
    ].join('\n');

    it('is a no-op when nothing is edited', () => {
        // Opening an agent and pressing Save must produce no diff.
        expect(applyPersonaEdit(raw, {})).toBe(raw);
    });

    it('replaces the prompt body and leaves every header field alone', () => {
        const out = applyPersonaEdit(raw, { body: '# Role\n\nYou are moic, revised.\n' });
        expect(out).toContain('You are moic, revised.');
        expect(out).not.toContain('Be precise.');
        expect(out).toContain('name: moic');
        expect(out).toContain('scope: repos/genie');
        expect(out).toContain('tuis: [claude, codex]');
        expect(out).toContain('model: opus');
    });

    it('edits ONE header field without touching the prompt', () => {
        const out = applyPersonaEdit(raw, { purpose: 'the agent manager' });
        expect(out).toContain('purpose: the agent manager');
        expect(out).toContain('You are moic. Be precise.');
        expect(out).toContain('model: opus');
    });

    it('clears scope back to the whole workspace when set to null', () => {
        // Absence means "the whole workspace". A blank `scope:` would read as
        // "scoped to nothing", which is a different and wrong statement.
        const out = applyPersonaEdit(raw, { scope: null });
        expect(out).not.toContain('scope:');
    });

    it('never renames the agent', () => {
        // Identity is (workspace, name) and the roster, the channel and the
        // `.agents/<name>/` folder all key on it. Renaming from a text field
        // would desynchronise every one of them, so `name` is not editable here.
        const out = applyPersonaEdit(raw, { purpose: 'x', body: 'y' } as never);
        expect(out).toContain('name: moic');
    });

    it('keeps a body the author wrote verbatim, blank lines and all', () => {
        const body = 'a\n\n\nb\n';
        expect(applyPersonaEdit(raw, { body }).endsWith(body)).toBe(true);
    });

    it('POSITIVE CONTROL: a real edit actually reaches the file text', () => {
        // Without this, every assertion above would also pass on an
        // `applyPersonaEdit` that returned its input unchanged.
        expect(applyPersonaEdit(raw, { purpose: 'changed' })).not.toBe(raw);
    });
});

describe('AGENT.md survives a real write → read cycle', () => {
    let dir = '';

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-persona-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const file = () => path.join(dir, 'AGENT.md');

    const original = [
        '---',
        'name: moic',
        'purpose: agent management',
        'scope: repos/genie',
        'tuis: [claude, codex]',
        'model: opus',
        'description: kept by a teammate',
        '---',
        '',
        'You are moic.',
        '',
    ].join('\n');

    it('★ round-trips through the filesystem with the edit and nothing else', () => {
        fs.writeFileSync(file(), original);

        const edited = applyPersonaEdit(fs.readFileSync(file(), 'utf8'), {
            purpose: 'the agent management surface',
            body: 'You are moic. You own the agent manager.\n',
        });
        fs.writeFileSync(file(), edited);

        const back = personaView(fs.readFileSync(file(), 'utf8'));
        expect(back.purpose).toBe('the agent management surface');
        expect(back.body.trim()).toBe('You are moic. You own the agent manager.');
        // Untouched — the whole point.
        expect(back.name).toBe('moic');
        expect(back.scope).toBe('repos/genie');
        expect(back.tuis).toEqual(['claude', 'codex']);
        expect(back.extra).toEqual([
            { key: 'model', value: 'opus' },
            { key: 'description', value: 'kept by a teammate' },
        ]);
    });

    it('★ a second save with no edit rewrites the file byte for byte', () => {
        // Idempotence is what makes the editor safe to open. If a no-op save
        // churned the file, every human would see a diff they did not make and
        // stop trusting the surface.
        fs.writeFileSync(file(), original);
        const once = applyPersonaEdit(fs.readFileSync(file(), 'utf8'), {});
        fs.writeFileSync(file(), once);
        const twice = applyPersonaEdit(fs.readFileSync(file(), 'utf8'), {});
        expect(twice).toBe(once);
        expect(once).toBe(original);
    });

    it('POSITIVE CONTROL: the reader reports a DIFFERENT file differently', () => {
        // "The reader returned the right fields" passes on a reader that always
        // returns the same fixture. Feed it a second agent and check it moves.
        fs.writeFileSync(
            file(),
            ['---', 'name: tynn', 'purpose: laravel', 'tuis: [codex]', '---', '', 'B.', ''].join(
                '\n',
            ),
        );
        const other = personaView(fs.readFileSync(file(), 'utf8'));
        expect(other.name).toBe('tynn');
        expect(other.tuis).toEqual(['codex']);
        expect(other.scope).toBeNull();
        expect(other.extra).toEqual([]);
    });
});
