import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { DeckItem } from '../src/core/deck.js';
import { knowledgeFormDefaults, serviceFormDefaults } from '../src/core/forms.js';
import type { ServiceInstance } from '../src/core/services.js';
import { workspaceLabel } from '../src/core/workspace-label.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { FlowsSurface, HostingSurface, KnowledgeSurface, SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { MobileShell } from '../src/renderer/components/MobileShell.js';
import { Workspace, type WorkspaceOpsProps } from '../src/renderer/components/Workspace.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * A WORKSPACE IS DRAWN BY ITS NAME, NEVER ITS ID.
 *
 * The owner, 2026-10-12: "I am still seeing workspaces ID's in several places". The rail had learnt
 * names; the pickers, the service badges, the share rows, the Governs list and the phone had not, and
 * printed the ULID they were handed. Every one of them now goes through `workspaceLabel`. What is SENT
 * back stays an id — an `<option value="01J…">` legitimately carries one — so the assertions read the
 * TEXT a person sees (tags and their attributes stripped), and a positive control proves that reading
 * would catch an id drawn as text.
 */

const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';
const ID2 = '01JZYXWVTSRQPNMKJHGFEDCBA1';
const workspaces = [
    { id: ID, path: '/w/tynn', name: 'Tynn' },
    { id: ID2, path: 'C:\\w\\moic\\' },
];

