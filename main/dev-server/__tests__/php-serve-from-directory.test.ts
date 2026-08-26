import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devCommandForRecipe } from '../serve-recipe';
import { detectPhpServe, detectStaticServe } from '../repo-facts';

/** A throwaway repo on disk — detection reads the filesystem, so the fixture is real. */
function repo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'php-serve-'));
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body);
    }
    return dir;
}

/**
 * A PHP app needs NO dev server.
 *
 * Every other stack here is its own web server — `npm run dev` IS Vite, and
 * Vite must keep running because HMR is a live socket. PHP is the one language
 * that is not: the deployment shape everyone actually uses is a web server
 * pointed at `public/` handing `.php` to FastCGI, which is exactly what
 * `hostServe: { mode: 'php' }` already renders with Genie's bundled Caddy.
 *
 * `php artisan serve` is a DEVELOPMENT CONVENIENCE that wraps PHP's built-in
 * server. Choosing it cost the owner 64 processes in one session — 32 `artisan
 * serve` parents, each of which spawns a `php -S` child — every one of them a
 * long-lived process with nothing to run and something to leak.
 *
 * So: PHP is served from its directory. The owner's rule is that an ordinary
 * site has NO build step and is served "from a directory like any other
 * webserver"; PHP is the case where Genie was doing the opposite.
 */
describe('a PHP repo is SERVED, not run', () => {
    it('serves `public/` over FastCGI rather than running a dev server', () => {
        const dir = repo({ 'composer.json': '{}', 'public/index.php': '<?php' });

        expect(detectPhpServe(dir)).toEqual({ mode: 'php', root: 'public' });
    });

    it('refuses a PHP project with no front controller, rather than 404ing everything', () => {
        // Positive control: the same fixture WITH `public/index.php` is detected
        // above, so this cannot pass against a detector that always returns null.
        const lib = repo({ 'composer.json': '{}', 'src/Thing.php': '<?php' });

        expect(detectPhpServe(lib)).toBeNull();
    });

    it('keeps a dev server only as the fallback for a PHP repo it cannot serve', () => {
        // `detectPhpServe` runs FIRST, so a normal Laravel repo never reaches this.
        // It stays for a PHP app with no `public/index.php`, where failing outright
        // would be worse — but it is no longer what an ordinary PHP site gets.
        const fallback = devCommandForRecipe({ stack: 'php', framework: 'laravel', port: 8000 });

        expect(fallback?.command).toContain('serve');
    });

    it('STILL runs a dev server for node, where HMR genuinely needs one', () => {
        const node = devCommandForRecipe({ stack: 'node', framework: 'vite', port: 5173 });

        expect(node?.command).toEqual(['npm', 'run', 'dev']);
    });

    it('does not mistake a node repo for a PHP one', () => {
        const node = repo({ 'package.json': '{"scripts":{"dev":"vite"}}' });

        expect(detectPhpServe(node)).toBeNull();
    });

    it('prefers the PHP front controller over a built dir in the same repo', () => {
        // Laravel ships `public/index.php` AND often a built `public/build` — the
        // static detector must not win, or `.php` would be served as a file.
        const laravel = repo({
            'composer.json': '{}',
            'public/index.php': '<?php',
            'dist/index.html': '<html>',
        });

        expect(detectPhpServe(laravel)).toEqual({ mode: 'php', root: 'public' });
        expect(detectStaticServe(laravel)).not.toBeNull();
    });
});
