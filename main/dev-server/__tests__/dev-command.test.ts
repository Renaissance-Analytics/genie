import { describe, expect, it } from 'vitest';
import { devCommandForRecipe } from '../serve-recipe';

/**
 * DEV-by-default (story #238): a bare `manageSite create {name}` should run the
 * repo's DEV server against live source, NOT a production build. This maps a
 * detected recipe (stack/framework) to that dev command.
 */
describe('devCommandForRecipe', () => {
    it('Laravel / php → `php artisan serve` on a pinned port', () => {
        expect(devCommandForRecipe({ framework: 'laravel', port: 8000 })).toEqual({
            command: ['php', 'artisan', 'serve', '--host=127.0.0.1', '--port=8000'],
            port: 8000,
            framework: 'laravel',
            stack: 'php',
        });
        expect(devCommandForRecipe({ stack: 'php' })?.command).toContain('artisan');
    });

    it('Django → `manage.py runserver`', () => {
        expect(devCommandForRecipe({ framework: 'django', port: 8000 })).toEqual({
            command: ['python', 'manage.py', 'runserver', '127.0.0.1:8000'],
            port: 8000,
            framework: 'django',
            stack: 'python',
        });
    });

    it("node → the repo's own `npm run dev` on the framework port", () => {
        expect(devCommandForRecipe({ framework: 'vite' })).toMatchObject({ command: ['npm', 'run', 'dev'], port: 5173 });
        expect(devCommandForRecipe({ framework: 'next' })).toMatchObject({ command: ['npm', 'run', 'dev'], port: 3000 });
        expect(devCommandForRecipe({ stack: 'node' })).toMatchObject({ command: ['npm', 'run', 'dev'] });
    });

    it('go → `go run .`', () => {
        expect(devCommandForRecipe({ stack: 'go' })).toMatchObject({ command: ['go', 'run', '.'] });
    });

    it('is null for a stack with no unambiguous dev server (static / rust / unknown)', () => {
        expect(devCommandForRecipe({ stack: 'static' })).toBeNull();
        expect(devCommandForRecipe({ stack: 'rust' })).toBeNull();
        expect(devCommandForRecipe({})).toBeNull();
    });
});
