import { describe, expect, it } from 'vitest';
import { ELEMENT_KINDS, KIND_SPECS, validateDefinition } from '../src/core/catalog.js';
import { renderSdkDocs } from '../src/core/sdk-docs.js';

/**
 * A HOST SERVICE IS A CATALOG ELEMENT (the coordinator, for the host-split P5d work: remote access, the relay host and the
 * relay member are host services with a client part). Active kind `host-service`: it runs on the host, or on BOTH with a
 * client part — and then its `reach.link` says how the two talk. Its payload names its lifecycle (start, stop), its
 * health, and the settings section it owns.
 */
const service = (over: Record<string, unknown> = {}) => ({
    id: 'ai.genie.remote.access', kind: 'host-service', version: '1.0.0', packageId: 'ai.genie.remote', source: 'builtin',
    docs: { name: 'Remote access', description: 'Lets another machine drive this one.' },
    reach: { scopes: ['workstation'], side: 'host', requiresWindow: false, remote: 'owner' },
    permissions: { capabilities: [], network: [] },
    payload: { start: 'remote.start', stop: 'remote.stop', health: 'remote.health', settingsSection: 'remote' },
    ...over,
});

describe('the host-service kind', () => {
    it('is an active family that runs on the host, or on both sides with a client part', () => {
        expect(ELEMENT_KINDS as readonly string[]).toContain('host-service');
        const spec = KIND_SPECS.find((k) => k.kind === 'host-service');
        expect(spec).toMatchObject({ status: 'active', sides: ['host', 'both'] });
        expect(spec!.fields.filter((f) => f.required).map((f) => f.name).sort()).toEqual(['health', 'settingsSection', 'start', 'stop']);
    });

    it('on the host it validates; on both it needs its link; a client alone is not a host service', () => {
        expect(validateDefinition(service()).ok).toBe(true);
        expect(validateDefinition(service({ reach: { scopes: ['workstation'], side: 'both', requiresWindow: false, remote: 'owner', link: { calls: ['remote.status'], events: ['remote.changed'] } } })).ok).toBe(true);
        const noLink = validateDefinition(service({ reach: { scopes: ['workstation'], side: 'both', requiresWindow: false, remote: 'owner' } }));
        expect(noLink.ok).toBe(false);
        if (!noLink.ok) expect(noLink.problems.join('\n')).toMatch(/reach\.link/);
        const client = validateDefinition(service({ reach: { scopes: ['workstation'], side: 'client', requiresWindow: true, remote: 'owner' } }));
        expect(client.ok).toBe(false);
        if (!client.ok) expect(client.problems.join('\n')).toContain('reach.side must be "host" or "both"');
    });

    it.each(['start', 'stop', 'health', 'settingsSection'])('without payload.%s it is refused, naming the field', (field) => {
        const payload: Record<string, unknown> = { start: 'remote.start', stop: 'remote.stop', health: 'remote.health', settingsSection: 'remote' };
        delete payload[field];
        const r = validateDefinition(service({ payload }));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.problems.join('\n')).toContain(`payload.${field}`);
    });

    it('its SDK page is generated, and the index lists it with its sides', () => {
        const docs = renderSdkDocs();
        expect(docs.get('kinds/host-service.md')).toContain('Side: **host** or **both**');
        expect(docs.get('README.md')).toContain('| [host-service](kinds/host-service.md) | active | host or both |');
    });
});
