# dpapi.ps1 - DPAPI (CurrentUser) protect/unprotect for the whale-memory vault.
# ASCII-only on purpose: avoids PowerShell 5.1 codepage issues on Windows.
#
# Usage: echo <base64> | powershell -File dpapi.ps1 protect|unprotect
# Output: base64 of the protected/unprotected bytes.

param(
    [Parameter(Mandatory = $true)][string]$Action
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$b64 = [Console]::In.ReadToEnd().Trim()
if (-not $b64) { throw 'empty input' }
$raw = [Convert]::FromBase64String($b64)

if ($Action -eq 'protect') {
    $out = [Security.Cryptography.ProtectedData]::Protect($raw, $null, 'CurrentUser')
} elseif ($Action -eq 'unprotect') {
    $out = [Security.Cryptography.ProtectedData]::Unprotect($raw, $null, 'CurrentUser')
} else {
    throw "unknown action: $Action"
}

[Console]::Out.Write([Convert]::ToBase64String($out))
