import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { GENIE_TOOL_NAMES } from '../protocol';

/**
 * EVERY ADVERTISED TOOL IS ACTUALLY WIRED TO SOMETHING.
 *
 * This codebase has now shipped the same defect twice in a week: a capability
 * built end-to-end everywhere except the layer that hands it to an agent. The
 * four `knowledge` memory classes sat unreachable for six days because `class`
 * never reached the MCP surface. GDW detection shipped with a column,
 * convergence rules, chrome and two buttons, and `git grep gapp_dev -- main/mcp`
 * came back empty. Thousands of unit tests were green through both, because they
 * all tested the half that worked.
 *
 * The structural reason is that `ServerDeps` makes tool deps OPTIONAL — rightly,
 * since a headless host genuinely cannot do everything a desktop can — and an
 * optional field that nobody sets is a compile-time success and a runtime
 * silence. So the completeness check cannot be a type: it has to be this.
 *
 * Read as SOURCE rather than by importing the factory, because
 * `buildHostServerDeps` pulls in the database, the terminal backend and the
 * mobile server. Coarse, and it only proves a key is assigned — but the bug it
 * exists to catch is a key that is not there at all, which is exactly what it
 * sees.
 */

const DEPS = fs.readFileSync(
    path.resolve(__dirname, '../../host-core/server-deps.ts'),
    'utf8',
);

/**
 * Tool name → the `ServerDeps` key behind it, where the two differ.
 *
 * The aliases are historical (`on*` for the two side-effect tools) or a
 * different noun for the same thing (`initializeWorkspace` is served by the
 * workspace MAP). `genieGuide` has no dep at all: the protocol answers it from
 * the guide constant, so there is nothing for a shell to inject.
 */
const DEP_FOR_TOOL: Readonly<Record<string, string | null>> = {
    imDone: 'onImDone',
    thumbsUp: 'onThumbsUp',
    ForceTheQuestion: 'onForceQuestion',
    agentinbox: 'agentInbox',
    initializeWorkspace: 'describeWorkspace',
    genieGuide: null,
};

describe('every tool the MCP advertises reaches an implementation', () => {
    it('wires a dep in buildHostServerDeps for each one', () => {
        const missing: string[] = [];
        for (const tool of GENIE_TOOL_NAMES) {
            const key = tool in DEP_FOR_TOOL ? DEP_FOR_TOOL[tool] : tool;
            if (key === null) continue;
            if (!new RegExp(`^\\s*${key}:`, 'm').test(DEPS)) missing.push(`${tool} → ${key}`);
        }

        expect(
            missing,
            'these tools are advertised to agents but nothing is wired behind them, so every call returns "not available" — the exact shape of defect that left GDW detection and the memory classes unreachable while every other test passed',
        ).toEqual([]);
    });

    it('knows about every tool — POSITIVE CONTROL', () => {
        // The loop above passes trivially on an empty tool list, and this file's
        // whole value is that it fails when something is missed.
        expect(GENIE_TOOL_NAMES.length).toBeGreaterThan(10);
        expect(GENIE_TOOL_NAMES).toContain('manageGappDev');
    });
});
