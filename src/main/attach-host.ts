import { ATTACH_DECK_PREFIX, ATTACH_WORDS, attachAnswer, attachDeckItem, attachItems, type AttachAction, type AttachFacts, type AttachItem, type AttachKind } from '../core/attach-report.js';
import type { DeckItem } from '../core/deck.js';
import type { KeychainRead, KeychainResult, SecretName } from './keychain.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * WHAT THIS HOST COULD NOT RESTORE, KEPT AND ACTED ON (the host split, P7.3; Tynn #419; core/attach-report.ts has the words).
 *
 * genie-host opens this right after it attaches its data root (data-root.ts `attachDataRoot`). It looks at what the root
 * still points at and whether the keychain holds each one — PRESENCE ONLY: a read's kind is kept, its value never is —
 * and gives the Deck one item per thing that is missing, with its action. A standing item goes by itself when the thing
 * is back (the person signed in again); the ones said once for an attach stay until they are put away.
 *
 * Its record is a MACHINE file (`runtime/attach-report.json`): how this machine's first start on the root found it, what
 * the host made again, and what the person dismissed. Another machine starts its own.
 */

export interface AttachSecrets {
    probe(): Promise<KeychainResult>;
    get(name: SecretName): Promise<KeychainRead>;
}

/** What is known as soon as the root is attached: enough to note, before anything makes them again, which keys are gone. */
export interface AttachHostPorts {
    /** `runtime/attach-report.json`. */
    readonly file: string;
    /** How this start found the root, and what it could not move away. */
    readonly attach: { readonly kind: AttachKind; readonly notRemoved: readonly string[] };
    readonly secrets: AttachSecrets;
    /** The default mail inboxes on record. */
    readonly mailInboxIds: () => Promise<readonly string[]>;
    readonly now?: () => number;
    readonly log?: (line: string) => void;
}

/** The accounts and services, given once the host has made them (`wire`). Until then there are no items. */
export interface AttachSources {
    /** The Tynn account, once it has opened: is one on record (signed in or not), and is it signed in now. `null` = not open yet. */
    readonly tynn: () => { readonly onRecord: boolean; readonly signedIn: boolean } | null;
    /** The GitHub login on record, signed in or expired; `null` = none, or not open yet. */
    readonly githubLogin: () => string | null;
    /** The public ids of the agents' Tynn keys on record. */
    readonly agentKeyIds: () => Promise<readonly string[]>;
    /** The workstation id on record for this Tynn, and the name its key is kept under. */
    readonly workstation: () => Promise<{ readonly id: string | null; readonly secret: SecretName }>;
    /** The machines this one is paired with. */
    readonly deviceUrls: () => readonly string[];
    readonly sites: () => number;
    readonly engines: () => number;
    readonly tynnWorkstationsUrl: string;
    readonly act: {
        tynnSignIn(): Promise<void>;
        githubSignIn(): Promise<void>;
        /** Makes each lost key again; says how many it made, or why none. */
        agentKeys(): Promise<{ readonly ok: true; readonly made: number } | { readonly ok: false; readonly reason: string }>;
        /** Registers this machine again; `same` = Tynn kept its record. */
        workstationRegister(): Promise<{ readonly ok: true; readonly outcome: 'same' | 'new'; readonly workstationId: string } | { readonly ok: false; readonly reason: string }>;
    };
}

interface AttachRecord {
    /** The attach this machine's record began with: `first`/`same` never replace a rebuilt one. */
    readonly attach: AttachKind;
    readonly at: number;
    readonly remade: { readonly mailInboxes: number; readonly proofKey: boolean };
    readonly notRemoved: readonly string[];
    readonly dismissed: readonly string[];
    /** What the last action said (the workstation's outcome), shown as its own item until dismissed. */
    readonly said: readonly AttachItem[];
}

const rebuilt = (kind: AttachKind): boolean => kind === 'machine-files-gone' || kind === 'another-machine';
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

export class AttachHost {
    readonly #ports: AttachHostPorts;
    #record: AttachRecord;
    #sources: AttachSources | null = null;
    #items: readonly AttachItem[] = [];
    readonly #listeners = new Set<() => void>();
    #work: Promise<unknown> = Promise.resolve();

    private constructor(ports: AttachHostPorts, record: AttachRecord) {
        this.#ports = ports;
        this.#record = record;
    }

