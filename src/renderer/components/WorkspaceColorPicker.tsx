import { WORKSPACE_PALETTE, isWorkspaceColor, lowContrastThemes } from '../../core/workspace-color.js';
import { wsStyle } from '../workspace-colors.js';

/**
 * A WORKSPACE'S COLOUR, IN ITS SETTINGS (genie#1300): the palette, plus a custom colour. The choice is written to the
 * workspace's project.json (`appearance.color`), so an agent reads the same colour and may set it too.
 *
 * Every palette colour is visible on both themes (core/workspace-color.ts). A custom colour may not be: it is allowed,
 * and the picker says which theme it is faint on — in few words (the owner's rule), never by refusing it.
 *
 * No state and no hooks: a pure function of `current`, so a test can press its controls from the element tree.
 */
export interface WorkspaceColorPickerProps {
    /** The colour now (`#rrggbb`); `null` = none known yet. */
    readonly current: string | null;
    readonly onSet: (color: string) => void;
}

export function WorkspaceColorPicker({ current, onSet }: WorkspaceColorPickerProps) {
    const now = current && isWorkspaceColor(current) ? current.toLowerCase() : null;
    const faint = now ? lowContrastThemes(now) : [];
    return (
        <div data-ws-color-picker="" className="flex flex-wrap items-center gap-1.5">
            {WORKSPACE_PALETTE.map((color) => {
                const on = now === color;
                return (
                    <button
                        key={color}
                        type="button"
                        data-ws-color-option={color}
                        aria-pressed={on ? 'true' : 'false'}
                        aria-label={color}
                        title={color}
                        onClick={() => onSet(color)}
                        style={wsStyle(color)}
                        className={`size-5 rounded-full bg-[var(--ws)] ${on ? 'ring-2 ring-[var(--fg-1)] ring-offset-2 ring-offset-[var(--bg-0)]' : 'hover:ring-2 hover:ring-[var(--border-2)]'}`}
                    />
                );
            })}
            {/* The custom colour: the system's own picker, holding the colour now. */}
            <input
                type="color"
                data-ws-color-custom=""
                aria-label="Custom colour"
                title="Custom colour"
                value={now ?? WORKSPACE_PALETTE[0]!}
                onChange={(e) => { if (isWorkspaceColor(e.target.value)) onSet(e.target.value.toLowerCase()); }}
                className="size-6 cursor-pointer rounded border border-[var(--border-1)] bg-transparent p-0"
            />
            {faint.map((theme) => (
                <span key={theme} data-ws-color-contrast={theme} className="font-mono text-[11px] text-[var(--warning)]">{`Faint on ${theme}`}</span>
            ))}
        </div>
    );
}
