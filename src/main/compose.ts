import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deckItemsFrom } from '../core/deck-sources.js';
import type { DeckItem } from '../core/deck.js';
import type { GenRoute } from '../core/gen-router.js';
import { frontDoorCaddyfile } from '../core/front-door-caddy.js';
import { HUMAN, type Resolution } from '../core/inbox.js';
import { ApprovalQueue } from './approval-queue.js';
import { AttentionStore } from './attention-store.js';
import { FlowScheduler } from './flow-scheduler.js';
import { FlowStore } from './flow-store.js';
import { GenRouterServer } from './gen-router-server.js';
import { InboxStore } from './inbox-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { runtimeDir } from './paths.js';
import { ProcessSupervisor } from './process-supervisor.js';
import { SettingsStore } from './settings-store.js';
import { SiteManager } from './site-manager.js';
import type { PtyPort } from './terminal-host.js';

/**
 * THE COMPOSITION ROOT. Every store, the scheduler, the supervisor, the site manager and the front
 * door, wired once at boot and torn down once at quit. `main.ts` calls this and hands the result to
 * the IPC layer; nothing else constructs these.
 *
 * Boot order matters in two places: the settings carry-over runs before anything reads a setting,
 * and the front door starts after the site manager exists so its route function is live. Shutdown
 * is the reverse and idempotent: stop every supervised process (a pty we own is a pty we close),
 * close the front door's connections, wait for an in-flight flow run, close the knowledge database.
 */

export interface ComposeInput {
    readonly userData: string;
    readonly pty: PtyPort;
    /** Reads v1's settings table, or `null` when there is no v1 database. Called once, on first run only. */
    readonly v1Settings: () => Readonly<Record<string, string>> | null;
    readonly caddyBin: string | null;
    /** 0 picks a free loopback port. */
    readonly frontDoorPort?: number;
    readonly allocatePort?: () => number;
    readonly now?: () => number;
}

export interface ComposedServices {
    readonly inbox: InboxStore;
    readonly attention: AttentionStore;
    readonly knowledge: KnowledgeStore;
    readonly flows: FlowStore;
    readonly flowScheduler: FlowScheduler;
    readonly settings: SettingsStore;
    readonly supervisor: ProcessSupervisor;
    readonly sites: SiteManager;
    readonly frontDoor: GenRouterServer;
    /** The gate behind approval-gated tools; its pending requests are Deck items. */
    readonly approvals: ApprovalQueue;
    readonly frontDoorPort: number;
    /** Genie's own Caddy on 443 for EXTERNAL browsers (https://<name>.gen), or why it is off. */
    readonly externalFrontDoor: { running: true; caddyfile: string } | { running: false; reason: string };
    /** `<name>.gen → 127.0.0.1:<port>` for every site that is up — what the front door reads. */
    routes(): GenRoute[];
    /** The Deck's items from the stores, now. */
    deckItems(): DeckItem[];
    /** Who an agent id is, for the Deck and the inbox listings. */
    registerAgentName(agentId: string, who: { name: string; workspaceId: string }): void;
    /** An inbox address (`{provider}:{name}` or `{workspace}:{provider}:{name}`) for an agent id. */
    registerAgentAddress(address: string, agentId: string): void;
    /** Every registered address with the agent's name — the human's peer list. */
    agentAddresses(): Array<{ address: string; agentId: string; name: string }>;
    /** Resolve an address the way the inbox does: one / ambiguous (both forms named) / none / human. */
    resolveAddress(text: string): Resolution;
    shutdown(): Promise<void>;
}

/**
 * The EXTERNAL front door: Genie's bundled Caddy serving https://<name>.gen on 443 with its internal
 * CA, as ONE supervised process started with --watch, so the routes change by rewriting the Caddyfile
 * and never by spawning a second Caddy. Without a bundled binary nothing starts, and the reason is
 * recorded for the Hosting surface — the in-app browser does not need this path.
 */