/** What a person reads: the markup with every tag (and so every attribute) removed. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, ' ');
const noIdsShown = (html: string) => {
    const text = textOf(html);
    expect(text).not.toContain(ID);
    expect(text).not.toContain(ID2);
};

describe('workspaceLabel', () => {
    it('the name wins', () => {
        expect(workspaceLabel(workspaces, ID)).toBe('Tynn');
    });
    it('no name, or an empty one, is the folder — POSIX or Windows, trailing separator ignored', () => {
        expect(workspaceLabel(workspaces, ID2)).toBe('moic');
        expect(workspaceLabel([{ id: 'a', path: '/w/tynn', name: '' }], 'a')).toBe('tynn');
        expect(workspaceLabel([{ id: 'a', path: '/w/tynn/' }], 'a')).toBe('tynn');
        expect(workspaceLabel([{ id: 'b', path: 'C:\\w\\moic\\', name: '   ' }], 'b')).toBe('moic');
    });
    it('an id that names no workspace is shown as itself, as is everything before the list is known', () => {
        expect(workspaceLabel(workspaces, 'unknown-id')).toBe('unknown-id');
        expect(workspaceLabel(null, ID)).toBe(ID);
        expect(workspaceLabel(undefined, ID)).toBe(ID);
    });
});

describe('the text reading is a real gauge', () => {
    it('catches an id drawn as text, and ignores one carried in an attribute', () => {
        expect(textOf(`<span>${ID}</span>`)).toContain(ID);
        expect(textOf(`<span class="x">shared: ${ID}</span>`)).toContain(ID);
        expect(textOf(`<option value="${ID}">Tynn</option>`)).not.toContain(ID);
        expect(textOf(`<option value="${ID}">${workspaceLabel(workspaces, 'unknown-id')}</option>`)).toContain('unknown-id');
    });
});

describe('the surfaces draw names', () => {
    it('Flows: the workspace picker offers names, sends ids', () => {
        const html = renderToStaticMarkup(<FlowsSurface data={{ ...EMPTY_FEATURES, flows: { flows: [], adding: null } }} onAction={() => {}} onNavigate={() => {}} workspaces={workspaces} />);
        expect(html).toContain(`value="${ID}"`);
        expect(html).toContain('>Tynn<');
        expect(html).toContain('>moic<');
        noIdsShown(html);
    });

    it('Hosting → Services: a dedicated engine’s badge, and “Dedicated to” in the Add-an-engine form', () => {
        const pg: ServiceInstance = { id: 'svc_17', engine: 'postgres', version: '17', scope: { kind: 'dedicated', workspaceId: ID }, publishedPort: 54321, credentials: { user: 'genie', password: 'x', database: 'app' }, active: true };
        const data: FeatureData = { ...EMPTY_FEATURES, hosting: { sites: [], processes: [], adding: null, frontDoor: { running: false, reason: 'off' } }, services: { instances: [{ instance: pg, status: 'running' }], adding: null } };
        const list = renderToStaticMarkup(<HostingSurface data={data} onAction={() => {}} onNavigate={() => {}} tab="services" workspaces={workspaces} />);
        expect(list).toMatch(/>Tynn</);
        noIdsShown(list);

        const form = renderToStaticMarkup(
            <HostingSurface data={data} onAction={() => {}} onNavigate={() => {}} tab="services" workspaces={workspaces}
                adding={{ kind: 'service', workspaceId: ID, defaults: serviceFormDefaults({ workspaceId: ID }), problems: [], consent: null }} />,
        );
        expect(textOf(form)).toMatch(/Dedicated to Tynn/);
        noIdsShown(form);
    });

    it('Knowledge: “Where it files” names the workspace', () => {
        const knowledge = { hits: [], query: '', adding: { defaults: knowledgeFormDefaults({ workspaceId: ID }), problems: [] }, lastAdd: null } as unknown as FeatureData['knowledge'];
        const html = renderToStaticMarkup(<KnowledgeSurface data={{ ...EMPTY_FEATURES, knowledge }} onAction={() => {}} onNavigate={() => {}} workspaces={workspaces} />);
        expect(textOf(html)).toMatch(/Tynn — this workspace only/);
        expect(textOf(html)).toMatch(/moic — this workspace only/);
        noIdsShown(html);
    });

    it('Settings → Remote access: share rows, a shared connection, and the mint picker', () => {
        const remote: NonNullable<FeatureData['remote']> = {
            host: 'alphar', url: 'wss://alphar.tailnet.invalid:7421', unavailable: null, locked: false, pin: null, devices: [],
            shares: [{ id: 'share_s', workspaceId: ID, grantedTo: 'wren', expiresAt: 10, served: true, revoked: false }],
            connections: [{ id: 'conn_2', label: 'wren’s laptop', isOwner: false, workspaceId: ID, driving: false }],
            servedLink: null,
        };
        const html = renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, remote }} onAction={() => {}} onNavigate={() => {}} group="workstation" workspaces={workspaces} />);
        expect(textOf(html)).toMatch(/shared: Tynn/);
        expect(html).toContain('>Tynn<');
        noIdsShown(html);
    });
});

describe('the Workspace surface’s Governs list draws names', () => {
    it('each checkbox says the workspace’s name; the id stays in the data attribute', () => {
        const ops: WorkspaceOpsProps = {
            asleep: false, agentCount: 0, removePreview: false, lastOutcome: null,
            onHibernate: () => {}, onWake: () => {}, onPreviewRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {},
            governs: { children: [ID], candidates: workspaces.map((w) => ({ id: w.id, name: workspaceLabel(workspaces, w.id) })), onSet: () => {} },
        };
        const html = renderToStaticMarkup(<Workspace view="settings" workspace={{ id: 'ops', path: '/w/ops' }} terminals={NO_TERMINALS} ops={ops} />);
        expect(html).toMatch(new RegExp(`data-govern-child="${ID}"[^>]*checked=""`));
        expect(html).toContain('>Tynn<');
        expect(html).toContain('>moic<');
        noIdsShown(html);
    });
});

describe('the phone draws names', () => {
    const item: DeckItem = {
        id: 'i1', source: 'agent-question', agentId: 'kai', agentName: null, workspaceId: ID,
        title: 'Allow php artisan migrate --force?', blocking: true, priority: 'normal', at: 1_760_000_000_000,
        answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }] }, forwardedFrom: null,
    } as DeckItem;
    const row = {
        id: 'agent_kai', name: 'kai', provider: 'claude', workspaceId: ID, fidelity: 'declared', state: 'working', duration: '12m', ask: null, reason: null, fixes: [], step: null, target: null,
        delivery: null, comms: null, context: null,
    } as unknown as AgentRow;

    it('a question, an agent row and the upload recipient name the workspace; the address sent stays an id', () => {
        const html = renderToStaticMarkup(
            <MobileShell host="alphar" locked={false} refusal={null} items={[item]} answering={null} onAnswer={() => {}} onDisconnect={() => {}}
                workspaces={workspaces}
                agents={{ rows: [row], onOpen: () => {} }}
                upload={{ agents: [{ id: 'agent_kai', name: 'kai', provider: 'claude', workspaceId: ID }], sending: false, outcome: null, onSend: () => {} }} />,
        );
        expect(html).toContain(`value="${ID}:claude:kai"`);
        expect(textOf(html)).toMatch(/kai · Tynn/);
        expect((textOf(html).match(/Tynn/g) ?? []).length).toBeGreaterThanOrEqual(4);
        noIdsShown(html);
    });
});
