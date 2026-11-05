# session-watch-windows.ps1 — WHAT THE LOGGED-ON SESSION SHOWS, while a script runs in it. Started beside the script by keychain-sessions-windows.ps1 -Phase script. On genie-test-windows only.
#
# A window that wants a click, a prompt, or nothing on screen at all cannot be seen from SSH: Get-Process has no window titles from another session, and VBoxManage's screenshot came back black at the end of a
# 42-minute hang (batch HH). So from inside the session: every window with a title, when the list changes, and a picture early on and then the latest. It ends when the script's done file appears. It decides nothing.
param([Parameter(Mandatory = $true)][string]$Done, [Parameter(Mandatory = $true)][string]$Log, [Parameter(Mandatory = $true)][string]$Shot)
$ErrorActionPreference = 'Continue'
try { Add-Type -AssemblyName System.Windows.Forms, System.Drawing } catch { Add-Content -Path $Log -Value "--- no pictures: $($_.Exception.Message)" }

function Take([string]$file) {
    try {
        $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        $bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose()
        $bitmap.Dispose()
    } catch { Add-Content -Path $Log -Value "--- no picture: $($_.Exception.Message)" }
}

$last = ''
$tick = 0
while (-not (Test-Path $Done)) {
    $windows = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName) $($_.Id) '$($_.MainWindowTitle)'" }) -join '; '
    if ($windows -ne $last) {
        Add-Content -Path $Log -Value "$((Get-Date).ToString('HH:mm:ss')) windows: $(if ($windows) { $windows } else { 'none' })"
        $last = $windows
    }
    # 20 s, 2 min and 5 min are kept; after that the latest. *.png in the repo folder comes home with the run (vm-run.sh).
    if ($tick -eq 2 -or $tick -eq 12 -or $tick -eq 30) { Take "$Shot-$($tick * 10)s.png" }
    if ($tick -gt 30 -and $tick % 6 -eq 0) { Take "$Shot-latest.png" }
    $tick += 1
    Start-Sleep -Seconds 10
}
Take "$Shot-at-the-end.png"
