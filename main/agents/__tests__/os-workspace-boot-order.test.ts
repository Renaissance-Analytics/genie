import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { wireGenieOsWorkspace } from '../os-workspace';

/**
 * The OSA was never wired on ANY boot — and the cause was ordering, not a race.
 *
 * `wireGenieOsWorkspace` takes the MCP endpoint and returns early when there is
 * none, on the stated grounds that a config written with a null URL "looks
 * configured, which is worse than an absent one because nothing would retry
 * it". That reasoning is right. The bug is that the early return had nothing
 * retrying it either.
 *
 * `registerTerminalEndpoint` returns null while `port === null`, and the port is
 * only set by `startMcpServer`. In `background.ts` the wiring call sat at line
 * ~1128 and `startMcpServer` at ~1811 — roughly 700 lines later, unconditionally.
 * So the endpoint was ALWAYS null at the call, the early return ALWAYS fired,
 * and the Genie OS workspace ended up with no `.mcp.json` and no `.agents/` on
 * every machine, every boot (genie#319).
 *
 * Two things keep that from coming back:
 *
 *  1. The function REPORTS whether it wired, so a caller can never again treat
 *     "did nothing" as "succeeded".
 *  2. A source check pins the call after `startMcpServer` in `background.ts` —
 *     the same rule the E2E seam a few lines below it already follows
 *     ("Published here (after startMcpServer) so the endpoint URL exists").
 *     An ordering invariant between two statements in a 2000-line boot function
 *     is not reachable from a unit test, and it is exactly what broke.
 */

function tmpWorkspace(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-osa-order-'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Genie OS\n');
    return root;
}

describe('wiring the Genie OS workspace reports what it did (#319)', () => {
    it('reports FALSE when there is no endpoint, instead of failing silently', () => {
        const ws = tmpWorkspace();

        expect(wireGenieOsWorkspace(ws, null)).toBe(false);
        // POSITIVE CONTROL: it really did nothing — the caller's "false" is
        // describing an unwired workspace, not just a changed return type.
        expect(fs.existsSync(path.join(ws, '.mcp.json'))).toBe(false);
    });

    it('reports TRUE once an endpoint exists, and writes the config', () => {
        const ws = tmpWorkspace();

        expect(wireGenieOsWorkspace(ws, 'http://127.0.0.1:51717/mcp/tok')).toBe(true);
        expect(fs.existsSync(path.join(ws, '.mcp.json'))).toBe(true);
    });
});

describe('boot order (#319)', () => {
    const boot = fs.readFileSync(path.join(__dirname, '..', '..', 'background.ts'), 'utf8');

    it('wires the OSA only AFTER startMcpServer, where the endpoint exists', () => {
        const wire = boot.indexOf('wireGenieOsWorkspace(');
        const start = boot.indexOf('startMcpServer(');

        // Both must be present, or the test is asserting nothing.
        expect(wire).toBeGreaterThan(-1);
        expect(start).toBeGreaterThan(-1);

        expect(wire).toBeGreaterThan(start);
    });
});
