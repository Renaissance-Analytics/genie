import { describe, expect, it } from 'vitest';
import { execFileRunner } from '../src/main/toolchain-runner.js';

/**
 * THE RUNNER CARRIES AN ENVIRONMENT FOR ONE CALL (Rust on Windows, TC6b-2). rustup needs RUSTUP_HOME / CARGO_HOME; on
 * Linux they went through the `env` command, which Windows does not have. The runner's own `env` option sets them for
 * that child only — added to the inherited environment, Genie's own left untouched — with argv, never a shell.
 */
const echo = ['-e', "process.stdout.write([process.env.GENIE_RUNNER_PROBE ?? 'none', process.env.PATH ? 'path' : 'no-path'].join(' '))"];

describe("the runner's env option", () => {
    it('reaches the child, on top of what it inherits (PATH still there); Genie\'s own environment is not changed', async () => {
        const r = await execFileRunner(process.execPath, echo, { env: { GENIE_RUNNER_PROBE: 'given' } });
        expect(r.stdout).toBe('given path');
        expect(process.env['GENIE_RUNNER_PROBE']).toBeUndefined();
    });

    it('CONTROL: without it, the child does not have it', async () => {
        expect((await execFileRunner(process.execPath, echo)).stdout).toBe('none path');
    });
});
