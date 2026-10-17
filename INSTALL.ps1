# InterviewAI Pro - PowerShell Installer
# Right-click this file and choose "Run with PowerShell"

$Host.UI.RawUI.WindowTitle = "InterviewAI Pro Setup"
$ErrorActionPreference = "Continue"

function Write-Step($msg) { Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "    ERROR: $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "    $msg" -ForegroundColor Gray }

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "   InterviewAI Pro v2.0 - Setup" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green

# Step 1: Node check
Write-Step "Checking Node.js..."
try {
    $nodeVer = node --version 2>&1
    Write-OK "Node.js $nodeVer found"
} catch {
    Write-Fail "Node.js not found. Download from https://nodejs.org"
    Read-Host "Press Enter to exit"
    exit 1
}

# Step 2: npm check
Write-Step "Checking npm..."
try {
    $npmVer = npm.cmd --version 2>&1
    Write-OK "npm $npmVer found"
} catch {
    Write-Fail "npm not found."
    Read-Host "Press Enter to exit"
    exit 1
}

# Step 3: Change directory
Write-Step "Setting working directory..."
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir
Write-OK "Directory: $scriptDir"

# Step 4: npm install
Write-Step "Installing dependencies (Electron ~80MB, may take 2-5 minutes)..."
Write-Info "Please wait - do not close this window..."

$npmOutput = npm.cmd install 2>&1
Write-Info $npmOutput

if ($LASTEXITCODE -ne 0) {
    Write-Fail "npm install failed!"
    Write-Info $npmOutput
    Read-Host "Press Enter to exit"
    exit 1
}
Write-OK "Dependencies installed!"

# Step 5: Check electron binary
Write-Step "Verifying Electron..."
if (Test-Path "node_modules\electron\dist\electron.exe") {
    Write-OK "Electron binary found"
} else {
    Write-Fail "Electron binary missing - trying to download..."
    node node_modules\electron\install.js 2>&1
}

# Step 6: Launch
Write-Step "Launching InterviewAI Pro..."
Write-Info "Two windows will open: Control Panel + Stealth Overlay"
Write-Info "The overlay is invisible in Zoom/Meet/Teams screen share."
Write-Host ""

npm.cmd start

if ($LASTEXITCODE -ne 0) {
    Write-Fail "App failed to start. Error code: $LASTEXITCODE"
    Read-Host "Press Enter to exit"
    exit 1
}
