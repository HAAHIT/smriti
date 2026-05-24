# Installs the Native Messaging host manifest for Smriti.
# Registers the helper with Chrome, Edge, Brave, and Firefox under the current user.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-nm-manifest.ps1 `
#       -ExtensionId <chromium-extension-id> `
#       [-BraveExtensionId <brave-extension-id>] `
#       [-FirefoxExtensionId <firefox-ext-id@example>]
#
# If -BraveExtensionId is omitted, -ExtensionId is reused (works when you've
# loaded the SAME unpacked build folder into both Chrome and Brave — they each
# generate their own extension ID, but if they happen to match, one parameter
# is enough).
#
# The extension ID is obtained from chrome://extensions or brave://extensions
# (developer mode -> Details). For Firefox the ID comes from the extension
# manifest's browser_specific_settings.

param(
    [Parameter(Mandatory = $true)][string] $ExtensionId,
    [string] $BraveExtensionId = "",
    [string] $FirefoxExtensionId = ""
)

if ($BraveExtensionId -eq "") { $BraveExtensionId = $ExtensionId }

$ErrorActionPreference = "Stop"
$HostName = "com.smriti.helper"

# Resolve paths.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HelperRoot = Resolve-Path (Join-Path $ScriptDir "..")
$DistEntry = Join-Path $HelperRoot "dist\index.js"
$SrcEntry  = Join-Path $HelperRoot "src\index.ts"

# Pick built JS if it exists, otherwise fall back to tsx (dev).
if (Test-Path $DistEntry) {
    $WrapperBody = "@echo off`r`nnode `"$DistEntry`" %*"
    $Entry = $DistEntry
} else {
    $WrapperBody = "@echo off`r`nnpx --yes tsx `"$SrcEntry`" %*"
    $Entry = $SrcEntry
    Write-Host "WARNING: dist/index.js not found. Using tsx wrapper (slower start). Run 'npm run build' for production." -ForegroundColor Yellow
}

# Write the wrapper .bat. Browsers can launch .bat directly.
$WrapperPath = Join-Path $HelperRoot "smriti-helper.bat"
Set-Content -Path $WrapperPath -Value $WrapperBody -Encoding ascii
Write-Host "wrote wrapper: $WrapperPath"

# Write the manifest JSON. One file is reused across Chrome/Edge.
# Firefox needs a separate copy because allowed_extensions vs allowed_origins.
$ManifestDir = Join-Path $HelperRoot "nm-manifests"
New-Item -ItemType Directory -Path $ManifestDir -Force | Out-Null

# Chromium-family manifest (Chrome + Edge). One file with the Chrome ext ID.
$ChromeManifest = [pscustomobject]@{
    name             = $HostName
    description      = "Smriti helper - local AI conversation archive."
    path             = $WrapperPath
    type             = "stdio"
    allowed_origins  = @("chrome-extension://$ExtensionId/")
}
$ChromeManifestPath = Join-Path $ManifestDir "$HostName.chrome.json"
$ChromeManifest | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 $ChromeManifestPath

# Brave manifest. Brave reads from its own registry path AND requires the
# brave-loaded extension's ID in allowed_origins. If you loaded the same
# unpacked folder into Brave, its ID may differ from Chrome's.
$BraveManifest = [pscustomobject]@{
    name             = $HostName
    description      = "Smriti helper - local AI conversation archive."
    path             = $WrapperPath
    type             = "stdio"
    allowed_origins  = @("chrome-extension://$BraveExtensionId/")
}
$BraveManifestPath = Join-Path $ManifestDir "$HostName.brave.json"
$BraveManifest | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 $BraveManifestPath

if ($FirefoxExtensionId -ne "") {
    $FirefoxManifest = [pscustomobject]@{
        name                = $HostName
        description         = "Smriti helper - local AI conversation archive."
        path                = $WrapperPath
        type                = "stdio"
        allowed_extensions  = @($FirefoxExtensionId)
    }
    $FirefoxManifestPath = Join-Path $ManifestDir "$HostName.firefox.json"
    $FirefoxManifest | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 $FirefoxManifestPath
}

# Register the manifest paths in HKCU for each browser.
function Set-NMRegistry {
    param([string] $RegPath, [string] $ManifestPath, [string] $BrowserName)
    if (-not (Test-Path $RegPath)) {
        New-Item -Path $RegPath -Force | Out-Null
    }
    Set-ItemProperty -Path $RegPath -Name "(default)" -Value $ManifestPath
    Write-Host "registered $BrowserName at $RegPath -> $ManifestPath"
}

Set-NMRegistry "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"                  $ChromeManifestPath "Chrome"
Set-NMRegistry "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"                  $ChromeManifestPath "Edge"
Set-NMRegistry "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"     $BraveManifestPath  "Brave"

if ($FirefoxExtensionId -ne "") {
    Set-NMRegistry "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName" $FirefoxManifestPath "Firefox"
}

Write-Host ""
Write-Host "Done. Entry: $Entry"
Write-Host "Reload your extension and verify the helper port opens."
