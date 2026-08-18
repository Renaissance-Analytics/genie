/**
 * PURE. Labels for a project picker.
 *
 * Every row in every picker used to read `[TYNN] The Ripple Effect`. The tag is
 * there to tell the two BACKENDS apart — `tynn` and `aionima` — but when every
 * project in the list comes from the same one it distinguishes nothing, and a
 * column of identical `[TYNN]` prefixes is noise the eye has to skip past before
 * it reaches the name it came for.
 *
 * So the tag is shown only when it does its job: when the list actually mixes
 * backends. One helper rather than a copy per picker, because two pickers that
 * label the same data differently is how a UI starts disagreeing with itself.
 */

/** The default backend for a row that does not name one — an older payload, not
 *  a second kind of project. */
const DEFAULT_BACKEND = 'tynn';

export interface PickerProject {
    id: string;
    name: string;
    /** Optional on the wire; absent means {@link DEFAULT_BACKEND}. */
    backend?: string;
    owner_name?: string;
}

export interface PickerOption {
    value: string;
    label: string;
}

/**
 * Options for a project `<Select>`.
 *
 * When the list mixes backends EVERY row is tagged, not just the minority one: a
 * bare name sitting beside a tagged one reads as "untagged means the other
 * thing", which is a guess the reader should not have to make.
 */
export function projectPickerOptions(
    projects: readonly PickerProject[],
    opts: { withOwner?: boolean } = {},
): PickerOption[] {
    const backends = new Set(projects.map((p) => p.backend ?? DEFAULT_BACKEND));
    const tagged = backends.size > 1;

    return projects.map((p) => {
        const tag = tagged ? `[${(p.backend ?? DEFAULT_BACKEND).toUpperCase()}] ` : '';
        const owner = opts.withOwner && p.owner_name ? ` · ${p.owner_name}` : '';

        return { value: p.id, label: `${tag}${p.name}${owner}` };
    });
}
