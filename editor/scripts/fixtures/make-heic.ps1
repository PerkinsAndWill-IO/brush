# Writes a small HEIC test card (fixtures/photos/test-card.heic) with the Windows HEIF encoder (WinRT
# BitmapEncoder; needs the HEVC Video Extensions, as shipped with Windows 11). Usage:
#   powershell -File scripts/fixtures/make-heic.ps1 -Out fixtures/photos/test-card.heic
param([string]$Out, [int]$W = 320, [int]$H = 240)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function AwaitAction($op) { $task = $asTaskAction.Invoke($null, @($op)); $task.Wait() }

$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
$enc = Await ([Windows.Graphics.Imaging.BitmapEncoder]::CreateAsync([Windows.Graphics.Imaging.BitmapEncoder]::HeifEncoderId, $stream)) ([Windows.Graphics.Imaging.BitmapEncoder])
# a test card: left half red, right half blue, a black bar along the top (to see the orientation), white elsewhere
$px = New-Object byte[] ($W * $H * 4)
for ($y = 0; $y -lt $H; $y++) {
  for ($x = 0; $x -lt $W; $x++) {
    $i = ($y * $W + $x) * 4
    if ($y -lt $H / 8) { $b = 0; $g = 0; $r = 0 }
    elseif ($x -lt $W / 2) { $b = 40; $g = 40; $r = 220 }
    else { $b = 220; $g = 60; $r = 30 }
    $px[$i] = $b; $px[$i + 1] = $g; $px[$i + 2] = $r; $px[$i + 3] = 255
  }
}
$enc.SetPixelData([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore, $W, $H, 96, 96, $px)
AwaitAction ($enc.FlushAsync())
$size = $stream.Size
$reader = New-Object Windows.Storage.Streams.DataReader ($stream.GetInputStreamAt(0))
$null = Await ($reader.LoadAsync([uint32]$size)) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes($Out, $bytes)
"wrote $size bytes to $Out"
