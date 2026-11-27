# screenshot.ps1 - THE WHOLE PRIMARY SCREEN, AS THE PERSON SEES IT, TO A PNG (Tynn #1058 L5; the VM rows' visual proof on
# Windows: the launcher's tray menu and its question). Run in the logged-on session (In-Session): a session with no desktop
# copies nothing. The same copy vm-launcher-install.ps1's Shot makes.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ci/screenshot.ps1 -Out ci-out\x.png
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$dir = Split-Path -Parent $Out
if ($dir) { New-Item -ItemType Directory -Force $dir | Out-Null }
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "SCREENSHOT $Out ($($b.Width)x$($b.Height))"
