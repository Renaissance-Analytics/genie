import type { JsonObject } from '@particle-academy/prism-mcp';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { deckAnswerRoute, resolveDeckAnswer } from '../src/core/deck-resolve.js';
import { TRUST_DECK_ID } from '../src/core/gen-ca.js';
import { hostsFileBlock } from '../src/core/gen-router.js';
import { hostsApprovalDeckItem } from '../src/core/hosts-approval.js';
import { mintAgentId } from '../src/core/identity.js';
import { reachDeckItems, SITE_REACH_DECK_PREFIX, type HostsAsk } from '../src/core/site-reach.js';
import { answerDeck, type DeckAnswerPorts } from '../src/main/deck-answer.js';
import type { ElevationOutcome, PrivilegedStep } from '../src/main/elevate.js';
import type { HostingServices } from '../src/main/hosting-actions.js';
import { HOSTS_STEP_ID, type HostsIo } from '../src/main/hosts-file.js';
import { hostingTools } from '../src/main/mcp-tools-hosting.js';
import type { Caller, Registration } from '../src/main/mcp-tools.js';
import { DeckRow } from '../src/renderer/components/DeckRow.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/**
 * TYNN #743: MAKING A SITE REACHABLE FROM THE PERSON'S NORMAL BROWSER TOOK NINE UNEXPLAINED STEPS.
 *
 * What the client met (LiftPoint onboarding, 2026-11-16): an agent's own to-do with steps in it (Open → Show all → Done),
 * then Genie's "Trust Genie's certificate…" row (Trust), then the OS prompt — and since #753 a second Genie row for the
 * hosts file, with its own prompt. Two rows for one goal, neither saying "open your site", the why never drawn, and
 * nothing opened the site in the normal browser once it was approved.
 *
 * The contract now: ONE Genie row, "Open <name> in your browser". Its why says, in place, that the computer asks once
 * and what for. Open in browser is ONE OS prompt carrying everything due (the certificate and the hosts file together,
 * through the Trust's joinElevation), then the site opens in the person's normal browser. Not now puts the row away.
 * An agent's `sites add` tells the agent that Genie shows this row, so it writes no steps of its own.
 *
 * Inert stubs throughout: the window's elevation is a recorder, the hosts file and the trust store are fakes that change
 * only when the recorded prompt carried their step, and the normal browser is a list of URLs.
 */

let rig: HostingRig | null = null;
afterEach(async () => {
    await rig?.close();
    rig = null;
});

const SHOP_BLOCK = hostsFileBlock(['shop.gen']);
const WHY_BOTH = 'Your computer asks once for administrator permission: Genie adds shop.gen to your hosts file and trusts its own certificate. Until then the site works in Genie’s browser.';
const WHY_HOSTS = 'Your computer asks once for administrator permission: Genie adds shop.gen to your hosts file. Until then the site works in Genie’s browser.';
const WHY_TRUST = 'Your computer asks once for administrator permission: Genie trusts its own certificate. Until then the site works in Genie’s browser.';
const OPTIONS_WITH_BLOCK = [{ id: 'open', label: 'Open in browser', tone: 'ok' }, { id: 'later', label: 'Not now', tone: 'neutral' }, { id: 'copy-detail', label: 'Copy the block', tone: 'neutral' }];

const trust = (trusted: boolean, host: string | null = 'shop.gen') => ({ trusted, sites: 1, host, deferredFor: null, thumbprint: 'AB'.repeat(20), at: 5 });
const adding = (names: string[]): HostsAsk => ({ added: names, removed: [], manualBlock: hostsFileBlock(names), at: 7 });

function reachItem(over: Partial<DeckItem> = {}): DeckItem {
    return {
        id: `${SITE_REACH_DECK_PREFIX}shop.gen`, source: 'genie', agentId: null, agentName: null, workspaceId: null,
        title: 'Open shop.gen in your browser', blocking: false, priority: 'normal', at: 7,
        answer: { kind: 'inline', options: OPTIONS_WITH_BLOCK as never }, forwardedFrom: null, why: WHY_BOTH, detail: SHOP_BLOCK, ...over,
    };
}

// ---- The row itself: one, in plain words. ----

describe('Genie asks ONCE, as “Open <name> in your browser”', () => {
    it.each([
        ['certificate untrusted AND a hosts write due', trust(false), adding(['shop.gen']), reachItem()],
        ['certificate trusted, a hosts write due', trust(true), adding(['shop.gen']), reachItem({ why: WHY_HOSTS })],
        ['certificate untrusted, the hosts file already right', trust(false), null, reachItem({ why: WHY_TRUST, at: 5, detail: undefined, answer: { kind: 'inline', options: OPTIONS_WITH_BLOCK.slice(0, 2) as never } })],
    ])('%s → exactly one row', (_, t, hosts, expected) => {
        const items = reachDeckItems({ trust: t, hosts });
        expect(items).toHaveLength(1);
        const [item] = items;
        expect({ ...item, detail: item!.detail }).toEqual({ ...expected, detail: expected.detail });
    });

    it('CONTROL: a removal alone is not about opening anything — the hosts-file ask, as #753 wrote it', () => {
        const removal: HostsAsk = { added: [], removed: ['old.gen'], manualBlock: hostsFileBlock([]), at: 9 };
        expect(reachDeckItems({ trust: trust(true), hosts: removal })).toEqual([hostsApprovalDeckItem(removal)]);
    });

    it('CONTROL: nothing due (trusted, hosts file right) → no row', () => {
        expect(reachDeckItems({ trust: trust(true), hosts: null })).toEqual([]);
    });
});

describe('its answers', () => {
    it('Open in browser → open https://<name>; Not now → put away; Copy the block copies in the window', () => {
        const item = reachItem();
        expect(resolveDeckAnswer(item, 'open')).toEqual({ kind: 'open-site', url: 'https://shop.gen' });
        expect(resolveDeckAnswer(item, 'later')).toEqual({ kind: 'defer-open-site' });
        expect(deckAnswerRoute(item, 'copy-detail')).toEqual({ kind: 'copy', text: SHOP_BLOCK });
    });

    it('CONTROL: Hosting’s own Trust row still answers as before', () => {
        const t: DeckItem = { ...reachItem(), id: TRUST_DECK_ID, answer: { kind: 'inline', options: [{ id: 'trust', label: 'Trust', tone: 'ok' }] } };
        expect(resolveDeckAnswer(t, 'trust')).toEqual({ kind: 'trust-certificate' });
    });
});

describe('the why is drawn in place, not behind Show all', () => {
    const row = (item: DeckItem) => renderToStaticMarkup(
        <DeckRow item={item} answering={null} onAnswer={() => {}} onOpenItem={() => {}} formRefusal={null} focusId={null} focusRef={{ current: null }} now={0} />,
    );

    it('a Genie row shows its why under the title, closed', () => {
        const [item] = reachDeckItems({ trust: trust(false), hosts: adding(['shop.gen']) });
        expect(row(item!)).toContain(`data-deck-why="${item!.id}"`);
        expect(row(item!)).toContain('Your computer asks once for administrator permission');
    });

    it('CONTROL: an agent’s to-do with no why draws no why line', () => {
        const todo: DeckItem = { ...reachItem(), id: 'list:ws:1', source: 'user-list', agentId: 'a1', agentName: 'atlas', why: undefined, detail: undefined };
        expect(row(todo)).not.toContain('data-deck-why');
    });
});

// ---- Through genie-host's real hosting: one prompt, then the normal browser. ----

/** A rig whose hosts file and trust store change only when a prompt the window approved carried their step. */
async function reachRig(options: { trusted?: boolean } = {}): Promise<HostingRig> {
    // What the rig's window approved (its elevationsAsked), read when the fakes are read.
    let made: HostingRig | null = null;
    let staged = '';
    const carried = (id: string) => (made?.elevationsAsked ?? []).some((b) => b.some((s) => s.id === id));
    const hostsIo: HostsIo = {
        read: async () => (carried(HOSTS_STEP_ID) ? staged : ''),
        write: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
        stage: async (next) => { staged = next; return { command: 'cp', args: [] }; },
    };
    const r = await hostingRig({ hosting: { hostsIo, trustStore: { has: async () => options.trusted === true || carried('trust') } } });
    made = r;
    return r;
}

const settled = async (r: HostingRig) => { await tick(); await r.stack.frontDoorSettled(); await tick(); };
const genieRows = (r: HostingRig) => r.stack.trustDeckItems().map((i) => i.id);

async function shopAdded(r: HostingRig) {
    await r.stack.envelopeSites.create({ name: 'shop', workspaceId: 'ws', repoPath: r.ws, serve: { mode: 'proxy' }, hostPort: 5175 });
    await settled(r);
}

function portsFor(w: Awaited<ReturnType<HostingRig['window']>>, opened: string[]): DeckAnswerPorts {
    return {
        attention: {} as never, approvals: {} as never, inbox: {} as never,
        trustCertificate: () => w.replica.trustCertificate(), deferTrustCertificate: () => w.replica.deferTrustCertificate(),
        syncHosts: () => w.replica.syncHosts(), deferHosts: () => w.replica.deferHosts(),
        openExternal: async (url: string) => { opened.push(url); },
    } as DeckAnswerPorts;
}

describe('Open in browser, end to end', () => {
    it('a new site with the certificate untrusted → ONE Genie row, not a Trust row and a hosts row', async () => {
        rig = await reachRig();
        await rig.window();
        await shopAdded(rig);
        expect(genieRows(rig)).toEqual([`${SITE_REACH_DECK_PREFIX}shop.gen`]);
    });

    it('Open in browser → ONE prompt carrying the certificate AND the hosts file, then https://shop.gen opens; the row is gone', async () => {
        rig = await reachRig();
        const w = await rig.window();
        await shopAdded(rig);
        const item = rig.stack.trustDeckItems().find((i) => i.id.startsWith(SITE_REACH_DECK_PREFIX));
        const opened: string[] = [];
        await answerDeck({ kind: 'deck.answer', item: item!, optionId: 'open' }, portsFor(w, opened));
        await settled(rig);
        expect(rig.elevationsAsked.map((b) => b.map((s) => s.id))).toEqual([['trust', HOSTS_STEP_ID]]);
        expect(opened).toEqual(['https://shop.gen']);
        expect(genieRows(rig)).toEqual([]);
    });

    it('certificate already trusted → ONE prompt with the hosts file alone, then it opens', async () => {
        rig = await reachRig({ trusted: true });
        const w = await rig.window();
        await shopAdded(rig);
        const item = rig.stack.trustDeckItems().find((i) => i.id.startsWith(SITE_REACH_DECK_PREFIX));
        const opened: string[] = [];
        await answerDeck({ kind: 'deck.answer', item: item!, optionId: 'open' }, portsFor(w, opened));
        await settled(rig);
        expect(rig.elevationsAsked.map((b) => b.map((s) => s.id))).toEqual([[HOSTS_STEP_ID]]);
        expect(opened).toEqual(['https://shop.gen']);
    });

    it('Not now → the row goes and nothing is asked of the computer', async () => {
        rig = await reachRig();
        const w = await rig.window();
        await shopAdded(rig);
        const item = rig.stack.trustDeckItems().find((i) => i.id.startsWith(SITE_REACH_DECK_PREFIX));
        await answerDeck({ kind: 'deck.answer', item: item!, optionId: 'later' }, portsFor(w, []));
        await settled(rig);
        expect(genieRows(rig)).toEqual([]);
        expect(rig.elevationsAsked).toEqual([]);
    });

    it('a declined prompt opens nothing and says why', async () => {
        rig = await reachRig();
        const asked: string[][] = [];
        const w = await rig.window({ client: { elevate: async (steps: readonly PrivilegedStep[]): Promise<ElevationOutcome> => { asked.push(steps.map((s) => s.id)); return { ok: false, failed: null, error: 'The operation was canceled by the user.' }; } } as never });
        await shopAdded(rig);
        const item = rig.stack.trustDeckItems().find((i) => i.id.startsWith(SITE_REACH_DECK_PREFIX));
        const opened: string[] = [];
        await expect(answerDeck({ kind: 'deck.answer', item: item!, optionId: 'open' }, portsFor(w, opened))).rejects.toThrow(/canceled by the user/);
        expect(asked).toEqual([['trust', HOSTS_STEP_ID]]);
        expect(opened).toEqual([]);
    });
});

// ---- The agent is told, so it writes no steps of its own. ----

describe('an agent’s `sites add` says Genie shows the person the row', () => {
    it('the result names “Open <name> in your browser” and tells the agent not to put steps on the person’s list', async () => {
        rig = await reachRig();
        const s = rig.stack;
        const caller: Caller = { agentId: mintAgentId(), agentName: 'atlas', workspaceId: 'ws', workspacePath: rig.ws };
        const services = {
            sites: s.sites, envelopeSites: s.envelopeSites, engines: s.engines, supervisor: rig.supervisor,
            routes: () => s.routes(), engineStatuses: () => s.engineStatuses(),
        } as unknown as HostingServices;
        const tools: Registration[] = hostingTools({ resolveCaller: (id: string) => (id === 't-atlas' ? caller : null), approve: async () => 'allowed', services, trusted: () => true } as never);
        const sites = tools.find((t) => t.definition.name === 'sites')!;
        const out = await sites.handler({ terminalId: 't-atlas', action: 'add', name: 'shop', repoPath: rig.ws, mode: 'proxy', hostPort: 5175 } as JsonObject, { server: 'genie', tool: 'sites', headers: {} } as never);
        const json = JSON.parse(String(out.text)) as { hostsFile?: string };
        expect(json.hostsFile).toContain('“Open shop.gen in your browser”');
        expect(json.hostsFile).toContain('do not put steps for it on their list');
    });
});
