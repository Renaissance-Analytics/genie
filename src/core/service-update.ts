/** Recreate the container Docker actually holds, including adopted engines. Never derive new credentials or volumes. */
export interface UpdateContainer {
    readonly Id?: string;
    readonly Image?: string;
    readonly State?: { readonly Status?: string; readonly StartedAt?: string };
    readonly Config?: {
        readonly Image?: string; readonly Env?: readonly string[]; readonly Entrypoint?: readonly string[] | null;
        readonly Cmd?: readonly string[] | null; readonly Labels?: Readonly<Record<string, string>> | null;
        readonly User?: string; readonly WorkingDir?: string; readonly Hostname?: string; readonly Domainname?: string;
        readonly StopSignal?: string; readonly Healthcheck?: unknown;
    };
    readonly HostConfig?: {
        readonly RestartPolicy?: { readonly Name?: string; readonly MaximumRetryCount?: number };
        readonly NetworkMode?: string;
        readonly PortBindings?: Readonly<Record<string, readonly { readonly HostIp?: string; readonly HostPort?: string }[] | null>>;
        readonly Privileged?: boolean; readonly AutoRemove?: boolean; readonly ReadonlyRootfs?: boolean;
        readonly CapAdd?: readonly string[] | null; readonly CapDrop?: readonly string[] | null;
        readonly Devices?: readonly unknown[] | null; readonly DeviceRequests?: readonly unknown[] | null;
        readonly SecurityOpt?: readonly string[] | null; readonly Tmpfs?: Readonly<Record<string, string>>;
        readonly ExtraHosts?: readonly string[] | null; readonly Dns?: readonly string[] | null;
        readonly ShmSize?: number; readonly Init?: boolean | null;
        readonly Memory?: number; readonly MemorySwap?: number; readonly MemoryReservation?: number;
        readonly NanoCpus?: number; readonly CpuShares?: number; readonly CpuPeriod?: number; readonly CpuQuota?: number;
        readonly CpusetCpus?: string; readonly CpusetMems?: string; readonly PidsLimit?: number | null;
        readonly LogConfig?: { readonly Type?: string; readonly Config?: Readonly<Record<string, string>> | null };
    };
    readonly Mounts?: readonly { readonly Type: string; readonly Name?: string; readonly Source?: string; readonly Destination: string; readonly RW: boolean; readonly Propagation?: string }[];
    readonly NetworkSettings?: { readonly Networks?: Readonly<Record<string, unknown>> };
}

export function parseUpdateContainer(json: string): UpdateContainer {
    let item: UpdateContainer | undefined;
    try { item = (JSON.parse(json) as UpdateContainer[])[0]; } catch { /* refused below */ }
    if (!item?.Id || !item?.Config?.Image || !Array.isArray(item.Config.Env) || !item.HostConfig || !Array.isArray(item.Mounts)
        || !['running', 'exited', 'created'].includes(item.State?.Status ?? '')) {
        throw new Error('Docker did not show the engine’s image, environment, mounts and stable running/stopped state; nothing was updated');
    }
    return item;
}

