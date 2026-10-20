# OpenTerm Hub installer for Windows.
#
#   irm https://raw.githubusercontent.com/sposito88/openterm-hub/main/install.ps1 | iex
#
# Downloads the latest setup .exe, checks its SHA-256 against the release's
# SHA256SUMS.txt and runs the installer. Set $env:OPENTERM_VERSION = 'v0.3.0'
# to install a specific release.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = 'sposito88/openterm-hub'
$api = "https://api.github.com/repos/$repo/releases"
$releaseUrl = if ($env:OPENTERM_VERSION) { "$api/tags/$($env:OPENTERM_VERSION)" } else { "$api/latest" }

$release = Invoke-RestMethod -Uri $releaseUrl -Headers @{ 'User-Agent' = 'openterm-hub-installer' }
$asset = $release.assets | Where-Object { $_.name -match '-setup-x64\.exe$' } | Select-Object -First 1
$sums = $release.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' } | Select-Object -First 1
if (-not $asset) { throw "O release $($release.tag_name) não tem instalador para Windows." }
if (-not $sums) { throw "O release $($release.tag_name) não publica SHA256SUMS.txt; instale manualmente em https://github.com/$repo/releases" }

$dir = Join-Path ([IO.Path]::GetTempPath()) ("openterm-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $dir | Out-Null
try {
  $exe = Join-Path $dir $asset.name
  Write-Host "==> OpenTerm Hub $($release.tag_name) ($($asset.name))" -ForegroundColor Green
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exe -UseBasicParsing
  $sumsText = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing).Content
  if ($sumsText -is [byte[]]) { $sumsText = [Text.Encoding]::UTF8.GetString($sumsText) }

  $line = ($sumsText -split "`n") | Where-Object { $_ -match ("\s" + [regex]::Escape($asset.name) + "\s*$") } | Select-Object -First 1
  if (-not $line) { throw "$($asset.name) não está no SHA256SUMS.txt" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLower()
  if ($expected -ne $actual) { throw "SHA-256 não confere para $($asset.name) (esperado $expected, obtido $actual)" }
  Write-Host '==> SHA-256 verificado' -ForegroundColor Green

  if ($env:OPENTERM_DRY_RUN) { Write-Host '==> OPENTERM_DRY_RUN: nada foi instalado'; return }

  Write-Host '==> Abrindo o instalador' -ForegroundColor Green
  Start-Process -FilePath $exe -Wait
  Write-Host '==> Pronto! Procure "OpenTerm Hub" no menu Iniciar.' -ForegroundColor Green
} finally {
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
