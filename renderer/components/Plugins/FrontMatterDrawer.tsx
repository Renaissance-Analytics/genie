import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Action,
    Badge,
    Callout,
    Drawer,
    Input,
    Pillbox,
    Select,
    Switch,
    Text,
    Textarea,
} from '@particle-academy/react-fancy';
import {
    convertFmValue,
    normalizeFrontMatter,
    parseFrontMatterFields,
    removeFrontMatterField,
    renameFrontMatterField,
    setFrontMatterField,
    type FmField,
    type FmFieldKind,
} from '../../lib/front-matter';

/**
 * The front-matter drawer — the `---` block a markdown file carries, edited as
 * key→value pairs instead of typed into the document.
 *
 * It drops from the TOP of the editor (`attach="container"`, so it stays inside
 * the editor tile rather than taking over the window) because that is where the
 * block lives in the file: pull it down, edit the header, push it back up.
 *
 * Two views over the SAME YAML string:
 *   - FIELDS — one row per top-level key: rename it, retype it, edit the value
 *     with the control its type deserves (text, number, Switch, Pillbox).
 *   - YAML — the block as written. Always available, and the ONLY view when the
 *     block holds something the field list cannot represent (a top-level
 *     sequence, a bare scalar). Keys that are themselves nested maps or block
 *     literals show up as `complex` rows that point here rather than pretending
 *     to be editable.
 *
 * Every edit is surgical (see `lib/front-matter`): only the key you touched is
 * re-serialised, so comments, key order and hand-formatting survive. Nothing is
 * written to disk here — edits mark the tab dirty and the panel's save button /
 * Ctrl+S writes the block back atop the body.
 */

const KINDS: FmFieldKind[] = ['string', 'number', 'boolean', 'list', 'null'];

interface Props {
    open: boolean;
    onClose: () => void;
    /** The block's YAML, or `null` when the file carries no block. */
    value: string | null;
    /** `null` means the block goes away entirely. */
    onChange: (next: string | null) => void;
}

