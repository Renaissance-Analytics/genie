import type { DeckItem } from './deck.js';

/**
 * WHAT A HOST COULD NOT RESTORE (the host split, P7.3; Tynn #419).
 *
 * A workstation's machine is disposable: the host starts on its data root on a rebuilt machine, makes every machine file
 * again, and SAYS what it could not bring back. Secrets live in the OS keychain and do not survive a rebuilt desktop, so
 * each one the root still points at and the keychain no longer holds is an item with what to do about it — never a
 * silent "signed out". What Genie installed outside the root (its certificate's trust, the hosts file, the PATH, the
 * firewall rule) and what never was in the root (the databases' own data, in Docker's volumes) is named once.
 *
 * Pure: the facts in, the items out. main/attach-host.ts gathers the facts (presence only: no secret is read into them)
 * and carries out the actions.
 */

/** How this start found the root (main/data-root.ts `attachDataRoot`). */
export type AttachKind =
    /** No manifest that names a machine: a new root, or one an older Genie wrote. Nothing to say. */
    | 'first'
    /** The machine that wrote the manifest. */
    | 'same'
    /** The state is here and the machine files are not: the root was put back on a rebuilt machine. */
    | 'machine-files-gone'
    /** The manifest names another machine: the whole root was moved, machine files and all. */
    | 'another-machine';

export const ATTACH_DECK_PREFIX = 'genie:attach:';

/** What the person can do from the item itself. */
export type AttachAction = 'tynn-sign-in' | 'github-sign-in' | 'agent-keys' | 'workstation-register';

export interface AttachFacts {
    readonly attach: AttachKind;
    /** Whether the keychain answers. When it does not, nothing below is judged missing: "we could not look" is not "it is gone". */
    readonly keychainAnswers: boolean;
    /** Tynn: an account is on record in the root; `held` = its credential is in the keychain. */
    readonly tynn: { readonly onRecord: boolean; readonly held: boolean; readonly signedIn: boolean };
    readonly github: { readonly login: string | null; readonly held: boolean };
    /** The agents' own Tynn keys on record, and how many of them the keychain no longer holds. */
    readonly agentKeys: { readonly onRecord: number; readonly missing: number };
    /** This machine as a workstation: the id on record, and whether its key is held. */
    readonly workstation: { readonly recordedId: string | null; readonly held: boolean };
    /** The machines this one was paired with, and whether each one's token is held. */
    readonly devices: ReadonlyArray<{ readonly url: string; readonly held: boolean }>;
    /** Made again by the host on this start. */
    readonly remade: { readonly mailInboxes: number; readonly proofKey: boolean };
    /** What the root says this machine ran: the sites served and the service engines (their data is Docker's). */
    readonly sites: number;
    readonly engines: number;
    /** Where Tynn lists the account's workstations. */
    readonly tynnWorkstationsUrl: string;
    /** Machine folders the attach could not move away, in words. */
    readonly notRemoved: readonly string[];
}

