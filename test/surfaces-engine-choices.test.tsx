import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ServiceInstance } from '../src/core/services.js';
import { EngineChoices } from '../src/renderer/components/FeatureSurfaces.js';
import type { FeatureAction } from '../src/renderer/features.js';

/**
 * THE SERVICES TAB SAYS WHICH ENGINE EACH WORKSPACE USES (2026-10-15) — by the same rule the env is emitted by
 * (core/services.ts `chooseEngines`), so the person sees what the workspace's processes get, and can pick another or
 * detach a shared one. Shown only where there is a choice. Values invented; names RFC 2606.
 */

const WS = 'example';
const workspaces = [{ id: WS, path: '/w/example' }];
const own: ServiceInstance = { id: 'svc_own', engine: 'postgres', version: '17', variant: 'pgvector', scope: { kind: 'dedicated', workspaceId: WS }, publishedPort: 4101, credentials: { user: 'genie', password: 'x', database: WS }, active: true };
const v1 = (detached = false): ServiceInstance => ({
    id: 'svc_v1_postgres-17', engine: 'postgres', version: '17', scope: { kind: 'shared' }, publishedPort: 37605, credentials: {}, active: true, adopted: 'v1',
    slices: { [WS]: { identifier: 'ws_example', password: 'y', active: !detached } }, ...(detached ? { detached: [WS] } : {}),
});
const render = (instances: ServiceInstance[], sent: FeatureAction[] = []) => renderToStaticMarkup(<EngineChoices instances={instances} workspaces={workspaces} onAction={(a) => { sent.push(a); }} />);

describe('In use', () => {
    it('own pgvector beside Genie 1’s: the OWN one is in use, Genie 1’s is offered by id — and nothing offers to detach the own one', () => {
        const html = render([v1(), own]);
        expect(html).toContain(`data-engine-choice="${WS}:postgres"`);
        expect(html).toContain('data-chosen="svc_own"');
        expect(html.match(/data-use="([^"]+)"/g)).toEqual(['data-use="svc_v1_postgres-17"']);
        // Changed 2026-10-21 (the owner, 2026-10-21, of the GitHub card's "Carried over from Genie 1": "this is not needed … it should be the same"): an engine taken over from Genie 1 is named like any other — shared.
        expect(html).toContain('Use postgres 17 · shared');
        expect(html).not.toContain('Genie 1');
        expect(html).not.toContain('data-detach=');
    });

    it('only Genie 1’s: it is in use and can be DETACHED; once detached it offers Attach and nothing is in use', () => {
        const attached = render([v1()]);
        expect(attached).toContain('data-chosen="svc_v1_postgres-17"');
        expect(attached.match(/data-detach="([^"]+)"/g)).toEqual(['data-detach="svc_v1_postgres-17"']);
        const detached = render([v1(true)]);
        expect(detached).toContain('data-chosen=""');
        expect(detached).toContain('Attach postgres 17 · shared');
        expect(detached).not.toContain('Genie 1');
        expect(detached).not.toContain('data-detach=');
    });

    it('CONTROL: one engine of its own and nothing shared — no choice, so nothing is drawn', () => {
        expect(render([own])).toBe('');
    });
});