export default function FrontMatterDrawer({ open, onClose, value, onChange }: Props) {
    const yaml = value ?? '';
    const { fields, structured } = useMemo(() => parseFrontMatterFields(yaml), [yaml]);

    const [rawMode, setRawMode] = useState(false);
    const [newKey, setNewKey] = useState('');
    /** Key renames and numbers commit on blur/Enter — per-keystroke would rename
     *  the key on every letter, and `-`/`1.`/`1e` are not numbers yet. */
    const [draft, setDraft] = useState<{ key: string; field: 'key' | 'value'; text: string } | null>(
        null,
    );

    const raw = rawMode || !structured;

    // A fresh open starts clean — a half-typed key from last time is not an edit
    // the user is still making.
    useEffect(() => {
        if (open) {
            setDraft(null);
            setNewKey('');
        }
    }, [open]);

    const write = useCallback((next: string) => onChange(normalizeFrontMatter(next)), [onChange]);

    const commitDraft = useCallback(() => {
        if (!draft) return;
        const field = fields.find((f) => f.key === draft.key);
        setDraft(null);
        if (!field) return;
        if (draft.field === 'key') {
            const next = draft.text.trim();
            if (next && next !== field.key) write(renameFrontMatterField(yaml, field.key, next));
            return;
        }
        const next = convertFmValue({ ...field, value: draft.text }, field.kind);
        write(setFrontMatterField(yaml, field.key, next));
    }, [draft, fields, write, yaml]);

    const addKey = useCallback(() => {
        const key = newKey.trim();
        if (!key) return;
        setNewKey('');
        write(setFrontMatterField(yaml, key, { kind: 'string', value: '' }));
    }, [newKey, write, yaml]);

    const drafted = (field: FmField, which: 'key' | 'value'): string | null =>
        draft && draft.key === field.key && draft.field === which ? draft.text : null;

    return (
        <Drawer
            open={open}
            onClose={onClose}
            side="top"
            size="lg"
            attach="container"
            className="fm-drawer"
        >
            <Drawer.Header>
                <span className="fm-drawer-title">
                    <Text weight="semibold">Front matter</Text>
                    <Badge size="sm" variant="soft" color={value === null ? 'zinc' : 'violet'}>
                        {value === null
                            ? 'none'
                            : `${fields.length} ${fields.length === 1 ? 'key' : 'keys'}`}
                    </Badge>
                </span>
            </Drawer.Header>

            <Drawer.Body className="fm-drawer-body">
                {!structured && (
                    <Callout color="amber" className="fm-note">
                        This block is not a list of keys, so it is edited as YAML.
                    </Callout>
                )}

                {raw ? (
                    // Raw mode writes STRAIGHT through, no normalising: an
                    // emptied textarea has to stay empty while you retype it,
                    // and "Remove block" is right there when that is the intent.
                    <Textarea
                        className="fm-raw"
                        value={yaml}
                        placeholder={'title: My document\ntags:\n  - draft'}
                        spellCheck={false}
                        onValueChange={onChange}
                    />
                ) : fields.length === 0 ? (
                    <Text size="sm" className="fm-empty">
                        No front matter yet. Name a key below to start one.
                    </Text>
                ) : (
                    <div className="fm-rows">
                        {/* Keyed by POSITION as well as name — a hand-written
                            block is allowed to repeat a key. */}
                        {fields.map((f, i) => (
                            <div key={`${i}:${f.key}`} className="fm-row">
                                <Input
                                    className="fm-key"
                                    aria-label={`Key ${f.key}`}
                                    value={drafted(f, 'key') ?? f.key}
                                    spellCheck={false}
                                    onValueChange={(text) =>
                                        setDraft({ key: f.key, field: 'key', text })
                                    }
                                    onBlur={commitDraft}
                                    onKeyDown={(e) => e.key === 'Enter' && commitDraft()}
                                />
                                <Select
                                    className="fm-kind"
                                    aria-label={`Type of ${f.key}`}
                                    list={f.kind === 'complex' ? ['complex'] : KINDS}
                                    value={f.kind}
                                    disabled={f.kind === 'complex'}
                                    onValueChange={(k) =>
                                        write(
                                            setFrontMatterField(
                                                yaml,
                                                f.key,
                                                convertFmValue(f, k as FmFieldKind),
                                            ),
                                        )
                                    }
                                />
                                <span className="fm-value">
                                    <FieldValue
                                        field={f}
                                        draft={drafted(f, 'value')}
                                        onDraft={(text) =>
                                            setDraft({ key: f.key, field: 'value', text })
                                        }
                                        onCommit={commitDraft}
                                        onWrite={(v) => write(setFrontMatterField(yaml, f.key, v))}
                                    />
                                </span>
                                <Action
                                    size="sm"
                                    variant="ghost"
                                    color="red"
                                    icon="trash-2"
                                    aria-label={`Remove ${f.key}`}
                                    title={`Remove ${f.key}`}
                                    onClick={() => write(removeFrontMatterField(yaml, f.key))}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </Drawer.Body>

            <Drawer.Footer className="fm-drawer-foot">
                {!raw && (
                    <span className="fm-add">
                        <Input
                            className="fm-key"
                            aria-label="New key"
                            placeholder="New key…"
                            value={newKey}
                            spellCheck={false}
                            onValueChange={setNewKey}
                            onKeyDown={(e) => e.key === 'Enter' && addKey()}
                        />
                        <Action size="sm" icon="plus" disabled={!newKey.trim()} onClick={addKey}>
                            Add key
                        </Action>
                    </span>
                )}
                <span className="grow" />
                {value !== null && (
                    <Action
                        size="sm"
                        variant="ghost"
                        color="red"
                        icon="trash-2"
                        onClick={() => onChange(null)}
                    >
                        Remove block
                    </Action>
                )}
                <Action
                    size="sm"
                    variant="ghost"
                    icon={raw ? 'list' : 'code'}
                    disabled={!structured}
                    title={
                        structured
                            ? undefined
                            : 'This block has no top-level keys to show as fields.'
                    }
                    onClick={() => {
                        commitDraft();
                        setRawMode(!rawMode);
                    }}
                >
                    {raw ? 'Fields' : 'YAML'}
                </Action>
            </Drawer.Footer>
        </Drawer>
    );
}

/** The control a value deserves: text, number, Switch, Pillbox — or a pointer to YAML. */
function FieldValue({
    field,
    draft,
    onDraft,
    onCommit,
    onWrite,
}: {
    field: FmField;
    draft: string | null;
    onDraft: (text: string) => void;
    onCommit: () => void;
    onWrite: (v: ReturnType<typeof convertFmValue>) => void;
}) {
    if (field.kind === 'complex') {
        return (
            <Text size="xs" className="fm-complex" title={field.raw}>
                nested — edit in YAML
            </Text>
        );
    }
    if (field.kind === 'null') {
        return (
            <Text size="xs" className="fm-complex">
                null
            </Text>
        );
    }
    if (field.kind === 'boolean') {
        return (
            <Switch
                label={field.value === 'true' ? 'true' : 'false'}
                checked={field.value === 'true'}
                onCheckedChange={(on) => onWrite({ kind: 'boolean', value: on ? 'true' : 'false' })}
            />
        );
    }
    if (field.kind === 'list') {
        return (
            <Pillbox
                value={field.items ?? []}
                placeholder="Add an item…"
                onChange={(items) => onWrite({ kind: 'list', items })}
            />
        );
    }
    if (field.kind === 'number') {
        return (
            <Input
                aria-label={`Value of ${field.key}`}
                inputMode="decimal"
                value={draft ?? field.value}
                onValueChange={onDraft}
                onBlur={onCommit}
                onKeyDown={(e) => e.key === 'Enter' && onCommit()}
            />
        );
    }
    return (
        <Input
            aria-label={`Value of ${field.key}`}
            value={field.value}
            spellCheck={false}
            onValueChange={(v) => onWrite({ kind: 'string', value: v })}
        />
    );
}