export interface AttachItem {
    /** `genie:attach:<key>`. */
    readonly id: string;
    readonly title: string;
    readonly detail: string;
    readonly action: { readonly id: AttachAction; readonly label: string } | null;
    /**
     * STANDING: it is so for as long as the thing is missing, and goes by itself when it is back. Not standing: said once
     * for this attach, until the person puts it away.
     */
    readonly standing: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const rebuilt = (kind: AttachKind): boolean => kind === 'machine-files-gone' || kind === 'another-machine';

export const ATTACH_WORDS = {
    signInFirst: 'Sign in to Tynn first: Settings → Integrations.',
    /** The same record, re-keyed (Tynn found this machine by its machine id). */
    workstationSame: 'This machine is registered again as the same workstation. Its permission to drive your other machines is removed until you approve it again in Tynn (it asks for your 2FA code).',
    /** A new record. */
    workstationNew: 'Tynn does not recognise this machine, so it is registered as a new workstation: its share links and paired devices must be made again, and the old entry stays in Tynn’s list until you delete it there.',
} as const;

/** The items, in the order a person would act on them: Tynn first, since two others wait on it. */
export function attachItems(facts: AttachFacts): AttachItem[] {
    const items: AttachItem[] = [];
    const item = (key: string, title: string, detail: string, action: AttachItem['action'], standing: boolean): void => { items.push({ id: `${ATTACH_DECK_PREFIX}${key}`, title, detail, action, standing }); };
    const where = facts.attach === 'another-machine' ? 'This Genie’s data was moved here from another machine.' : 'This Genie’s data was put back on a rebuilt machine.';

    if (facts.keychainAnswers) {
        if (facts.tynn.onRecord && !facts.tynn.held) {
            item('tynn', 'Sign in to Tynn again',
                'Your Tynn sign-in is not in this computer’s keychain. Until you sign in again, agents have no Tynn tools and this machine is not reachable through Tynn. Open Tynn, then paste the code in Settings → Integrations.',
                { id: 'tynn-sign-in', label: 'Open Tynn in your browser' }, true);
        }
        if (facts.github.login !== null && !facts.github.held) {
            item('github', 'Sign in to GitHub again',
                `The GitHub sign-in for ${facts.github.login} is not in this computer’s keychain. Until you sign in again, Genie cannot push, pull private repositories or read issues. The code to type is shown in Settings → Integrations.`,
                { id: 'github-sign-in', label: 'Sign in to GitHub' }, true);
        }
        if (facts.agentKeys.missing > 0) {
            item('agent-keys', `${plural(facts.agentKeys.missing, 'agent’s Tynn key is', 'agents’ Tynn keys are')} not in this computer’s keychain`,
                `${facts.agentKeys.missing === 1 ? 'That agent starts' : 'Those agents start'} without Tynn tools until a new key is made. ${facts.tynn.signedIn ? '' : `${ATTACH_WORDS.signInFirst} `}The lost keys stay listed under each agent in Tynn until you revoke them there.`,
                { id: 'agent-keys', label: 'Make new keys' }, true);
        }
        if (facts.workstation.recordedId !== null && !facts.workstation.held) {
            item('workstation', 'Register this machine with Tynn again',
                `This machine is workstation ${facts.workstation.recordedId}, and its key is not in this computer’s keychain, so it cannot prove itself to Tynn: your other machines and share links cannot reach it. ${facts.tynn.signedIn ? '' : `${ATTACH_WORDS.signInFirst} `}`
                + `Registering it again makes a new key. This machine’s permission to drive your other machines is removed until you approve it again in Tynn (it asks for your 2FA code). If Tynn does not recognise this machine it is registered as a new workstation: its share links and paired devices must be made again, and the old entry stays in Tynn’s list until you delete it there: ${facts.tynnWorkstationsUrl}`,
                { id: 'workstation-register', label: 'Register this machine again' }, true);
        }
        const unpaired = facts.devices.filter((d) => !d.held);
        if (unpaired.length > 0) {
            item('devices', `Pair again with ${plural(unpaired.length, 'machine', 'machines')}`,
                `The pairing with ${unpaired.map((d) => d.url).join(', ')} is not in this computer’s keychain. Connect to ${unpaired.length === 1 ? 'it' : 'each'} again and type the PIN that machine shows.`,
                null, true);
        }
    }

    if (rebuilt(facts.attach)) {
        const remade = [
            ...(facts.remade.mailInboxes > 0 ? [`the password of ${plural(facts.remade.mailInboxes, 'mail inbox', 'mail inboxes')} (the sites that send mail are given the new one)`] : []),
            ...(facts.remade.proofKey ? ['a new key that signs proof-of-done notes (the keychain held none; notes signed with an older key still verify against that key in Tynn)'] : []),
        ];
        if (remade.length > 0) item('remade', 'Genie made some keys again', `${where} These were not in this computer’s keychain and Genie made new ones: ${remade.join('; ')}. Nothing to do.`, null, false);
        if (facts.sites > 0 || facts.engines > 0) {
            item('machine', 'Set this machine up again for your sites',
                `${where} What Genie installs on a machine is not in its data: trusting Genie’s certificate, the hosts file entries for your .gen names, the PATH and the firewall rule. Genie asks for each as it is needed, and Hosting → Check and repair does them now.`
                + (facts.engines > 0 ? ` NOT restored: the data inside ${plural(facts.engines, 'service engine', 'service engines')} (databases, files, mail). It lives in Docker’s volumes, which never were in Genie’s data; the engines start empty with the same names and passwords.` : ''),
                null, false);
        }
        if (facts.notRemoved.length > 0) {
            item('not-removed', 'Some of the other machine’s files could not be put away', `${where} Genie makes its machine files again on every start; these could not be moved out of the way first: ${facts.notRemoved.join('; ')}.`, null, false);
        }
    }
    return items;
}

/** The Deck's item for one of them: its action when it has one, and Dismiss. */
export function attachDeckItem(item: AttachItem, at: number): DeckItem {
    return {
        id: item.id,
        source: 'genie',
        agentId: null,
        agentName: null,
        workspaceId: null,
        title: item.title,
        blocking: false,
        priority: 'normal',
        at,
        answer: { kind: 'inline', options: [...(item.action ? [{ id: item.action.id, label: item.action.label, tone: 'ok' as const }] : []), { id: 'dismiss', label: 'Dismiss', tone: 'neutral' as const }] },
        forwardedFrom: null,
        detail: item.detail,
    };
}

const ACTIONS: readonly AttachAction[] = ['tynn-sign-in', 'github-sign-in', 'agent-keys', 'workstation-register'];

/** What an answer to an attach item asks for: its action, or putting it away. `null` = neither. */
export function attachAnswer(optionId: string): { readonly kind: 'act'; readonly action: AttachAction } | { readonly kind: 'dismiss' } | null {
    if (optionId === 'dismiss') return { kind: 'dismiss' };
    const action = ACTIONS.find((a) => a === optionId);
    return action ? { kind: 'act', action } : null;
}
