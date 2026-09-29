import { execFile } from 'node:child_process';

export interface PhpRedisProbe {
    command: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
}

/** Probe only loaded modules, never phpinfo (which includes environment secrets). */
export function probePhpRedis({ command, cwd, env }: PhpRedisProbe): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(command[0], command.slice(1), {
            cwd, env, windowsHide: true, timeout: 5_000, maxBuffer: 128 * 1024,
        }, (error, stdout) => resolve(!error && phpLoadsRedis(stdout)));
    });
}

export function phpLoadsRedis(stdout: string): boolean {
    const modules = stdout.split('[PHP Modules]')[1]?.split('[Zend Modules]')[0];
    return modules?.split(/\r?\n/).some((line) => line.trim() === 'redis') ?? false;
}

/** FrankenPHP 1.12.7 supports php-cli -r, but treats -m as a script filename. */
export function frankenphpModulesCommand(exe: string): string[] {
    return [exe, 'php-cli', '-r', 'echo "[PHP Modules]\\n", implode("\\n", get_loaded_extensions()), "\\n[Zend Modules]\\n";'];
}

/** Keep the launcher's PHP ini options; never execute its application script. */
export function phpModulesCommand(command: string[]): string[] | undefined {
    if (!/(?:^|[\\/])php(?:-cgi)?(?:[\d.]+)?(?:\.exe)?$/i.test(command[0] ?? '')) return undefined;
    const args: string[] = [command[0]];
    for (let i = 1; i < command.length; i++) {
        const arg = command[i];
        if (arg === '-n') args.push(arg);
        else if (arg === '-c' || arg === '-d') {
            if (command[i + 1] === undefined) return undefined;
            args.push(arg, command[++i]);
        } else if (/^-[cd].+/.test(arg)) args.push(arg);
        else break;
    }
    return [...args, '-m'];
}

export function redisClient(loaded: boolean, chosen?: string): string {
    return loaded ? (chosen || 'phpredis') : 'predis';
}
