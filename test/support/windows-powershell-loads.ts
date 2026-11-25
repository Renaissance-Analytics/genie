/**
 * WHAT A TEST'S OWN WINDOWS POWERSHELL CHILD HAD TO LOAD (Tynn #989).
 *
 * A Windows PowerShell 5.1 child that imports a module (Get-Acl: Microsoft.PowerShell.Security; ConvertTo-Json:
 * Microsoft.PowerShell.Utility) or that serializes with ConvertTo-Json (System.Web.Extensions) reads, the first time on a
 * new test VM, files nothing on that VM has read since it was made. Measured in-session on a fresh D8ads_v5 (queue
 * 1125-223626-741970): System.Web.Extensions.ni.dll took 1.04 s to load with 0.23 s of CPU, ConvertTo-Json 1.4 s more,
 * Get-Acl 1.85 s; warm, each is under 0.1 s. Beside the unit suite's own disk work that first read ran to 15 s (the p4
 * real-ACL check, killed at its 15 s) and 45 s (the windows-signing adapter check, inside one spawnSync) in gate
 * 1125-204645-d2ed56, and to 15 s and 23 s in 1120-034951-f7d7ca. The product's own ACL scripts use .NET only.
 *
 * Append LOADS_PROBE to the child's script; loadsOf(stderr) is every module it imported and System.Web.Extensions if it
 * loaded it. A check whose answer is [] cannot be held up by that cold first read.
 */
export const LOADS_PROBE = ";[Console]::Error.WriteLine('GENIE_PS_LOADS ' + ((@(Get-Module | ForEach-Object { $_.Name }) + @([AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object { $_.GetName().Name } | Where-Object { $_ -eq 'System.Web.Extensions' })) -join ','))";

export function loadsOf(stderr: string): string[] {
    const line = /GENIE_PS_LOADS ([^\r\n]*)/.exec(stderr);
    if (!line) throw new Error(`the Windows PowerShell child did not report what it loaded: ${JSON.stringify(stderr.slice(0, 400))}`);
    return (line[1] ?? "").split(',').map(name => name.trim()).filter(Boolean);
}
