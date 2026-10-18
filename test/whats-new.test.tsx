import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { whatsNewFor, whatsNewSection } from '../src/core/whats-new.js';
import { SETTINGS } from '../src/core/settings.js';
import { RELEASE_NOTES } from '../src/main/release-notes.js';
import { WhatsNewBody, WhatsNewWindow } from '../src/renderer/components/WhatsNewWindow.js';

/**
 * WHAT'S NEW, ONCE PER VERSION (Tynn #762; Genie 1's `whats_new_seen_version`). After an upgrade the person is told what
 * changed — in the release's own words, its "What's new" section only: the release notes' migration and build notes
 * are for the people shipping it, not the person using it (the owner: no migration or dev notes in the product). Closed,
 * it is not shown again for that version. A version with no notes shows nothing rather than an empty window.
 */
const NOTES = `# Genie 2.0.0-beta.31

## What's new

- The tray says when an agent is paused.
- **Feedback** from anywhere: Ctrl+Shift+W.

## Migration

Installs over any earlier Genie in place.

## About this build

Rebuilt.
`;

describe('which words', () => {
    it('only the "What’s new" section — not the migration, not the build notes', () => {
        const section = whatsNewSection(NOTES);
        expect(section).toContain('The tray says when an agent is paused.');
        expect(section).toContain('**Feedback** from anywhere');
        expect(section).not.toMatch(/Migration|Installs over|About this build|Rebuilt/);
    });

    it('notes with no such section say nothing (null), never the whole file', () => {
        expect(whatsNewSection('# Genie 2.0.0-beta.31\n\n## Migration\n\nInstalls.\n')).toBeNull();
        expect(whatsNewSection('## What’s new\n\n- curly apostrophe works too\n')).toContain('curly apostrophe');
    });
});

describe('when it shows', () => {
    const notes = { '2.0.0-beta.31': NOTES };
    it('a version not yet seen, with notes: shown, for THAT version', () => {
        expect(whatsNewFor('2.0.0-beta.31', '2.0.0-beta.30', notes)).toEqual({ version: '2.0.0-beta.31', notes: whatsNewSection(NOTES) });
        // Upgraded from a Genie that never recorded one (Genie 1, or an earlier beta): still told.
        expect(whatsNewFor('2.0.0-beta.31', '', notes)?.version).toBe('2.0.0-beta.31');
    });

    it('CONTROL: already seen, or no notes for this version — nothing', () => {
        expect(whatsNewFor('2.0.0-beta.31', '2.0.0-beta.31', notes)).toBeNull();
        expect(whatsNewFor('2.0.0-beta.32', '2.0.0-beta.31', notes)).toBeNull();
        expect(whatsNewFor('2.0.0-beta.31', '2.0.0-beta.30', { '2.0.0-beta.31': '# no section\n' })).toBeNull();
    });
});

describe('the notes Genie carries', () => {
    it('every release in docs/releases, keyed by version, each with a What’s new section (COUNTED)', () => {
        const versions = Object.keys(RELEASE_NOTES);
        expect(versions).toContain('2.0.0-beta.30');
        expect(versions.length).toBeGreaterThanOrEqual(26);
        expect(whatsNewSection(RELEASE_NOTES['2.0.0-beta.30']!)).not.toBeNull();
    });
});

describe('the window', () => {
    it('the version and its notes rendered, with Close; nothing to show draws nothing', () => {
        const html = renderToStaticMarkup(<WhatsNewBody whatsNew={{ version: '2.0.0-beta.31', notes: '- The tray says when an agent is paused.' }} onClose={() => {}} />);
        expect(html).toContain('data-whats-new="2.0.0-beta.31"');
        expect(html).toMatch(/The tray says when an agent is paused/);
        expect(html).toMatch(/data-action="whats-new-close"/);
        expect(renderToStaticMarkup(<WhatsNewWindow whatsNew={null} onClose={() => {}} />)).toBe('');
        expect(renderToStaticMarkup(<WhatsNewWindow whatsNew={undefined} onClose={() => {}} />)).toBe('');
    });
});

describe('the setting and the wiring', () => {
    it('whats_new_seen_version is remembered, never drawn', () => {
        expect(SETTINGS.find((s) => s.key === 'whats_new_seen_version')).toMatchObject({ type: 'string', default: '', hidden: true });
    });

    it('main answers what is new for ITS version; closing records that version as seen', () => {
        const main = readFileSync('src/main/main.ts', 'utf8');
        expect(main).toMatch(/whatsNew: \(shown\) => whatsNewFor\(app\.getVersion\(\), String\(composed\.settings\.get\('whats_new_seen_version'\) \?\? ''\), RELEASE_NOTES, shown\)/);
        const app = readFileSync('src/renderer/App.tsx', 'utf8');
        expect(app).toMatch(/<WhatsNewWindow\s+whatsNew=\{features\.whatsNew\}/);
        expect(app).toMatch(/featureAct\(\{ kind: 'whatsNew\.close', version: features\.whatsNew!?\.version \}/);
    });
});
