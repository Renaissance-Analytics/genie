import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { promptPaletteItems, serializePromptLibrary, type SavedPrompt } from '../src/core/prompt-library.js';
import { SETTINGS } from '../src/core/settings.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * SAVED PROMPTS, WHERE A PERSON MAKES THEM (Tynn #758). Settings → Agents carries the library: each prompt's name, its
 * text and its hotkey, with Add. Genie 1 put it in Settings as "Command Window prompts"; Genie 2 adds the hotkey. The
 * Command Window lists them first, each with its hotkey beside it, so the key is learned where the prompt is used.
 */
const library: SavedPrompt[] = [
    { id: 'p1', label: 'Review the diff', text: 'Review your diff before you commit.', hotkey: 'CommandOrControl+Alt+R' },
    { id: 'p2', label: 'Status', text: 'Where are you up to?' },
];

const render = (raw: string | undefined) =>
    renderToStaticMarkup(
        <SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: raw === undefined ? {} : { saved_prompts: raw } } }} onAction={() => {}} onNavigate={() => {}} section="prompts" />,
    );

describe('the prompts in Settings → Agents', () => {
    it('the setting is remembered, not drawn as a raw JSON box', () => {
        const def = SETTINGS.find((s) => s.key === 'saved_prompts');
        expect(def).toMatchObject({ group: 'agents', scope: 'host', type: 'string', default: '[]', hidden: true });
        expect(render(serializePromptLibrary(library))).not.toContain('data-setting="saved_prompts"');
    });

    it('draws each prompt — its name, its text, its hotkey — and Add; COUNTED', () => {
        const html = render(serializePromptLibrary(library));
        expect(html).toContain('data-saved-prompts');
        expect(html.match(/data-saved-prompt="/g)?.length).toBe(2);
        expect(html).toContain('value="Review the diff"');
        expect(html).toContain('Review your diff before you commit.');
        expect(html).toContain('data-prompt-hotkey="p1"');
        expect(html).toContain('data-action="prompt-add"');
    });

    it('an empty library says how to start, and still offers Add', () => {
        const html = render(undefined);
        expect(html.match(/data-saved-prompt="/g)).toBeNull();
        expect(html).toContain('No saved prompts yet');
        expect(html).toContain('data-action="prompt-add"');
    });
});

describe('the prompts in the Command Window', () => {
    it('one item per prompt, in the library’s order, its hotkey as the hint (read for this platform)', () => {
        expect(promptPaletteItems(library, 'win32')).toEqual([
            { id: 'p1', category: 'prompt', label: 'Review the diff', hint: 'Ctrl+Alt+R' },
            { id: 'p2', category: 'prompt', label: 'Status' },
        ]);
        expect(promptPaletteItems(library, 'darwin')[0]!.hint).toBe('⌘+Alt+R');
    });
});
