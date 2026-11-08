import { describe, expect, it } from 'vitest';
import { validateDefinition } from '../src/core/catalog.js';
import { genieCatalog } from '../src/main/genie-catalog.js';

/**
 * EVERY ELEMENT SAYS WHERE IT RUNS AND HOW ITS SIDES TALK (the owner's rulings, q_d71981d6): "ADF and the host split are
 * one design. Every catalog element declares where it runs (host, client or both) and how its two sides talk." And
 * "no backward compatibility, forward-looking only": the envelope's Genie 1 alias field goes.
 *
 * `reach.side` is `host`, `client` or `both`. An element that runs on BOTH declares `reach.link`: the host methods its
 * client side calls and the host events it follows — the only way its halves talk. One side alone has no link.
 */

const base = {
    id: 'com.example.pkg.thing', kind: 'panel', version: '1.0.0', packageId: 'com.example.pkg', source: 'plugin',
    docs: { name: 'Thing', description: 'A thing.' },
    permissions: { capabilities: [], network: [] },
    payload: { fancyComponent: 'ArtBoardPanel', props: {} },
};
const reach = (over: Record<string, unknown>) => ({ scopes: ['workspace'], requiresWindow: true, remote: 'allowed', ...over });

describe('reach.side and reach.link', () => {
    it('an element on BOTH sides declares how they talk: the host calls its client makes and the events it follows', () => {
        expect(validateDefinition({ ...base, reach: reach({ side: 'both', link: { calls: ['artboard.read', 'artboard.review'], events: [] } }) }).ok).toBe(true);
    });

    it('on both sides with NO link is refused, by name — its halves would have no way to talk', () => {
        const r = validateDefinition({ ...base, reach: reach({ side: 'both' }) });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.problems.join('\n')).toMatch(/reach\.link/);
        expect(validateDefinition({ ...base, reach: reach({ side: 'both', link: { calls: [], events: [] } }) }).ok).toBe(false);
        expect(validateDefinition({ ...base, reach: reach({ side: 'both', link: { calls: [3], events: [] } }) }).ok).toBe(false);
    });

    it('one side alone has no link to declare (CONTROL: host and client alone pass without one)', () => {
        // A recipe leaves its side to each definition (B7's KIND_SPECS); a panel may be client or both, never host.
        const recipe = { ...base, kind: 'recipe', payload: { steps: [{ tool: 'imDone' }] } };
        expect(validateDefinition({ ...base, reach: reach({ side: 'client' }) }).ok).toBe(true);
        expect(validateDefinition({ ...recipe, reach: reach({ side: 'host', requiresWindow: false }) }).ok).toBe(true);
        expect(validateDefinition({ ...recipe, reach: reach({ side: 'host', requiresWindow: false, link: { calls: ['x'], events: [] } }) }).ok).toBe(false);
        expect(validateDefinition({ ...recipe, reach: reach({ side: 'client', link: { calls: ['x'], events: [] } }) }).ok).toBe(false);
    });

    it('no Genie 1 aliases: the field is gone, and declaring one is refused as an unknown key', () => {
        const r = validateDefinition({ ...base, aliases: ['old.name'], reach: reach({ side: 'client' }) });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.problems.join('\n')).toContain('"aliases"');
    });
});

describe('Genie’s own elements say where they run', () => {
    const c = genieCatalog();

    it('the tools run on the host; their callers are agents, not a window', () => {
        for (const d of c.list('tool')) expect(d.reach.side, d.id).toBe('host');
    });

    it('an editor is both: the window draws it and the host reads and writes the file', () => {
        for (const d of c.list('editor')) expect(d.reach, d.id).toMatchObject({ side: 'both', link: { calls: ['files.readBytes', 'files.writeBytes'] } });
    });

    it('the Repository and ArtBoard panels are both, each over its own host calls', () => {
        expect(c.get('ai.genie.repository.changes')?.reach).toMatchObject({ side: 'both', link: { calls: ['repo.call'] } });
        expect(c.get('ai.genie.artboard.board')?.reach).toMatchObject({ side: 'both', link: { calls: ['artboard.read', 'artboard.review'] } });
    });

    it('nothing of Genie’s carries an alias', () => {
        for (const d of c.list()) expect('aliases' in d, d.id).toBe(false);
    });
});
