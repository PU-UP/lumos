$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
}
$outputFile = Join-Path $projectRoot 'Lumos.exe'
$sourceFile = Join-Path $PSScriptRoot 'LumosLauncher.cs'
& $compiler /nologo /target:winexe /platform:anycpu /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/out:$outputFile" $sourceFile
if ($LASTEXITCODE -ne 0) { throw 'Lumos launcher compilation failed' }
Write-Output "Built $projectRoot/Lumos.exe"
