import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseModuleList } from './toolchain-version-install';
import type { PhpAbi, PhpExtensionEffects } from './php-extensions';
export interface PhpExtensionPrimitives {
    run(exe: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }>;
    download(url: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    unzip(archive: string, dest: string): Promise<{ ok: boolean; error?: string }>;
}
// INFO_GENERAL excludes environment/variables. Capture it internally and emit
// only the ABI fields; never return phpinfo output or the process environment.
export const PHP_ABI_PROBE = 'ob_start(); phpinfo(INFO_GENERAL); $info=ob_get_clean(); preg_match("/PHP Extension Build => ([^\\r\\n]+)/", $info, $m); echo json_encode(["version"=>PHP_VERSION,"zts"=>PHP_ZTS,"bits"=>PHP_INT_SIZE*8,"debug"=>PHP_DEBUG,"build"=>$m[1]??null]);';

export function createPhpExtensionEffects(deps: PhpExtensionPrimitives): PhpExtensionEffects {
    return {
        async inspect(exe) {
            const result = await deps.run(exe, ['-n', '-r', PHP_ABI_PROBE]);
            if (result.code !== 0 || result.stderr.trim()) return null;
            try {
                const abi: unknown = JSON.parse(result.stdout);
                if (!abi || typeof abi !== 'object') return null;
                const value = abi as PhpAbi;
                return typeof value.version === 'string' && typeof value.build === 'string' &&
                    typeof value.zts === 'boolean' && typeof value.debug === 'boolean' && typeof value.bits === 'number'
                    ? value : null;
            } catch { return null; }
        },
        async verify(install, dll) {
            const args = dll ? ['-n', '-d', `extension=${dll}`, '-m'] : ['-c', join(install.dir, 'php.ini'), '-m'];
            for (const exe of [install.exe, join(install.dir, 'php-cgi.exe')]) {
                const result = await deps.run(exe, args);
                const loaded = parseModuleList(result.stdout, result.stderr);
                if (result.code !== 0 || loaded.warnings || !loaded.modules.includes('redis')) return false;
            }
            return true;
        },
        async stage(artifact) {
            const downloaded = await deps.download(artifact.url);
            if (!downloaded.ok || !downloaded.path) throw new Error(`Could not download ${artifact.name} ${artifact.version}.`);
            const archive = downloaded.path;
            let dir: string | undefined;
            const dispose = async () => {
                if (dir) await rm(dir, { recursive: true, force: true });
                await rm(archive, { force: true });
                // Only remove an EMPTY download parent, never recursively trust a returned path.
                await rmdir(dirname(archive)).catch(() => {});
            };
            try {
                const size = (await lstat(archive)).size;
                if (size > 10 * 1024 * 1024) throw new Error('Redis archive exceeds the allowed size.');
                const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
                if (digest !== artifact.sha256) throw new Error('Redis archive checksum mismatch; nothing was extracted.');
                dir = await mkdtemp(join(tmpdir(), 'genie-pecl-'));
                const extracted = await deps.unzip(archive, dir);
                if (!extracted.ok) throw new Error('Could not extract the verified Redis archive.');
                const dll = join(dir, artifact.file);
                if (!(await lstat(dll)).isFile()) throw new Error('Redis archive did not contain the expected DLL.');
                return { dll, dispose };
            } catch (error) { await dispose(); throw error; }
        },
    };
}
