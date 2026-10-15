import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { serviceFormDefaults } from '../src/core/forms.js';
import type { ServiceInstance } from '../src/core/services.js';
import { AddServiceForm } from '../src/renderer/components/AddForms.js';
import { DeleteDataConfirm, HostingSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * THE SERVICES TAB IN HOSTING, AND THE "Add an engine" FORM. The §5 rule: `null` services draw a
 * skeleton, `[]` draws the invitation. An instance row names engine, version, scope, status (as
 * Docker reported it) and its loopback port. A version that is NOT active offers to become active,
 * and the warning about what that costs is on the row BEFORE the click — never after. The form
 * asks for CONSENT before a pull, naming the image, and the pull is a separate, labelled submit.
 */

const base: FeatureData = { ...EMPTY_FEATURES, hosting: { sites: [], processes: [], adding: null, frontDoor: { running: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' } }, services: { instances: [], adding: null } };
const pg = (version: string, active: boolean, port: number): ServiceInstance => ({
    id: `svc_${version}`, engine: 'postgres', version, scope: { kind: 'dedicated', workspaceId: 'tynn' }, publishedPort: port, credentials: { user: 'genie', password: 'x', database: 'tynn' }, active,
});
const redis: ServiceInstance = { id: 'svc_r', engine: 'redis', version: '7', scope: { kind: 'shared' }, publishedPort: 54399, credentials: {}, active: true };
const render = (data: FeatureData, extra: Partial<React.ComponentProps<typeof HostingSurface>> = {}) =>
    renderToStaticMarkup(<HostingSurface data={data} onAction={() => {}} onNavigate={() => {}} tab="services" workspaces={[{ id: 'tynn', path: '/w/tynn' }]} {...extra} />);

describe('the Services tab', () => {
    it('null draws a skeleton; an empty list invites the first engine; neither says "no results" before looking', () => {
        const skeleton = render({ ...base, services: null });
        expect(skeleton).toContain('data-skeleton');
        expect(skeleton).not.toMatch(/No service engines/);
        const empty = render(base);
        expect(empty).not.toContain('data-skeleton');
        expect(empty).toMatch(/No service engines yet/);
        expect(empty).toMatch(/Add an engine/);
    });

    it('a row names engine, version, scope, Docker status and loopback port; the shared one says shared', () => {
        const html = render({ ...base, services: { instances: [{ instance: pg('17', true, 54301), status: 'running' }, { instance: redis, status: 'exited' }], adding: null } });
        expect(html).toContain('data-service="svc_17"');
        expect(html).toMatch(/postgres 17/);
        expect(html).toMatch(/tynn/);
        expect(html).toMatch(/running/);
        expect(html).toMatch(/127\.0\.0\.1:54301/);
        expect(html).toContain('data-service="svc_r"');
        expect(html).toMatch(/shared/);
        expect(html).toMatch(/exited/);
    });

    it('with Docker not running the row SAYS so, with Docker’s reason — never `absent`; a row Docker answered for shows its state (control)', () => {
        const reason = 'Docker is installed but its daemon is not running; start Docker Desktop (or dockerd) and try again';
        const html = render({ ...base, services: { instances: [{ instance: pg('17', true, 54301), status: 'docker-not-running', note: reason }], adding: null } });
        expect(html).toContain('data-service-status="docker-not-running"');
        expect(html).toMatch(/Docker is not running/);
        expect(html).toContain(reason);
        expect(html).not.toMatch(/absent/);
        const control = render({ ...base, services: { instances: [{ instance: pg('17', true, 54301), status: 'exited' }], adding: null } });
        expect(control).toContain('data-service-status="exited"');
        expect(control).not.toMatch(/Docker is not running/);
    });

    it('the ACTIVE version is marked; a second version offers "Make active" with the data warning on the row BEFORE the click', () => {
        const html = render({ ...base, services: { instances: [{ instance: pg('16', true, 54301), status: 'running' }, { instance: pg('17', false, 54302), status: 'running' }], adding: null } });
        expect(html.match(/data-active="true"/g) ?? []).toHaveLength(1);
        expect(html.match(/Make active/g) ?? []).toHaveLength(1);
        expect(html).toContain('Switching postgres from 16 to 17: each version keeps its own data volume, so 17 starts EMPTY. Nothing in 16 is deleted; switch back any time.');
    });

    it('with the engine form open it renders inside the surface and the list stays visible', () => {
        const html = render(base, { adding: { kind: 'service', workspaceId: 'tynn', defaults: serviceFormDefaults({ workspaceId: 'tynn' }), problems: [{ field: 'major', message: 'postgres 12 is not a version Genie knows (14, 15, 16, 17).' }], consent: null } });
        expect(html).toContain('data-form="add-service"');
        expect(html).toContain('data-problem="major"');
        expect(html).toMatch(/No service engines yet/);
    });
});

describe('the Services tab: logs, the web inbox, deleting data (H6)', () => {
    const mailpit: ServiceInstance = { id: 'svc_m', engine: 'mailpit', version: '1.30', scope: { kind: 'shared' }, publishedPort: 4101, credentials: {}, active: true, publishedPorts: { ui: 4102 } };
    const sharedPg = (slices?: NonNullable<ServiceInstance['slices']>): ServiceInstance => ({ id: 'svc_spg', engine: 'postgres', version: '17', scope: { kind: 'shared' }, publishedPort: 4103, credentials: {}, active: false, admin: { user: 'genie', password: 'x' }, ...(slices ? { slices } : {}) });
    const workspaces = [{ id: 'example-a', path: '/w/a', name: 'Alpha' }, { id: 'example-b', path: '/w/b', name: 'Beta' }];

    it('a Mailpit row opens its web inbox — the URL on the button; a row without an inbox has none (control)', () => {
        const html = render({ ...base, services: { instances: [{ instance: mailpit, status: 'running' }, { instance: pg('17', true, 54301), status: 'running' }], adding: null } });
        expect(html.match(/data-open-inbox="([^"]+)"/g)).toEqual(['data-open-inbox="http://127.0.0.1:4102/"']);
        expect(html.match(/Open inbox/g)).toHaveLength(1);
    });

    it('every row offers Logs; the log the person opened is shown under ITS row only, with how much was read', () => {
        const instances = [{ instance: pg('17', true, 54301), status: 'running' as const }, { instance: mailpit, status: 'running' as const }];
        const closed = render({ ...base, services: { instances, adding: null } });
        expect(closed.match(/data-service-logs-button=/g)).toHaveLength(2);
        expect(closed).not.toContain('data-service-log=');
        const open = render({ ...base, services: { instances, adding: null, logs: { serviceId: 'svc_m', text: 'smtp listening on [::]:1025', tail: 500 } } });
        expect(open.match(/data-service-log="([^"]+)"/g)).toEqual(['data-service-log="svc_m"']);
        expect(open).toContain('smtp listening on [::]:1025');
        expect(open).toContain('the last 500 lines');
        expect(open).toMatch(/Hide logs/);
        expect(open).toMatch(/Refresh logs/);
    });

    it('every row offers "Remove and delete data…" beside "Remove (keep data)"', () => {
        const html = render({ ...base, services: { instances: [{ instance: pg('17', true, 54301), status: 'running' }], adding: null } });
        expect(html).toContain('data-delete-data="svc_17"');
        expect(html).toMatch(/Remove \(keep data\)/);
    });

    it('the confirmation names what is deleted — the volume and whose data — for the sole holder; another holder means NO delete button, only why, by name', () => {
        const confirm = (instance: ServiceInstance) => renderToStaticMarkup(<DeleteDataConfirm instance={instance} workspaces={workspaces} onAction={() => {}} onCancel={() => {}} />);
        const sole = confirm(sharedPg({ 'example-a': { identifier: 'ws_example_a', password: 'p' } }));
        expect(sole).toContain('data-delete-allowed="true"');
        expect(sole).toContain('genie-shared-postgres-17-data, with ws_example_a (workspace Alpha)');
        expect(sole).toMatch(/Delete the data/);
        const two = confirm(sharedPg({ 'example-a': { identifier: 'ws_example_a', password: 'p' }, 'example-b': { identifier: 'ws_example_b', password: 'q' } }));
        expect(two).toContain('data-delete-allowed="false"');
        expect(two).toContain('ws_example_a (workspace Alpha) and ws_example_b (workspace Beta)');
        expect(two).not.toMatch(/Delete the data/);
        expect(two).toMatch(/Keep it/);
    });
});

describe('Add an engine', () => {
    const defaults = serviceFormDefaults({ workspaceId: 'tynn' });

    it('offers every engine in the catalog, prefills the newest major, and defaults to dedicated', () => {
        const html = renderToStaticMarkup(<AddServiceForm defaults={defaults} problems={[]} consent={null} onSubmit={() => {}} onCancel={() => {}} />);
        for (const e of ['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'reverb', 'mailpit', 'meilisearch', 'seaweedfs', 'custom']) expect(html).toContain(`value="${e}"`);
        // MinIO is in the catalog only so Genie 1's can be taken over: never offered (its images are gone).
        expect(html).not.toContain('value="minio"');
        expect(html).toContain('value="17"');
        expect(html).toMatch(/name="scope"/);
        expect(html).not.toContain('data-consent');
        expect(html).toMatch(/Add engine/);
        expect(html).toMatch(/Cancel/);
    });

    it('when the driver asked for consent the form shows the note, names the image, and the pull is its own labelled submit', () => {
        const html = renderToStaticMarkup(
            <AddServiceForm defaults={defaults} problems={[]} consent={{ image: 'postgres:17', note: 'postgres:17 is not on this machine; pulling it downloads the image from Docker Hub.', form: defaults }} onSubmit={() => {}} onCancel={() => {}} />,
        );
        expect(html).toContain('data-consent');
        expect(html).toMatch(/downloads the image from Docker Hub/);
        expect(html).toMatch(/Pull postgres:17 and add/);
    });

    it('a custom image asks for ITS image, port, name and env — and no version; a typed engine asks for a version and none of those (control)', () => {
        const custom = renderToStaticMarkup(
            <AddServiceForm defaults={{ ...defaults, engine: 'custom', major: '', custom: { name: 'echo', image: 'registry.example/acme/echo:1', port: 8080, env: { GREETING: 'hello' } } }} problems={[{ field: 'image', message: 'Name the image to run (for example registry.example/team/app:1).' }]} consent={null} onSubmit={() => {}} onCancel={() => {}} />,
        );
        expect(custom).toContain('data-custom-fields');
        for (const name of ['image', 'port', 'name', 'env']) expect(custom).toContain(`name="${name}"`);
        expect(custom).not.toContain('name="major"');
        expect(custom).toContain('value="registry.example/acme/echo:1"');
        expect(custom).toContain('GREETING=hello');
        expect(custom).toContain('data-problem="image"');
        const typed = renderToStaticMarkup(<AddServiceForm defaults={defaults} problems={[]} consent={null} onSubmit={() => {}} onCancel={() => {}} />);
        expect(typed).toContain('name="major"');
        expect(typed).not.toContain('data-custom-fields');
    });
});
