import { describe, expect, it } from 'vitest';
import { parseAgentFile, renderAgentFile } from '../agent-file';

/**
 * AGENT.md must survive a UI round-trip WITHOUT LOSS.
 *
 * Genie is about to grow an editor over this file (Tynn #709): a human opens an
 * agent, edits its prompt or one header field, and saves. That save is
 * `parse → edit → render → write`, which means every key the renderer does NOT
 * draw passes through the parser and back out again.
 *
 * The original parser dropped them. `parseAgentFile` switched on four known
 * keys and `default: break`, and `renderAgentFile` emitted exactly those four —
 * so a file carrying `model: opus`, a `description:` a teammate wrote, or a key
 * a LATER Genie version adds would come back from the editor with those lines
 * silently deleted. The file is tracked in git and a human owns it, so that is
 * the worst possible failure mode here: the diff looks like the editor did it
 * on purpose, and nothing reports an error.
 *
 * The rule these tests pin: **an editor may only change what it was asked to
 * change.** Unknown header keys are carried verbatim, in their original order,
 * and a file Genie itself wrote is a FIXED POINT of parse∘render.
 */
describe('AGENT.md round-trip is lossless', () => {
    const withExtras = [
        '---',
        'name: moic',
        'purpose: agent management',
        'scope: repos/genie',
        'tuis: [claude, codex]',
        'model: opus',
        'description: the one that got dropped',
        '---',
        '',
        'You are moic.',
        '',
        '- rule one',
        '- rule two',
        '',
    ].join('\n');

    it('keeps a header key the UI does not render', () => {
        const parsed = parseAgentFile(withExtras);
        expect(parsed.extra).toEqual([
            ['model', 'opus'],
            ['description', 'the one that got dropped'],
        ]);
    });

    it('writes unknown keys back out, in their original order', () => {
        const parsed = parseAgentFile(withExtras);
        const out = renderAgentFile(parsed.config, parsed.body, parsed.extra);
        expect(out).toContain('model: opus');
        expect(out).toContain('description: the one that got dropped');
        expect(out.indexOf('model:')).toBeLessThan(out.indexOf('description:'));
    });

    it('is a FIXED POINT: rendering a parsed file reproduces it byte for byte', () => {
        // The property the editor actually depends on. Saving a file nobody
        // edited must not rewrite it — a spurious diff on every open would make
        // the surface untrustworthy long before it lost anything.
        const parsed = parseAgentFile(withExtras);
        expect(renderAgentFile(parsed.config, parsed.body, parsed.extra)).toBe(withExtras);
    });

    it('changes ONLY the body when only the body was edited', () => {
        const parsed = parseAgentFile(withExtras);
        const out = renderAgentFile(parsed.config, 'You are moic, revised.\n', parsed.extra);
        const reread = parseAgentFile(out);
        expect(reread.body.trim()).toBe('You are moic, revised.');
        expect(reread.config).toEqual(parsed.config);
        expect(reread.extra).toEqual(parsed.extra);
    });

    it('changes ONLY the named field when one header field was edited', () => {
        const parsed = parseAgentFile(withExtras);
        const out = renderAgentFile(
            { ...parsed.config, purpose: 'agent management surface' },
            parsed.body,
            parsed.extra,
        );
        const reread = parseAgentFile(out);
        expect(reread.config.purpose).toBe('agent management surface');
        expect(reread.config.name).toBe('moic');
        expect(reread.config.scope).toBe('repos/genie');
        expect(reread.config.tuis).toEqual(['claude', 'codex']);
        expect(reread.extra).toEqual(parsed.extra);
        expect(reread.body).toBe(parsed.body);
    });

    it('POSITIVE CONTROL: a file with no unknown keys reports none and gains none', () => {
        // Without this, `extra` could be a bag that always reports something and
        // the assertions above would pass on a parser that invented entries.
        const plain = ['---', 'name: tynn', 'purpose: laravel', '---', '', 'Body.', ''].join('\n');
        const parsed = parseAgentFile(plain);
        expect(parsed.extra).toEqual([]);
        expect(renderAgentFile(parsed.config, parsed.body, parsed.extra)).toBe(plain);
    });

    it('does not treat a malformed header line as a key worth preserving', () => {
        // A line with no `:` is not a key/value pair. Carrying it as one would
        // write back something that never parsed in the first place.
        const parsed = parseAgentFile('---\nname: x\njust some words\n---\nbody\n');
        expect(parsed.extra).toEqual([]);
    });

    it('keeps the four known keys OUT of extra', () => {
        // Otherwise a known key would be written twice — once by the renderer
        // and once from the passthrough bag.
        const parsed = parseAgentFile(withExtras);
        const keys = parsed.extra.map(([k]) => k);
        expect(keys).not.toContain('name');
        expect(keys).not.toContain('purpose');
        expect(keys).not.toContain('scope');
        expect(keys).not.toContain('tuis');
    });

    it('carries an unknown key even when its value would be dropped elsewhere', () => {
        // `tuis` filters unknown providers; an unknown KEY has no such notion of
        // validity and must not be filtered by analogy.
        const parsed = parseAgentFile('---\nname: x\npurpose: y\nteam: [a, b]\n---\nbody\n');
        expect(parsed.extra).toEqual([['team', '[a, b]']]);
    });

    it('back-compat: renderAgentFile still works with two arguments', () => {
        // Every existing caller (registration in host-tools.ts) passes two. A
        // required third parameter would have broken agent registration.
        expect(renderAgentFile(parseAgentFile(withExtras).config, 'b')).toContain('name: moic');
    });
});
