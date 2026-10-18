import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { signalStrip, type SignalState } from '../src/core/deck.js';
import { updateChip } from '../src/core/update-chip.js';
import { Deck } from '../src/renderer/components/Deck.js';
import { TitleBar } from '../src/renderer/components/TitleBar.js';

/**
 * THE UPDATE IS IN THE HEADER (the owner, 2026-10-13, with a screenshot of "Genie 2.0.0-beta.19 is available — download"
 * on the Deck: "the update notice should be in the header, not buried in the deck page"). The title bar carries it on
 * every surface, beside the workstation chip, from `available` on: the door is the next step (download; restart to
 * install), the progress while it downloads, nothing while there is nothing to act on. The Deck's signal strip no longer
 * carries it — one notice, in one place.
 */
const u = (phase: string, version: string | null = '2.0.0-beta.20', percent: number | null = null) => ({ phase, version, percent, error: null, checkedAt: null }) as never;
const bar = (update: ReturnType<typeof updateChip>) =>
    renderToStaticMarkup(<TitleBar route="genie://dashboard" workstation={{ name: 'alphar', healthy: true }} onNavigate={() => {}} onOpenPalette={() => {}} update={update} onUpdateAction={() => {}} />);

describe('the chip', () => {
    it('available → download; downloading → its progress; downloaded → restart to install; installing → said so', () => {
        expect(updateChip(u('available'))).toEqual({ phase: 'available', label: 'Genie 2.0.0-beta.20 is available — download', action: 'update-download', version: '2.0.0-beta.20' });
        expect(updateChip(u('downloading', '2.0.0-beta.20', 42.4))).toEqual({ phase: 'downloading', label: 'Downloading Genie 2.0.0-beta.20 42%', action: null, version: '2.0.0-beta.20' });
        expect(updateChip(u('downloaded'))).toEqual({ phase: 'downloaded', label: 'Genie 2.0.0-beta.20 is ready — restart to install', action: 'update-install', version: '2.0.0-beta.20' });
        expect(updateChip(u('installing'))).toEqual({ phase: 'installing', label: 'Installing Genie 2.0.0-beta.20…', action: null, version: '2.0.0-beta.20' });
    });

    it('nothing while there is nothing to act on — idle, checking, none, error, no version, no updater', () => {
        for (const p of ['idle', 'checking', 'none', 'error']) expect(updateChip(u(p))).toBeNull();
        expect(updateChip(u('available', null))).toBeNull();
        expect(updateChip(null)).toBeNull();
    });
});

describe('the header', () => {
    it('draws it beside the workstation chip, a button when there is a next step', () => {
        const html = bar(updateChip(u('available')));
        expect(html).toMatch(/data-update-chip="available"[\s\S]*Genie 2\.0\.0-beta\.20 is available — download/);
        expect(html).toMatch(/<button[^>]*data-update-action="update-download"/);
        expect(html).toMatch(/data-update-chip[\s\S]*data-workstation-health/);
    });

    it('draws nothing when there is no chip (positive control: the same bar with one does)', () => {
        expect(bar(null)).not.toContain('data-update-chip');
        expect(bar(updateChip(u('downloaded')))).toContain('data-update-action="update-install"');
    });
});

describe('the Deck', () => {
    const quiet: SignalState = { flowsRunning: 0, uncollectedMail: 0, githubBlocked: false, osAgentWorking: false };
    it('no longer carries the update — even when one is available', () => {
        const signals = { ...quiet, update: { phase: 'available', version: '2.0.0-beta.20', percent: null } } as SignalState;
        expect(signalStrip(signals).filter((s) => (s.kind as string) === 'update')).toEqual([]);
        const html = renderToStaticMarkup(<Deck items={[]} signals={signals} answering={null} onAnswer={() => {}} onOpenItem={() => {}} onNavigate={() => {}} onSignalAction={() => {}} />);
        expect(html).not.toMatch(/is available — download/);
    });
});