    /**
     * Opened BEFORE the mail service starts: on a rebuilt machine it notes which inbox passwords are not in the keychain
     * now, since the mail service makes new ones by itself and afterwards nothing could tell.
     */
    static async open(ports: AttachHostPorts): Promise<AttachHost> {
        const now = ports.now ?? Date.now;
        const kept = await readJson<Partial<AttachRecord> | null>(ports.file, null).catch(() => null);
        let record: AttachRecord;
        if (rebuilt(ports.attach.kind)) {
            let mailInboxes = 0;
            if ((await ports.secrets.probe()).ok) {
                for (const id of await ports.mailInboxIds().catch(() => [] as string[])) if ((await ports.secrets.get(`mail/inbox/${id}`)).kind === 'missing') mailInboxes += 1;
            }
            record = { attach: ports.attach.kind, at: now(), remade: { mailInboxes, proofKey: false }, notRemoved: [...ports.attach.notRemoved], dismissed: [], said: [] };
            await writeJsonAtomic(ports.file, record).catch((error: unknown) => ports.log?.(`attach report: not saved: ${error instanceof Error ? error.message : String(error)}`));
        } else {
            const attach = kept?.attach === 'machine-files-gone' || kept?.attach === 'another-machine' ? kept.attach : ports.attach.kind;
            record = {
                attach,
                at: typeof kept?.at === 'number' ? kept.at : now(),
                remade: { mailInboxes: typeof kept?.remade?.mailInboxes === 'number' ? kept.remade.mailInboxes : 0, proofKey: kept?.remade?.proofKey === true },
                notRemoved: strings(kept?.notRemoved),
                dismissed: strings(kept?.dismissed),
                said: Array.isArray(kept?.said) ? kept.said.filter((s): s is AttachItem => typeof s?.id === 'string' && typeof s.title === 'string' && typeof s.detail === 'string').map((s) => ({ id: s.id, title: s.title, detail: s.detail, action: null, standing: false })) : [],
            };
        }
        return new AttachHost(ports, record);
    }

    /** The accounts and services are there: look, and say what is missing. */
    wire(sources: AttachSources): Promise<void> {
        this.#sources = sources;
        return this.refresh();
    }

    /** The facts now; null before `wire`. Each keychain read keeps its kind and drops its value. */
    async facts(): Promise<AttachFacts | null> {
        const p = this.#sources;
        if (p === null) return null;
        const secrets = this.#ports.secrets;
        const answers = (await secrets.probe()).ok;
        const held = async (name: SecretName): Promise<boolean> => (await secrets.get(name)).kind !== 'missing';
        const tynn = p.tynn();
        const login = p.githubLogin();
        const keyIds = answers ? await p.agentKeyIds().catch(() => [] as string[]) : [];
        let missingKeys = 0;
        for (const id of keyIds) if (!(await held(`tynn/agent/${id}`))) missingKeys += 1;
        const workstation: { readonly id: string | null; readonly secret: SecretName } = await p.workstation().catch(() => ({ id: null, secret: 'workstation/unknown' as SecretName }));
        const devices: Array<{ url: string; held: boolean }> = [];
        for (const url of p.deviceUrls()) devices.push({ url, held: answers ? await held(`device/${url}`) : true });
        return {
            attach: this.#record.attach,
            keychainAnswers: answers,
            tynn: { onRecord: tynn?.onRecord === true, held: !answers || tynn === null || !tynn.onRecord || await held('tynn/pairing'), signedIn: tynn?.signedIn === true },
            github: { login, held: !answers || login === null || await held('github/access') },
            agentKeys: { onRecord: keyIds.length, missing: missingKeys },
            workstation: { recordedId: workstation.id, held: !answers || workstation.id === null || await held(workstation.secret) },
            devices,
            remade: this.#record.remade,
            sites: p.sites(),
            engines: p.engines(),
            tynnWorkstationsUrl: p.tynnWorkstationsUrl,
            notRemoved: this.#record.notRemoved,
        };
    }

