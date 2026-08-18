# Redential CLI standalone-binary installer for Windows (issue #87,
# docs/install-binaries.md).
#
# TRUST CONTRACT: this script is versioned in the redential-cli repo itself
# (Redential/redential-cli), the same public repo that produces the binary
# it installs — it is not a third-party wrapper. It does exactly, and only:
#   1. detect your architecture
#   2. download the matching binary from the latest GitHub Release
#   3. download SHA256SUMS from that same release and verify the binary
#      against it before installing anything
#   4. install into a per-user directory (never a system directory, never
#      an elevated/admin prompt)
# It never invokes a second remote script, never phones any host other than
# github.com, and stops immediately on any error — a partial/corrupted
# install is refused, not silently accepted.
#
# Usage: irm https://redential.com/install.ps1 | iex
#   (redential.com/install.ps1 redirects to this exact file, pinned at a
#   tagged release — see docs/install-binaries.md for how to audit that
#   redirect yourself before trusting it.)

$ErrorActionPreference = "Stop"

$Repo = "Redential/redential-cli"
$ReleaseBase = "https://github.com/$Repo/releases/latest/download"

function Write-Log($Message) {
    Write-Host "[redential-install] $Message"
}

function Fail($Message) {
    Write-Error "[redential-install] ERROR: $Message"
    exit 1
}

# --- 1. Detect architecture --------------------------------------------------
$arch = $env:PROCESSOR_ARCHITECTURE
switch ($arch) {
    "AMD64" { $assetArch = "x64" }
    "ARM64" { Fail "arm64 Windows binaries are not published yet — see issue #87 for status." }
    default { Fail "unsupported architecture: $arch" }
}

$assetName = "redential-win-$assetArch.exe"
Write-Log "Detected platform: windows/$assetArch -> asset $assetName"

# --- 2. Download the binary + checksums --------------------------------------
$workDir = Join-Path $env:TEMP ("redential-install-" + [System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $workDir | Out-Null

try {
    $binaryPath = Join-Path $workDir $assetName
    $sumsPath = Join-Path $workDir "SHA256SUMS"

    Write-Log "Downloading $assetName..."
    Invoke-WebRequest -Uri "$ReleaseBase/$assetName" -OutFile $binaryPath -UseBasicParsing

    Write-Log "Downloading SHA256SUMS..."
    Invoke-WebRequest -Uri "$ReleaseBase/SHA256SUMS" -OutFile $sumsPath -UseBasicParsing

    # --- 3. Verify the checksum before installing anything -------------------
    $sumsContent = Get-Content $sumsPath
    $expectedLine = $sumsContent | Where-Object { $_ -match [regex]::Escape($assetName) }
    if (-not $expectedLine) {
        Fail "no checksum entry for $assetName in SHA256SUMS — refusing to install an unverifiable binary"
    }
    $expected = ($expectedLine -split '\s+')[0]

    $actual = (Get-FileHash -Path $binaryPath -Algorithm SHA256).Hash.ToLower()
    if ($expected.ToLower() -ne $actual) {
        Fail "checksum mismatch for $assetName`: expected $expected, got $actual. The download may be corrupted or tampered with — NOT installing."
    }
    Write-Log "Checksum verified: $actual"

    # --- 4. Install ------------------------------------------------------------
    # Per-user directory, never a system path — this script never requests
    # elevation.
    $installDir = Join-Path $env:LOCALAPPDATA "redential\bin"
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null

    $target = Join-Path $installDir "redential.exe"
    Copy-Item -Path $binaryPath -Destination $target -Force

    Write-Log "Installed redential to $target"

    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$installDir*") {
        Write-Log "NOTE: $installDir is not on your PATH."
        Write-Log "Add it permanently with:"
        Write-Log "  [System.Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$installDir', 'User')"
        Write-Log "Then open a new terminal and run: redential --version"
    } else {
        Write-Log "Done. Open a new terminal and run: redential --version"
    }
}
finally {
    Remove-Item -Path $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
