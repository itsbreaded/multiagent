# MultiAgent PowerShell shell integration.
# Modeled after VS Code's OSC 633 prompt contract, scoped to CWD reporting and
# command boundary markers used by xterm.js shell integration.

if ((Test-Path variable:global:__MultiAgentState) -and $null -ne $Global:__MultiAgentState.OriginalPrompt) {
	return
}

if ($ExecutionContext.SessionState.LanguageMode -ne "FullLanguage") {
	return
}

$Global:__MultiAgentState = @{
	OriginalPrompt = $function:Prompt
	LastHistoryId = -1
	IsInExecution = $false
	HasPSReadLine = $false
}

function Global:__MultiAgent-Escape-Value([string]$value) {
	[regex]::Replace($value, "[$([char]0x00)-$([char]0x1f)\\`n;]", {
		param($match)
		-Join ([System.Text.Encoding]::UTF8.GetBytes($match.Value) | ForEach-Object { '\x{0:x2}' -f $_ })
	})
}

function Global:Prompt() {
	$FakeCode = [int]!$global:?
	Set-StrictMode -Off
	$LastHistoryEntry = Get-History -Count 1
	$Result = ""

	if ($Global:__MultiAgentState.LastHistoryId -ne -1 -and ($Global:__MultiAgentState.HasPSReadLine -eq $false -or $Global:__MultiAgentState.IsInExecution -eq $true)) {
		$Global:__MultiAgentState.IsInExecution = $false
		if ($LastHistoryEntry.Id -eq $Global:__MultiAgentState.LastHistoryId) {
			$Result += "$([char]0x1b)]633;D`a"
		} else {
			$Result += "$([char]0x1b)]633;D;$FakeCode`a"
		}
	}

	$Result += "$([char]0x1b)]633;A`a"
	if ($pwd.Provider.Name -eq 'FileSystem') {
		$Result += "$([char]0x1b)]633;P;Cwd=$(__MultiAgent-Escape-Value $pwd.ProviderPath)`a"
	}

	if ($FakeCode -ne 0) {
		Write-Error "failure" -ErrorAction Ignore
	}

	$OriginalPrompt = $Global:__MultiAgentState.OriginalPrompt.Invoke()
	$Result += $OriginalPrompt
	$Result += "$([char]0x1b)]633;B`a"
	$Global:__MultiAgentState.LastHistoryId = $LastHistoryEntry.Id
	return $Result
}

if (Get-Module -Name PSReadLine) {
	$Global:__MultiAgentState.HasPSReadLine = $true
	[Console]::Write("$([char]0x1b)]633;P;HasRichCommandDetection=True`a")

	$Global:__MultiAgentState.OriginalPSConsoleHostReadLine = $function:PSConsoleHostReadLine
	function Global:PSConsoleHostReadLine {
		$CommandLine = $Global:__MultiAgentState.OriginalPSConsoleHostReadLine.Invoke()
		$Global:__MultiAgentState.IsInExecution = $true
		[Console]::Write("$([char]0x1b)]633;E;$(__MultiAgent-Escape-Value $CommandLine)`a$([char]0x1b)]633;C`a")
		$CommandLine
	}
}

