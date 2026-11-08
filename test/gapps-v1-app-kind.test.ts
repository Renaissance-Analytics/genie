import { describe, expect, it } from 'vitest';
import { APP_BRIDGE, COMMON_PAYLOAD_FIELDS, ELEMENT_KINDS, KIND_SPECS, validateDefinition } from '../src/core/catalog.js';
import { renderSdkDocs } from '../src/core/sdk-docs.js';

/**
 * GAPPS V2, V1 (Tynn #566; spec .ai/plans/specs/gapps-v2.md, approved 2026-11-08): THE `app` CATALOG KIND. A GApp is a
 * signed genie-package/1 package that contributes an `app` element: a UI drawn in its own window (a client) whose grant,
 * storage and calls live in genie-host. So:
 *  - its side is `both`, and only `both`;
 *  - its `reach.link` is exactly the bridge (`APP_BRIDGE`): the calls its window may make and the events it follows, no
 *    more and no fewer, so an app's channel is declared like any element on both sides and cannot be widened;
 *  - its payload: `entry` (a plain path inside the package), `window`, `uses` (catalog element ids it may call), `storage`;
 *  - any element may say `grantable: false` (decision 3): what a GApp may never be granted. Documented on every page.
 */
const app = (over: { reach?: Record<string, unknown>; payload?: Record<string, unknown> } = {}) => ({
    id: 'com.example.notes.app', kind: 'app', version: '1.0.0', packageId: 'com.example.notes', source: 'gapp',
    docs: { name: 'Notes', description: 'Take notes.' },
    reach: { scopes: ['workspace'], side: 'both', requiresWindow: true, remote: 'local', link: { calls: [...APP_BRIDGE.calls], events: [...APP_BRIDGE.events] }, ...over.reach },
    permissions: { capabilities: [] },
    payload: { entry: 'app/index.html', uses: ['com.example.notes.append'], storage: 'app', ...over.payload },
});
const problems = (def: unknown) => {
    const r = validateDefinition(def);
    return r.ok ? [] : r.problems;
};

describe('the app kind', () => {
    it('is an active kind; its bridge is the app channel\'s calls and events', () => {
        expect(ELEMENT_KINDS).toContain('app');
        expect(KIND_SPECS.find((k) => k.kind === 'app')).toMatchObject({ status: 'active', sides: ['both'] });
        expect(APP_BRIDGE).toEqual({
            calls: ['app.me', 'app.call', 'app.storage.get', 'app.storage.set', 'app.storage.delete', 'app.storage.list'],
            events: ['app.grantChanged', 'app.catalogChanged'],
        });
        expect(problems(app())).toEqual([]);
    });

    it('on side client or host it is refused, naming the side it must be', () => {
        for (const side of ['client', 'host']) {
            const p = problems(app({ reach: { side, link: undefined } }));
            expect(p.join('\n'), side).toContain('reach.side must be "both" for a app');
        }
    });

    it('its link is exactly the bridge: a call outside it is refused by name, and so is one left out', () => {
        const extra = problems(app({ reach: { link: { calls: [...APP_BRIDGE.calls, 'files.readBytes'], events: [...APP_BRIDGE.events] } } }));
        expect(extra.join('\n')).toMatch(/reach\.link .*"files\.readBytes" is not .*bridge/);
        const missing = problems(app({ reach: { link: { calls: APP_BRIDGE.calls.filter((c) => c !== 'app.call'), events: [...APP_BRIDGE.events] } } }));
        expect(missing.join('\n')).toMatch(/reach\.link .*misses "app\.call"/);
        const event = problems(app({ reach: { link: { calls: [...APP_BRIDGE.calls], events: ['app.grantChanged', 'host.shutdown'] } } }));
        expect(event.join('\n')).toMatch(/"host\.shutdown" is not .*bridge/);
    });

    it('`entry` is required and a plain path inside the package', () => {
        expect(problems(app({ payload: { entry: undefined } })).join('\n')).toContain('payload.entry');
        for (const bad of ['/etc/passwd', '../outside.html', 'app//index.html', 'C:/x.html', 'app\\index.html', '']) {
            expect(problems(app({ payload: { entry: bad } })).join('\n'), bad).toContain('payload.entry');
        }
        expect(problems(app({ payload: { entry: 'index.html' } }))).toEqual([]);
    });

    it('`uses` lists catalog element ids; `storage` is "none" or "app"; `window` is an object', () => {
        expect(problems(app({ payload: { uses: ['not an id!'] } })).join('\n')).toContain('payload.uses');
        expect(problems(app({ payload: { uses: [] } }))).toEqual([]);
        expect(problems(app({ payload: { storage: 'disk' } })).join('\n')).toMatch(/payload\.storage must be "none" or "app"/);
        expect(problems(app({ payload: { storage: 'none' } }))).toEqual([]);
        expect(problems(app({ payload: { window: 'big' } })).join('\n')).toContain('payload.window');
        expect(problems(app({ payload: { window: { width: 800, height: 600 } } }))).toEqual([]);
    });
});

describe('grantable: false on any element', () => {
    const tool = (grantable: unknown) => ({
        id: 'com.example.notes.append', kind: 'tool', version: '1.0.0', packageId: 'com.example.notes', source: 'plugin',
        docs: { name: 'Append', description: 'Append a note.' },
        reach: { scopes: ['workspace'], side: 'host', requiresWindow: false, remote: 'local' },
        permissions: { capabilities: [] },
        payload: { handler: 'com.example.notes.append', inputSchema: { type: 'object' }, ...(grantable === undefined ? {} : { grantable }) },
    });

    it('is a boolean on any kind\'s payload; anything else is refused by name', () => {
        expect(problems(tool(false))).toEqual([]);
        expect(problems(tool(true))).toEqual([]);
        expect(problems(tool(undefined))).toEqual([]);
        expect(problems(tool('no')).join('\n')).toContain('payload.grantable must be true or false');
        expect(COMMON_PAYLOAD_FIELDS.map((f) => f.name)).toEqual(['grantable']);
        expect(COMMON_PAYLOAD_FIELDS[0]).toMatchObject({ required: false, default: true });
    });

    it('is documented on every kind\'s page', () => {
        const docs = renderSdkDocs();
        for (const spec of KIND_SPECS) expect(docs.get(`kinds/${spec.kind}.md`), spec.kind).toContain('| `grantable` |');
    });
});

describe('the docs', () => {
    it('docs/sdk/kinds/app.md states the side, the fixed bridge and the fields; the index lists app on side both', () => {
        const docs = renderSdkDocs();
        const page = docs.get('kinds/app.md');
        expect(page).toBeDefined();
        for (const name of [...APP_BRIDGE.calls, ...APP_BRIDGE.events]) expect(page, name).toContain(`\`${name}\``);
        for (const field of ['entry', 'window', 'uses', 'storage']) expect(page, field).toContain(`| \`${field}\` |`);
        expect(docs.get('README.md')).toContain('| [app](kinds/app.md) | active | both |');
    });
});
