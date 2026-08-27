/**
 * `genieGuide` as a CATALOGUE, not a dump.
 *
 * It returned the whole ~680-line guide on every call. An agent that wanted to
 * know how `imDone` works paid for every tool's documentation to find out — so
 * the guide became something to avoid rather than reach for, which is the
 * opposite of what a reference is for.
 *
 * The owner's requirement, and the constraint everything here follows from: with
 * no arguments it lists the topics; a topic can be selected directly; and more
 * guides are coming, so it must stay easy to reach for "and not blowing up their
 * context when they don't".
 *
 * TOPICS ARE DERIVED FROM THE GUIDE'S OWN HEADINGS. A hand-maintained index would
 * be a second copy of the same facts about a document built to grow — and it is
 * the index that would go stale, silently, while still looking authoritative.
 * Adding a section to the guide adds a topic; nothing else has to be touched.
 */

export interface GuideTopic {
    /** What an agent passes back. Lowercase, hyphenated, derived from the title. */
    id: string;
    title: string;
    /** The section body, WITHOUT its heading. */
    body: string;
}

/** A heading that starts a topic. Both levels, because the guide uses `##` for
 *  concepts and `###` for individual tools. */
const HEADING = /^#{2,3}\s+(.+?)\s*$/;

/** `Reading a result — ok is the verdict` → `reading-a-result`.
 *  Punctuation and em-dashed asides are dropped so the id stays typable. */
function toId(title: string): string {
    const head = title.split(/[—:(]/)[0] ?? title;
    return head
        .trim()
        .toLowerCase()
        .replace(/[`*_]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * PURE. Split a guide into its sections.
 *
 * Text ABOVE the first heading belongs to no topic and is dropped: attaching it
 * to the first section would file unrelated prose under a specific title.
 */
export function guideTopics(guide: string): GuideTopic[] {
    const topics: GuideTopic[] = [];
    let current: GuideTopic | null = null;

    for (const line of guide.split('\n')) {
        const m = HEADING.exec(line);
        if (m) {
            if (current) topics.push({ ...current, body: current.body.trim() });
            const title = m[1]!.trim();
            current = { id: toId(title), title, body: '' };
            continue;
        }
        if (current) current.body += line + '\n';
    }
    if (current) topics.push({ ...current, body: current.body.trim() });

    return topics.filter((t) => t.id.length > 0);
}

/**
 * The catalogue: every topic, one line each, and how to ask for one.
 *
 * Deliberately carries NO bodies — that is the entire point of the change. The
 * whole listing has to stay cheap enough that an agent calls it to find out
 * whether the answer exists.
 */
export function guideIndex(topics: GuideTopic[]): string {
    const lines = [
        'Genie guide — call `genieGuide` again with `topic` to read one of these:',
        '',
        ...topics.map((t) => `- \`${t.id}\` — ${t.title}`),
        '',
        'Example: `genieGuide { topic: "imdone" }`. Ask for the topic you need; the',
        'full guide is long and reading all of it to answer one question is what',
        'this listing exists to avoid.',
    ];
    return lines.join('\n');
}

export interface GuideAnswer {
    ok: boolean;
    text: string;
}

/**
 * One topic, or a refusal that CARRIES the index.
 *
 * An unknown topic answered with "no such topic" would cost the agent a second
 * call to learn what the topics are — the same silence this change is about. The
 * listing is cheap, so it rides along.
 */
export function guideFor(topics: GuideTopic[], requested: string): GuideAnswer {
    const want = toId(String(requested ?? ''));
    const hit = topics.find((t) => t.id === want);
    if (hit) return { ok: true, text: `## ${hit.title}\n\n${hit.body}` };
    return {
        ok: false,
        text: `No guide topic “${String(requested).trim()}”.\n\n${guideIndex(topics)}`,
    };
}