    /** Look again: after a sign-in, when the keychain starts answering, after an action. One at a time. */
    refresh(): Promise<void> {
        const run = this.#work.then(async () => {
            const before = JSON.stringify(this.#items);
            const facts = await this.facts();
            if (facts === null) return;
            const items = [...attachItems(facts), ...this.#record.said];
            // An item that is no longer so is forgotten as dismissed: if it is missing again later, it is said again.
            const dismissed = this.#record.dismissed.filter((id) => items.some((i) => i.id === id));
            if (dismissed.length !== this.#record.dismissed.length) await this.#save({ ...this.#record, dismissed });
            this.#items = items.filter((i) => !this.#record.dismissed.includes(i.id));
            if (JSON.stringify(this.#items) !== before) for (const l of [...this.#listeners]) l();
        });
        this.#work = run.catch((error: unknown) => { this.#ports.log?.(`attach report: ${error instanceof Error ? error.message : String(error)}`); });
        return this.#work.then(() => undefined);
    }

    /**
     * Proof-of-done made a new signing key (the keychain held none). On a rebuilt machine that is one of the things made
     * again, said once; on any other start it is a first key, and nothing to say.
     */
    async noteProofKeyMade(): Promise<void> {
        if (!rebuilt(this.#record.attach) || this.#record.remade.proofKey) return;
        await this.#save({ ...this.#record, remade: { ...this.#record.remade, proofKey: true } });
        await this.refresh();
    }

    /** What could not be restored, now. */
    view(): readonly AttachItem[] { return this.#items; }
    items(): DeckItem[] { return this.#items.map((i) => attachDeckItem(i, this.#record.at)); }
    has(id: string): boolean { return this.#items.some((i) => i.id === id); }
    onChange(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }

    /** The person's answer to one item: its action, or Dismiss. A refusal is thrown in words; the item stays. */
    async answer(id: string, optionId: string): Promise<void> {
        const item = this.#items.find((i) => i.id === id);
        if (!item) throw new Error('This is no longer waiting here. Nothing was done.');
        const answer = attachAnswer(optionId);
        if (answer === null || (answer.kind === 'act' && item.action?.id !== answer.action)) throw new Error(`${item.title} has no such action`);
        if (answer.kind === 'dismiss') {
            await this.#save({ ...this.#record, dismissed: [...new Set([...this.#record.dismissed, id])], said: this.#record.said.filter((s) => s.id !== id) });
            await this.refresh();
            return;
        }
        await this.#act(answer.action);
        await this.refresh();
    }

    async #act(action: AttachAction): Promise<void> {
        const p = this.#sources;
        if (p === null) throw new Error('Genie is still starting; try again in a moment');
        const log = this.#ports.log;
        const signedIn = p.tynn()?.signedIn === true;
        switch (action) {
            case 'tynn-sign-in': await p.act.tynnSignIn(); return;
            case 'github-sign-in': await p.act.githubSignIn(); return;
            case 'agent-keys': {
                if (!signedIn) throw new Error(ATTACH_WORDS.signInFirst);
                const made = await p.act.agentKeys();
                if (!made.ok) throw new Error(made.reason);
                log?.(`attach report: ${made.made} agent key(s) taken off record; each agent gets a new one at its next start`);
                return;
            }
            case 'workstation-register': {
                if (!signedIn) throw new Error(ATTACH_WORDS.signInFirst);
                const registered = await p.act.workstationRegister();
                if (!registered.ok) throw new Error(registered.reason);
                log?.(`attach report: this machine registered again: ${registered.outcome} (${registered.workstationId})`);
                const said: AttachItem = {
                    id: `${ATTACH_DECK_PREFIX}workstation-registered`,
                    title: registered.outcome === 'same' ? 'This machine is registered again: approve it in Tynn' : 'This machine is registered as a new workstation',
                    detail: `${registered.outcome === 'same' ? ATTACH_WORDS.workstationSame : ATTACH_WORDS.workstationNew} ${p.tynnWorkstationsUrl}`,
                    action: null,
                    standing: false,
                };
                await this.#save({ ...this.#record, said: [...this.#record.said.filter((s) => s.id !== said.id), said], dismissed: this.#record.dismissed.filter((d) => d !== said.id) });
                return;
            }
        }
    }

    async #save(record: AttachRecord): Promise<void> {
        this.#record = record;
        await writeJsonAtomic(this.#ports.file, record).catch((error: unknown) => this.#ports.log?.(`attach report: not saved: ${error instanceof Error ? error.message : String(error)}`));
    }
}
