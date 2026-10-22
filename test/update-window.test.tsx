import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { changelogBetween, compareGenieVersions, type ReleaseLike, type UpdateChangelog } from '../src/core/update-notes.js';
import { updateChip } from '../src/core/update-chip.js';
import { whatsNewSection } from '../src/core/whats-new.js';
import { UpdateHost, type UpdaterPort } from '../src/main/updater.js';
import { UpdateWindow } from '../src/renderer/components/UpdateWindow.js';

/**
 * THE RELEASE NOTES IN THE UPDATE, AS GENIE 1 SHOWED THEM (the owner, 2026-10-19: "make sure that in this update we are
 * actually showing the release notes in the update ux like it did for genie 1"). Genie 1's upgrade window listed "What
 * is in this upgrade": every version between the running one and the offered one, grouped by version, newest first,
 * fetched from GitHub's releases — and said so when some could not be fetched.
 *
 * Measured 2026-10-19: Genie 2's hover popover (#954) never showed anything for a real update. It read
 * electron-updater's `releaseNotes`, which for a GitHub feed is the release body as HTML (`<h2>What's new</h2>`), and
 * looked for a MARKDOWN `## What's new` line. Its tests passed on a Markdown fixture the real feed never sends. The notes
 * now come from GitHub's releases API, whose `body` is our own Markdown (docs/releases/v<version>.md).
 */

const doc = (v: string) => readFileSync(`docs/releases/v${v}.md`, 'utf8');
const rel = (v: string, body: string | null = doc(v), draft = false): ReleaseLike => ({ tag_name: `v${v}`, body, draft });

