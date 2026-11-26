import { cloneOffers, type CloneOffer, type RepoFile } from '../core/clone-offers.js';
import { restoreFlows } from './workspace-flows-host.js';
import { restoreProcesses } from './workspace-processes-host.js';
import { restoreTabsFile, type CloneRestorePorts } from './workspace-clone-restore-host.js';

/**
 * THE WATCHER (Tynn #756, PR9c; the owner, 2026-11-16: it "notices upstream changes to these files and offers them, never
 * auto-applying"). A pass looks at a workspace's `.flows/`, `.processes/` and `.genie/tabs.json`; only a CHANGE since the last pass is
 * looked into; what differs from what this machine would save becomes an offer, with what the repo says beside what is here.
 *
 * A pass creates, writes, arms and starts NOTHING. An offer is applied only when the person asks, and only a NEW one, through the same
 * restore a clone's open uses (flows disarmed, processes stopped, a command waiting for the workspace's trust). A CHANGED one is told
 * and never replaced here: it differs from what the person has, and replacing it is theirs to do by hand.
 */

export interface CloneWatchPorts {
    workspaces(): readonly { id: string; path: string; asleep?: boolean }[];
    readonly restore: CloneRestorePorts;
    /** A cheap stamp of a file (its mtime and size), or null when it is not there. */
    stamp(path: string): Promise<string | null>;
    /** What Genie would save for this workspace now, as the three kinds of file. */
    live(workspace: { id: string; path: string }): Promise<RepoFile[]>;
}

const key = (offers: readonly CloneOffer[]): string => JSON.stringify(offers.map((o) => [o.id, o.change]));

export class CloneWatch {
    readonly #ports: CloneWatchPorts;
    readonly #prints = new Map<string, string>();
    readonly #offers = new Map<string, CloneOffer[]>();
    readonly #listeners = new Set<(workspaceId: string, offers: readonly CloneOffer[]) => void>();

    constructor(ports: CloneWatchPorts) {
        this.#ports = ports;
    }

    /** One look at every awake workspace. A hibernated one is a ghost: not looked at, and its offers are forgotten. */
    async pass(): Promise<void> {
        for (const workspace of this.#ports.workspaces()) {
            if (workspace.asleep === true) { this.#forget(workspace.id); continue; }
            try { await this.#scan(workspace, false); } catch { /* one workspace's unreadable folder costs the others nothing */ }
        }
    }

    list(workspaceId: string): CloneOffer[] {
        return [...(this.#offers.get(workspaceId) ?? [])];
    }

    /** Told when a workspace's set of offers changes (not on every pass). */
    onChange(listener: (workspaceId: string, offers: readonly CloneOffer[]) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** The person applies one offer. Only a new one: it is created as a clone's open would, and the offer goes. */
    async apply(workspaceId: string, offerId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
        const workspace = this.#ports.workspaces().find((w) => w.id === workspaceId);
        const offer = this.#offers.get(workspaceId)?.find((o) => o.id === offerId);
        if (!workspace || !offer) return { ok: false, reason: 'that offer is gone: the repo no longer differs from this machine there' };
        if (offer.change === 'changed') return { ok: false, reason: `${offer.file} differs from what you have here, so Genie does not replace it: change it by hand, or remove it here and apply the new one` };
        const text = await this.#ports.restore.files.read(this.#abs(workspace, offer.file));
        if (text === null) return { ok: false, reason: `${offer.file} is not there any more` };
        // Asked now, and waited for (Tynn #955): the offer's own file is what would run, and the kept verdict may be older than it.
        const trusted = (await this.#ports.restore.trusted(workspace.id)) === true;
        const done = await this.#restoreOne(workspace, offer, text, trusted);
        if (done.ok) { this.#prints.delete(workspace.id); await this.#scan(workspace, true); }
        return done;
    }

    async #restoreOne(workspace: { id: string; path: string }, offer: CloneOffer, text: string, trusted: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
        const waits = 'it runs commands, so it waits until you trust this workspace';
        if (offer.kind === 'flow') {
            const store = await this.#ports.restore.flows();
            if (store === null) return { ok: false, reason: 'the flow store is not open yet' };
            const out = await restoreFlows([{ path: offer.file, text }], workspace.id, store, { trusted });
            if (out.waiting.length > 0) return { ok: false, reason: waits };
            if (out.refused.length > 0) return { ok: false, reason: out.refused[0]!.reason };
            return { ok: true };
        }
        if (offer.kind === 'process') {
            const book = await this.#ports.restore.processes();
            if (book === null) return { ok: false, reason: 'the process book is not open yet' };
            const out = await restoreProcesses([{ path: offer.file, text }], { workspaceId: workspace.id, workspacePath: workspace.path, ports: book, trusted });
            if (out.waiting.length > 0) return { ok: false, reason: waits };
            if (out.refused.length > 0) return { ok: false, reason: out.refused[0]!.reason };
            return { ok: true };
        }
        try { await restoreTabsFile(workspace, text, this.#ports.restore); return { ok: true }; } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    }

    #abs(workspace: { path: string }, rel: string): string {
        return `${workspace.path.replace(/[\\/]+$/, '')}/${rel}`;
    }

    #forget(workspaceId: string): void {
        this.#prints.delete(workspaceId);
        if (this.#offers.delete(workspaceId)) for (const l of [...this.#listeners]) { try { l(workspaceId, []); } catch { /* one listener never costs another */ } }
    }

    /** The files of the three places with a stamp each: what a pass compares to see whether anything moved. */
    async #files(workspace: { path: string }): Promise<{ path: string; stamp: string | null }[]> {
        const out: { path: string; stamp: string | null }[] = [];
        for (const dir of ['.flows', '.processes']) {
            let names: string[] = [];
            try { names = await this.#ports.restore.files.list(this.#abs(workspace, dir)); } catch { /* not there: none */ }
            for (const name of names.filter((n) => n.toLowerCase().endsWith('.json')).sort()) out.push({ path: `${dir}/${name}`, stamp: await this.#ports.stamp(this.#abs(workspace, `${dir}/${name}`)) });
        }
        out.push({ path: '.genie/tabs.json', stamp: await this.#ports.stamp(this.#abs(workspace, '.genie/tabs.json')) });
        return out;
    }

    async #scan(workspace: { id: string; path: string }, force: boolean): Promise<void> {
        const files = await this.#files(workspace);
        const print = files.map((f) => `${f.path}=${f.stamp ?? ''}`).join('\n');
        if (!force && this.#prints.get(workspace.id) === print) return;
        this.#prints.set(workspace.id, print);
        const repo: RepoFile[] = [];
        for (const file of files) {
            if (file.stamp === null) continue;
            const text = await this.#ports.restore.files.read(this.#abs(workspace, file.path));
            if (text === null) continue;
            let value: unknown;
            try { value = JSON.parse(text); } catch { value = undefined; }
            repo.push({ path: file.path, value });
        }
        const { offers } = cloneOffers(repo, await this.#ports.live(workspace));
        const before = key(this.#offers.get(workspace.id) ?? []);
        this.#offers.set(workspace.id, offers);
        if (key(offers) !== before) for (const l of [...this.#listeners]) { try { l(workspace.id, offers); } catch { /* one listener never costs another */ } }
    }
}
