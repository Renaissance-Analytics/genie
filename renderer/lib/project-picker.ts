/**
 * PURE. Labels for a project picker.
 *
 * Every row in every picker used to read `[TYNN] The Ripple Effect`. The tag told
 * two backends apart, and Tynn is now the only one (genie#679), so a row is
 * labelled by its name. One helper rather than a copy per picker, because two
 * pickers that label the same data differently is how a UI starts disagreeing
 * with itself.
 */

/**
 * How a Genie App project announces itself in a picker (Tynn `is_gapp`).
 *
 * Exported so the pickers that build their own label share the WORDING with the
 * ones that use {@link projectPickerOptions} — two pickers naming the same thing
 * differently is how a UI starts disagreeing with itself.
 */
export const GAPP_MARKER = '(Genie App)';

export interface PickerProject {
    id: string;
    name: string;
    /** Optional on the wire, and not shown: there is one backend. */
    backend?: string;
    owner_name?: string;
    /**
     * This project is where a Genie App is DEVELOPED (Tynn `is_gapp`).
     * Optional on the wire; absent means "not a GApp", never "unknown".
     */
    isGapp?: boolean;
}

export interface PickerOption {
    value: string;
    label: string;
}

/** Options for a project `<Select>`. */
export function projectPickerOptions(
    projects: readonly PickerProject[],
    opts: { withOwner?: boolean } = {},
): PickerOption[] {
    return projects.map((p) => {
        const owner = opts.withOwner && p.owner_name ? ` · ${p.owner_name}` : '';
        // A parenthetical rather than a third ` · ` suffix: beside an owner name
        // another dot-separated fragment reads as more owner. This also echoes
        // how Ops mode announces itself ("(Ops project — full access)").
        const gapp = p.isGapp ? ` ${GAPP_MARKER}` : '';

        return { value: p.id, label: `${p.name}${owner}${gapp}` };
    });
}