describe('why not the feed’s notes', () => {
    it('the feed carries HTML, in which no Markdown "What’s new" section can be found (the #954 bug, measured)', () => {
        // The shape of releases.atom's <content> for 2.0.0-beta.30, as fetched on 2026-10-19.
        const feedHtml = "<h1>Genie 2.0.0-beta.30</h1> <h2>What's new</h2> <h3>Faster, and back to Genie 1's file browser</h3> <ul> <li>x</li> </ul>";
        expect(whatsNewSection(feedHtml)).toBeNull();
        // CONTROL: the same release's own Markdown has one.
        expect(whatsNewSection(doc('2.0.0-beta.30'))).toMatch(/Faster, and back to Genie 1's file browser/);
    });
});

describe('versions', () => {
    it('orders betas by number, and a release after its betas', () => {
        const sorted = ['2.0.0-beta.10', '2.0.0', '2.0.0-beta.9', '2.0.0-beta.31', '1.9.3'].sort(compareGenieVersions);
        expect(sorted).toEqual(['1.9.3', '2.0.0-beta.9', '2.0.0-beta.10', '2.0.0-beta.31', '2.0.0']);
    });
});

describe('what is in this update', () => {
    const releases = [rel('2.0.0-beta.30'), rel('2.0.0-beta.29'), rel('2.0.0-beta.28')];

    it('every version after yours, up to the one on offer, newest first, each its own What’s new (COUNTED)', () => {
        const c = changelogBetween(releases, '2.0.0-beta.28', '2.0.0-beta.30');
        expect(c.groups.map((g) => g.version)).toEqual(['2.0.0-beta.30', '2.0.0-beta.29']);
        expect(c.groups[0]!.notes).toBe(whatsNewSection(doc('2.0.0-beta.30')));
        expect(c.groups[1]!.notes).toBe(whatsNewSection(doc('2.0.0-beta.29')));
        expect(c.partial).toBe(false);
    });

    it('a draft is not a release; the version you run is not "new"', () => {
        const c = changelogBetween([rel('2.0.0-beta.31', '# x\n\n## What\'s new\n\n- draft\n', true), ...releases], '2.0.0-beta.29', '2.0.0-beta.30');
        expect(c.groups.map((g) => g.version)).toEqual(['2.0.0-beta.30']);
    });

    it('PARTIAL when the offered version is not among the releases read — never a short list passed off as the whole', () => {
        const c = changelogBetween(releases, '2.0.0-beta.28', '2.0.0-beta.31');
        expect(c.partial).toBe(true);
        expect(c.groups.map((g) => g.version)).toEqual(['2.0.0-beta.30', '2.0.0-beta.29']);
    });
});

describe('the update host fetches them when an update is found', () => {
    const fakePort = (version: string): UpdaterPort => ({ configure: () => {}, check: async () => ({ version }), download: async () => {}, quitAndInstall: () => {} });
    const host = (releases: () => Promise<ReleaseLike[]>) =>
        new UpdateHost({ port: fakePort('2.0.0-beta.30'), installDir: '/opt/genie', ownPid: 1, processes: () => [], kill: () => true, clock: () => 1, caseInsensitive: false, defer: () => {}, runningVersion: '2.0.0-beta.28', releases });

    it('available at once with the notes still coming (null), then the notes between the two versions', async () => {
        let give: ((r: ReleaseLike[]) => void) | null = null;
        const h = host(() => new Promise((resolve) => { give = resolve; }));
        const found = await h.check();
        expect(found).toMatchObject({ phase: 'available', version: '2.0.0-beta.30', changelog: null });
        give!([rel('2.0.0-beta.30'), rel('2.0.0-beta.29')]);
        await new Promise((r) => setTimeout(r, 0));
        const c = h.state().changelog;
        expect(c && c !== 'unavailable' ? c.groups.map((g) => g.version) : c).toEqual(['2.0.0-beta.30', '2.0.0-beta.29']);
        await h.download();
        expect(h.state()).toMatchObject({ phase: 'downloaded' });
        expect(h.state().changelog).toEqual(c);
    });

    it('offline: the notes are "unavailable" and the update is still on offer', async () => {
        const h = host(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')));
        await h.check();
        await new Promise((r) => setTimeout(r, 0));
        expect(h.state()).toMatchObject({ phase: 'available', changelog: 'unavailable' });
    });
});

/**
 * THE NOTES ARE READ AGAIN (the owner, 2026-10-22, on beta.38: "No release notes were published for this update").
 * beta.38 was public ~7 minutes before its body was written; an updater that checked in that window kept the empty
 * answer for as long as the update was on offer — the window said "No release notes" with the notes long published.
 * Now `refreshNotes()` (the window calls it when it opens; the auto-check calls it while an update is downloaded) fetches
 * again whenever what it holds is not the whole story: none, unavailable or partial. Fetches are COUNTED.
 */
describe('the update host reads the notes again', () => {
    const fakePort = (version: string): UpdaterPort => ({ configure: () => {}, check: async () => ({ version }), download: async () => {}, quitAndInstall: () => {} });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    function counted(...answers: Array<ReleaseLike[] | Error>) {
        const f = { calls: 0, releases: async (): Promise<ReleaseLike[]> => { const a = answers[Math.min(f.calls, answers.length - 1)]!; f.calls += 1; if (a instanceof Error) throw a; return a; } };
        return f;
    }
    const host = (releases: () => Promise<ReleaseLike[]>) =>
        new UpdateHost({ port: fakePort('2.0.0-beta.30'), installDir: '/opt/genie', ownPid: 1, processes: () => [], kill: () => true, clock: () => 1, caseInsensitive: false, defer: () => {}, runningVersion: '2.0.0-beta.29', releases });
    const versions = (h: UpdateHost) => { const c = h.state().changelog; return c && c !== 'unavailable' ? c.groups.map((g) => g.version) : c; };

    it('the beta.38 window: the release was public with an EMPTY body at the check; the window opening reads it again and the notes arrive', async () => {
        const f = counted([rel('2.0.0-beta.30', '')], [rel('2.0.0-beta.30')]);
        const h = host(f.releases);
        await h.check();
        await tick();
        expect(versions(h)).toEqual([]); // what the window showed as "No release notes were published"
        expect(f.calls).toBe(1);
        await h.refreshNotes();
        expect(f.calls).toBe(2);
        expect(versions(h)).toEqual(['2.0.0-beta.30']);
        expect(h.state()).toMatchObject({ phase: 'available', version: '2.0.0-beta.30' });
    });

    it('offline at the check, online after the download: a downloaded update reads its notes again', async () => {
        const f = counted(new Error('offline'), [rel('2.0.0-beta.30')]);
        const h = host(f.releases);
        await h.check();
        await tick();
        await h.download();
        expect(h.state()).toMatchObject({ phase: 'downloaded', changelog: 'unavailable' });
        await h.refreshNotes();
        expect(f.calls).toBe(2);
        expect(h.state().phase).toBe('downloaded');
        expect(versions(h)).toEqual(['2.0.0-beta.30']);
    });

    it('a complete changelog is NOT fetched again — counted', async () => {
        const f = counted([rel('2.0.0-beta.30')]);
        const h = host(f.releases);
        await h.check();
        await tick();
        expect(versions(h)).toEqual(['2.0.0-beta.30']);
        await h.refreshNotes();
        expect(f.calls).toBe(1);
    });

    it('a failed re-read does not wipe notes already shown; a partial list is read again', async () => {
        const f = counted([rel('2.0.0-beta.29')] /* offered not among them: partial */, new Error('offline'));
        const h = host(f.releases);
        await h.check();
        await tick();
        const before = h.state().changelog;
        expect(before && before !== 'unavailable' && before.partial).toBe(true);
        await h.refreshNotes();
        expect(f.calls).toBe(2);
        expect(h.state().changelog).toEqual(before);
    });

    it('no update on offer: nothing is fetched', async () => {
        const f = counted([rel('2.0.0-beta.30')]);
        const h = new UpdateHost({ port: { ...fakePort('x'), check: async () => null }, installDir: '/opt/genie', ownPid: 1, processes: () => [], kill: () => true, runningVersion: '2.0.0-beta.29', releases: f.releases });
        await h.refreshNotes();
        await h.check();
        await h.refreshNotes();
        expect(f.calls).toBe(0);
        expect(h.state().phase).toBe('none');
    });
});

describe('the window asks for the notes again when it opens', () => {
    const src = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

    it('the bridge carries it to the host (preload → ipc → UpdateHost.refreshNotes)', () => {
        expect(src('src/main/preload.ts')).toContain("notes: () => ipcRenderer.invoke('genie:updates-notes') as Promise<UpdateState | null>,");
        expect(src('src/main/main.ts')).toContain("ipcMain.handle('genie:updates-notes', () => updates?.refreshNotes() ?? null);");
    });

    it('opening the update window calls it', () => {
        expect(src('src/renderer/Shell.tsx')).toContain('onOpenUpdate={() => { setUpdateOpen(true); void updates.notes?.(); }}');
    });
});

describe('the update window', () => {
    function find(node: ReactNode, match: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
        const out: ReactElement<Record<string, unknown>>[] = [];
        const walk = (n: ReactNode): void => {
            if (Array.isArray(n)) { n.forEach(walk); return; }
            if (!isValidElement(n)) return;
            const el = n as ReactElement<Record<string, unknown>>;
            if (match(el)) out.push(el);
            walk(el.props.children as ReactNode);
        };
        walk(node);
        return out;
    }
    const changelog = changelogBetween([rel('2.0.0-beta.30'), rel('2.0.0-beta.29')], '2.0.0-beta.28', '2.0.0-beta.30');
    const chip = updateChip({ phase: 'available', version: '2.0.0-beta.30', percent: null, changelog })!;

    it('the chip carries the notes through', () => {
        expect(chip.changelog).toEqual(changelog);
    });

    it('lists every version’s notes, newest first, with the step that takes it (COUNTED: two versions, one action)', () => {
        let acted: string | null = null;
        const tree = UpdateWindow({ update: chip, onAction: (a) => { acted = a; }, onClose: () => {} });
        const html = renderToStaticMarkup(<>{find(tree, (el) => el.props['data-update-notes-version'] !== undefined)}</>);
        expect([...html.matchAll(/data-update-notes-version="([^"]+)"/g)].map((m) => m[1])).toEqual(['2.0.0-beta.30', '2.0.0-beta.29']);
        expect(html).toMatch(/Faster, and back to Genie 1/);
        const [button] = find(tree, (el) => el.props['data-action'] === 'update-download');
        expect(button).toBeDefined();
        (button!.props.onClick as () => void)();
        expect(acted).toBe('update-download');
    });

    it('says so: still fetching, partial, unavailable offline (the update is still safe), and none published', () => {
        const say = (cl: UpdateChangelog | 'unavailable' | null) => renderToStaticMarkup(<>{find(UpdateWindow({ update: { ...chip, changelog: cl }, onAction: () => {}, onClose: () => {} }), (el) => el.props['data-update-notes-state'] !== undefined)}</>);
        expect(say(null)).toMatch(/Fetching the release notes/);
        expect(say({ ...changelog, partial: true })).toMatch(/Some release notes could not be fetched/);
        expect(say('unavailable')).toMatch(/Couldn’t load the release notes \(offline\?\)\. The update is still safe to install\./);
        expect(say({ groups: [], partial: false })).toMatch(/No release notes were published for this update\./);
    });
});
