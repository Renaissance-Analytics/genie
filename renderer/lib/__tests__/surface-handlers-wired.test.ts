import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A DECLARED HANDLER THAT NOBODY PASSES.
 *
 * This guard exists because of what shipped in `v2.0.0-beta.1`, where the owner found the
 * chat composer typed fine and sent nothing:
 *
 *   "i need the chat ux"
 *
 * `ChatFlyout` declares `onSend`, `onStop` and `onDecide`. `master.tsx` mounted it with
 * `session`, `pinned`, `onTogglePin`, `onClose` — and none of the three. Because every
 * handler prop is OPTIONAL (`onSend?:`), "nobody wired this" and "deliberately inert" are
 * indistinguishable to the compiler, in review, and in a screenshot. The surface rendered
 * perfectly and did nothing.
 *
 * It is not one slip. The same shape shipped three times in one release: the Deck's roster
 * rows were bare `<div>`s, and `Dashboard` was mounted `<Dashboard sessions workspaces />`
 * against a component that declares no handlers at all.
 *
 * So the rule is mechanical rather than remembered: if a surface declares a handler, its
 * mount site passes it, or this fails and names the one that is missing. Optionality stays
 * useful for tests and for storybook-style mounts — it stops being a silent licence in the
 * app itself.
 *
 * A component with NO handlers is not caught here, and cannot be: there is nothing to
 * compare against. That gap is covered from the other side by the render tests, which assert
 * the markup carries an activation target at all.
 */

const root = path.resolve(import.meta.dirname, '../..');
const source = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/** The `onX` props a component's own prop type declares, optional or not. */
function declaredHandlers(componentFile: string): string[] {
    const src = source(componentFile);
    // Handler props are declared one-per-line in this codebase's prop types, as
    // `onSend?: (text: string) => void;`. Comments are stripped first so a handler named
    // only in prose does not count as declared.
    const executable = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const found = new Set<string>();
    // The type must be a FUNCTION type — `onSend?: (text: string) => void`. Requiring the
    // `(` is what separates a declared handler from an object-literal field that merely
    // starts with `on`: `AgentView` builds a chrome input containing
    // `onRestart: !!onRestartAgent`, and a looser pattern reported those as unwired props.
    // Two of the first four findings here were that false positive, which is the signal to
    // suspect the guard rather than the code.
    for (const m of executable.matchAll(/^\s*(on[A-Z][A-Za-z0-9]*)\??\s*:\s*\(/gm)) found.add(m[1]!);
    return [...found].sort();
}

/** The props a JSX mount site actually passes. */
function passedProps(hostFile: string, component: string): string[] {
    const src = source(hostFile);
    const open = src.indexOf(`<${component}`);
    expect(open, `${component} is not mounted in ${hostFile} at all`).toBeGreaterThan(-1);

    // Walk to the end of the opening tag, tracking brace depth so a prop whose value is an
    // inline arrow containing `>` does not end the tag early.
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i += 1) {
        const c = src[i];
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        else if (c === '>' && depth === 0 && i > open) {
            end = i;
            break;
        }
    }
    expect(end, `could not find the end of the <${component}> tag`).toBeGreaterThan(-1);

    // Comments are stripped before reading props, or a handler NAMED in a comment inside the
    // tag would count as passed — the guard would then be satisfied by prose about the thing
    // it is meant to require.
    const tag = src
        .slice(open, end)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

    // Two forms, because both are idiomatic here and only counting the first would make the
    // guard fail on correct code:
    //   onSend={...}                               a plain prop
    //   {...(cond ? { onTakeOver: ... } : {})}     CONDITIONALLY passed, which is how this
    //                                              codebase withholds a control that has
    //                                              nothing behind it rather than rendering a
    //                                              dead one.
    return [
        ...[...tag.matchAll(/(?:^|\s)([a-zA-Z][A-Za-z0-9]*)=/g)].map((m) => m[1]!),
        ...[...tag.matchAll(/(?:^|[{,\s])(on[A-Z][A-Za-z0-9]*)\s*:/g)].map((m) => m[1]!),
    ];
}

const SURFACES: Array<{ component: string; file: string; host: string }> = [
    { component: 'ChatFlyout', file: 'components/Master/ChatFlyout.tsx', host: 'pages/master.tsx' },
    { component: 'Deck', file: 'components/Master/Deck.tsx', host: 'pages/master.tsx' },
    { component: 'Dashboard', file: 'components/Master/Dashboard.tsx', host: 'pages/master.tsx' },
    // The most important screen in the product, and the one with the most optional handlers
    // — approvals, cancel, take-over, restart, settings. Exactly the shape that failed.
    { component: 'AgentView', file: 'components/Master/AgentView.tsx', host: 'pages/master.tsx' },
];

describe('the guard can see what it is guarding', () => {
    it('POSITIVE CONTROL: ChatFlyout really does declare handlers', () => {
        // Without this, "every declared handler is passed" would pass trivially against a
        // broken extractor that found none -- which is the exact failure mode this file is
        // about, arriving one level up.
        const handlers = declaredHandlers('components/Master/ChatFlyout.tsx');
        expect(handlers).toContain('onSend');
        expect(handlers.length).toBeGreaterThanOrEqual(3);
    });

    it('POSITIVE CONTROL: it can read what a mount site passes', () => {
        const passed = passedProps('pages/master.tsx', 'ChatFlyout');
        expect(passed).toContain('session');
        expect(passed.length).toBeGreaterThanOrEqual(2);
    });
});

describe.each(SURFACES)('$component is wired where it is mounted', ({ component, file, host }) => {
    it('passes every handler it declares', () => {
        const declared = declaredHandlers(file);
        const passed = new Set(passedProps(host, component));
        const missing = declared.filter((h) => !passed.has(h));

        expect(
            missing,
            `${component} declares ${missing.join(', ')} but ${host} never passes ` +
                `${missing.length === 1 ? 'it' : 'them'}. An optional handler nobody passes is a ` +
                `control that renders and does nothing.`,
        ).toEqual([]);
    });
});