function startExternalFrontDoor(caddyBin: string | null, caddyDir: string, sites: SiteManager, supervisor: ProcessSupervisor): ComposedServices['externalFrontDoor'] {
    if (caddyBin === null) {
        return { running: false, reason: 'this install has no bundled Caddy; https://<name>.gen in external browsers is off, the in-app browser still works' };
    }
    const caddyfile = join(caddyDir, 'Caddyfile');
    const render = () => {
        mkdirSync(caddyDir, { recursive: true });
        writeFileSync(caddyfile, frontDoorCaddyfile(sites.routes()), 'utf8');
    };
    render();
    sites.onChange(render);
    supervisor.onChange(render);
    supervisor.start({
        id: 'genie-front-door',
        workspaceId: '_genie',
        name: 'Genie front door (Caddy)',
        command: `${caddyBin} run --config ${caddyfile} --adapter caddyfile --watch`,
        cwd: caddyDir,
        env: { XDG_DATA_HOME: join(caddyDir, 'data'), XDG_CONFIG_HOME: join(caddyDir, 'config') },
        restart: 'always',
    });
    return { running: true, caddyfile };
}

export async function composeServices(input: ComposeInput): Promise<ComposedServices> {
    const now = input.now ?? Date.now;
    const iso = () => new Date(now()).toISOString();
    await mkdir(runtimeDir(input.userData), { recursive: true });

    const settings = await SettingsStore.open(input.userData, iso);
    await settings.carryOverFromV1(input.v1Settings());

    const inbox = await InboxStore.open(input.userData, iso);
    const attention = await AttentionStore.open(input.userData, inbox, iso);
    const knowledge = KnowledgeStore.open(input.userData, iso);
    const flows = await FlowStore.open(input.userData, now);
    const flowScheduler = new FlowScheduler({
        store: flows,
        now,
        schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        // Executors arrive with the Flows canvas work; until then a fired flow is recorded as run with
        // nothing executed, which the store's lastRun shows honestly.
        run: async () => {},
    });
    flowScheduler.plan();

    const supervisor = new ProcessSupervisor(input.pty, { now, schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } });
    let nextPort = 4100;
    const sites = new SiteManager({
        supervisor,
        allocatePort: input.allocatePort ?? (() => ++nextPort),
        caddyBin: input.caddyBin,
        configDir: join(runtimeDir(input.userData), 'sites'),
        writeConfig: (path, content) => {
            // Synchronous on purpose: the Caddy process is started right after and must find its file.
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, content, 'utf8');
        },
    });
    const routes = () => sites.routes();
    const frontDoor = new GenRouterServer(routes);
    const frontDoorPort = await frontDoor.listen(input.frontDoorPort ?? 0);

    const approvals = new ApprovalQueue({ now });
    const externalFrontDoor = startExternalFrontDoor(input.caddyBin, join(runtimeDir(input.userData), 'caddy'), sites, supervisor);
    const agents = new Map<string, { name: string; workspaceId: string }>();
    const addresses = new Map<string, string>();
    let down: Promise<void> | null = null;

    return {
        inbox,
        attention,
        knowledge,
        flows,
        flowScheduler,
        settings,
        supervisor,
        sites,
        frontDoor,
        approvals,
        frontDoorPort,
        externalFrontDoor,
        routes,
        deckItems: () => [
            ...approvals.deckItems(),
            ...deckItemsFrom({
                questions: attention.pending(),
                userList: attention.allUserItems(),
                unreadDms: inbox.unread(HUMAN),
                finished: attention.finished(),
                agents: Object.fromEntries(agents),
            }),
        ],
        registerAgentName: (agentId, who) => { agents.set(agentId, who); },
        registerAgentAddress: (address, agentId) => { addresses.set(address, agentId); },
        agentAddresses: () => [...addresses].map(([address, agentId]) => ({ address, agentId, name: agents.get(agentId)?.name ?? agentId })),
        resolveAddress: (text) => {
            if (text === HUMAN || text === 'you') return { kind: 'human' };
            const exact = addresses.get(text);
            if (exact !== undefined) return { kind: 'one', id: exact as never };
            // A short form that several full forms end with is ambiguous; name both.
            const matches = [...addresses.keys()].filter((a) => a.endsWith(`:${text}`) && a.split(':').length === 3);
            if (matches.length === 1) return { kind: 'one', id: addresses.get(matches[0]!)! as never };
            if (matches.length > 1) return { kind: 'ambiguous', forms: matches };
            return { kind: 'none' };
        },
        shutdown: () => {
            down ??= (async () => {
                approvals.cancelAll('Genie is shutting down');
                for (const p of supervisor.list()) supervisor.stop(p.id);
                await new Promise<void>((r) => frontDoor.close(r));
                await flowScheduler.settled();
                knowledge.close();
            })();
            return down;
        },
    };
}
