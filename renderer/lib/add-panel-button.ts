/**
 * What the split Add-Panel button's MAIN button says — its visible label (when
 * it has one), its accessible name, and its tooltip.
 *
 * The three used to be one inline ternary each in TerminalTypeSplitButton, and
 * the label and the tooltip disagreed by design ("Add Panel…" vs "Add a
 * panel"). That was harmless while the text was on screen. It stops being
 * harmless the moment the button goes icon-only, because the tooltip string is
 * then the ONLY name the button has — so the naming lives here, where a missing
 * name is a test failure rather than a review catch.
 */
export interface AddPanelMainButton {
    /** Draw a bare plus glyph, with no visible text beside it. */
    iconOnly: boolean;
    /** The visible label — `null` when the button is icon-only. */
    label: string | null;
    /** The `aria-label`. Always a real description, label or no label. */
    accessibleName: string;
    /** The `title`: a disabled reason wins, since it explains the greying-out. */
    title: string | undefined;
}

export function addPanelMainButton({
    panelLauncher = false,
    agentOnly = false,
    lastTypeLabel = 'Terminal',
    iconOnly = false,
    disabled = false,
    disabledReason,
}: {
    /** One-button workspace launcher for terminals, files, agents and plugins. */
    panelLauncher?: boolean;
    /** Dedicated AMS affordance: one obvious New Agent button, no plain shell. */
    agentOnly?: boolean;
    /** Label of the last-used terminal type, for the repeat-last-type mode. */
    lastTypeLabel?: string;
    /** Render as a compact icon button rather than a labelled pill. */
    iconOnly?: boolean;
    disabled?: boolean;
    disabledReason?: string;
}): AddPanelMainButton {
    const label = panelLauncher
        ? 'Add Panel…'
        : agentOnly
            ? 'New Agent…'
            : `Add ${lastTypeLabel}`;
    const accessibleName = panelLauncher
        ? 'Add a panel'
        : agentOnly
            ? 'Create a workspace agent'
            : `Add ${lastTypeLabel}`;
    return {
        iconOnly,
        label: iconOnly ? null : label,
        accessibleName,
        title: disabled ? disabledReason : accessibleName,
    };
}