/** Every value stays one argv item; no shell. Unsupported runtime privileges are refused before stopping anything. */
export function recreateServiceArgs(name: string, i: UpdateContainer): string[] {
    const c = i.Config!; const h = i.HostConfig!;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || !c.Image || c.Image.startsWith('-') || /\s/.test(c.Image)) throw new Error('the engine has an invalid container name or image; nothing was updated');
    if (h.Privileged || h.AutoRemove || h.CapAdd?.length || h.Devices?.length || h.DeviceRequests?.length || h.SecurityOpt?.length
        || (h.NetworkMode && !['default', 'bridge'].includes(h.NetworkMode)) || Object.keys(i.NetworkSettings?.Networks ?? {}).some((n) => n !== 'bridge')) {
        throw new Error('this engine has custom Docker privileges, devices, security settings or networks that Genie cannot safely recreate; nothing was updated');
    }
    const args = ['create', '--name', name];
    for (const [inner, bindings] of Object.entries(h.PortBindings ?? {})) for (const b of bindings ?? []) {
        // Genie only exposes services over loopback. Never silently reproduce a public binding.
        if (!['127.0.0.1', '::1'].includes(b.HostIp ?? '') || !/^\d+$/.test(b.HostPort ?? '') || !/^\d+\/(tcp|udp)$/.test(inner)) throw new Error('the engine has a published port that is not a loopback binding; nothing was updated');
        const host = b.HostIp === '::1' ? '[::1]' : b.HostIp;
        args.push('-p', `${host}:${b.HostPort}:${inner}`);
    }
    for (const m of i.Mounts ?? []) {
        if (!['volume', 'bind'].includes(m.Type)) throw new Error(`the engine has a ${m.Type} mount that Genie cannot safely recreate; nothing was updated`);
        const source = m.Type === 'volume' ? m.Name : m.Source;
        if (!source || [source, m.Destination].some((p) => /[,\r\n]/.test(p))) throw new Error('the engine has a mount path Docker cannot safely recreate; nothing was updated');
        args.push('--mount', `type=${m.Type},source=${source},target=${m.Destination}${m.RW ? '' : ',readonly'}${m.Type === 'bind' && m.Propagation ? `,bind-propagation=${m.Propagation}` : ''}`);
    }
    const restart = h.RestartPolicy?.Name;
    if (restart) args.push('--restart', restart === 'on-failure' && h.RestartPolicy?.MaximumRetryCount ? `on-failure:${h.RestartPolicy.MaximumRetryCount}` : restart);
    for (const v of c.Env ?? []) args.push('-e', v);
    for (const [k, v] of Object.entries(c.Labels ?? {})) args.push('--label', `${k}=${v}`);
    for (const [flag, value] of [['--user', c.User], ['--workdir', c.WorkingDir], ['--hostname', c.Hostname], ['--domainname', c.Domainname], ['--stop-signal', c.StopSignal]] as const) if (value) args.push(flag, value);
    if (h.ReadonlyRootfs) args.push('--read-only');
    if (h.Init) args.push('--init');
    if (h.ShmSize) args.push('--shm-size', String(h.ShmSize));
    for (const [flag, value] of [['--memory', h.Memory], ['--memory-swap', h.MemorySwap], ['--memory-reservation', h.MemoryReservation], ['--cpu-shares', h.CpuShares], ['--cpu-period', h.CpuPeriod], ['--cpu-quota', h.CpuQuota], ['--pids-limit', h.PidsLimit]] as const) if (value) args.push(flag, String(value));
    if (h.NanoCpus) args.push('--cpus', String(h.NanoCpus / 1_000_000_000));
    if (h.CpusetCpus) args.push('--cpuset-cpus', h.CpusetCpus);
    if (h.CpusetMems) args.push('--cpuset-mems', h.CpusetMems);
    if (h.LogConfig?.Type) args.push('--log-driver', h.LogConfig.Type);
    for (const [key, value] of Object.entries(h.LogConfig?.Config ?? {})) args.push('--log-opt', `${key}=${value}`);
    for (const v of h.CapDrop ?? []) args.push('--cap-drop', v);
    for (const v of h.Dns ?? []) args.push('--dns', v);
    for (const v of h.ExtraHosts ?? []) args.push('--add-host', v);
    for (const [target, options] of Object.entries(h.Tmpfs ?? {})) args.push('--tmpfs', `${target}${options ? `:${options}` : ''}`);
    // A multi-word entrypoint is an executable plus leading arguments, before the original command.
    args.push('--entrypoint', c.Entrypoint?.[0] ?? '', c.Image, ...(c.Entrypoint?.slice(1) ?? []), ...(c.Cmd ?? []));
    return args;
}

/** The settings/state approved before downloading, compared again before the first interruption. */
export function updateFingerprint(i: UpdateContainer): string {
    return JSON.stringify([i.Id, i.Image, i.State?.Status, i.State?.StartedAt, i.Config, i.HostConfig, i.Mounts]);
}

/** Docker can echo env or command arguments in an error. Keep credentials out of UI/MCP errors. */
export function maskUpdateFailure(message: string, i: UpdateContainer): string {
    const values = [...(i.Config?.Env ?? []).map((v) => v.slice(v.indexOf('=') + 1)), ...(i.Config?.Cmd ?? [])].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
    return values.reduce((out, value) => out.split(value).join('********'), message);
}
