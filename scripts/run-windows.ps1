param(
  [switch]$SkipBuild,
  [int]$Port = 12800,
  [string]$DatabaseUrl = "postgres://postgres@127.0.0.1:5432/cartethyia?sslmode=disable",
  [string]$RedisUrl = "redis://127.0.0.1:6379/0"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$dashboard = Join-Path $repo "dashboard"
$daemonDir = Join-Path $repo "daemon"
$binary = Join-Path $daemonDir "tmp\cartethyia-windows.exe"
$dashboardDir = Join-Path $dashboard "dist"

function Assert-Command([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name tidak ditemukan di PATH."
  }
}

function Assert-Port([int]$port, [string]$name) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if ($listener) {
    throw "Port $port sedang dipakai. Hentikan proses $name lama atau gunakan -Port lain."
  }
}

Assert-Command "bun"
Assert-Command "go"
Assert-Port $Port "Cartethyia"

foreach ($dependency in @(
  @{ Name = "PostgreSQL"; Port = 5432 },
  @{ Name = "Redis"; Port = 6379 }
)) {
  if (-not (Test-NetConnection -ComputerName "127.0.0.1" -Port $dependency.Port -InformationLevel Quiet)) {
    throw "$($dependency.Name) tidak aktif di 127.0.0.1:$($dependency.Port). Nyalakan service Laragon lalu jalankan ulang."
  }
}

if (-not $SkipBuild) {
  Push-Location $dashboard
  try {
    bun run build
    if ($LASTEXITCODE -ne 0) { throw "Dashboard build gagal." }
  } finally {
    Pop-Location
  }

  Push-Location $daemonDir
  try {
    New-Item -ItemType Directory -Force (Split-Path $binary) | Out-Null
    go build -o $binary ./cmd/cartethyia
    if ($LASTEXITCODE -ne 0) { throw "Daemon build gagal." }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path (Join-Path $dashboardDir "index.html"))) {
  throw "Dashboard build tidak ditemukan: $dashboardDir"
}
if (-not (Test-Path $binary)) {
  throw "Daemon binary tidak ditemukan: $binary"
}

$env:CARTETHYIA_LISTEN_ADDRESS = ":$Port"
$env:CARTETHYIA_DASHBOARD_DIR = $dashboardDir
$env:CARTETHYIA_DATABASE_URL = $DatabaseUrl
$env:CARTETHYIA_REDIS_URL = $RedisUrl

$process = Start-Process `
  -FilePath $binary `
  -WorkingDirectory $repo `
  -WindowStyle Minimized `
  -PassThru

Write-Host "Cartethyia berjalan di background."
Write-Host "Website + dashboard + /console + /v1: http://127.0.0.1:$Port/"
Write-Host "PID: $($process.Id)"
Write-Host "Stop: Stop-Process -Id $($process.Id)"
