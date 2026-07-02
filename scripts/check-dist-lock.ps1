$ErrorActionPreference = 'Stop'

$distRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\win-unpacked')).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
) + [IO.Path]::DirectorySeparatorChar
$running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try {
        $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith(
            $distRoot,
            [StringComparison]::OrdinalIgnoreCase
        )
    } catch {
        $false
    }
})

if ($running.Count -eq 0) {
    exit 0
}

Write-Host 'ERROR: A packaged MultiAgent instance is running from dist\win-unpacked.'
Write-Host 'Close that instance before publishing, then rerun publish.bat.'
$running | ForEach-Object { Write-Host "  PID $($_.Id): $($_.Path)" }
exit 2
