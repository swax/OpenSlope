param([string]$Iso = '')
$ErrorActionPreference = 'Stop'
try {
    if (-not $Iso) {
        Add-Type -AssemblyName System.Windows.Forms
        $taskPicker = New-Object System.Windows.Forms.OpenFileDialog
        $taskPicker.Title = 'Choose your local SSX Tricky PS2 ISO'
        $taskPicker.Filter = 'Disc image (*.iso)|*.iso'
        try {
            if ($taskPicker.ShowDialog() -ne 'OK') { exit 0 }
            $Iso = $taskPicker.FileName
        } finally { $taskPicker.Dispose() }
    }
    $taskIso = (Resolve-Path -LiteralPath $Iso).Path
    $taskImporter = Join-Path $PSScriptRoot 'openslope_import.exe'
    $taskMaps = Join-Path $PSScriptRoot 'Maps'
    $taskCourses = @(& $taskImporter list $taskIso)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read supported courses from this ISO.' }
    $taskNames = @($taskCourses | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ -match '^[A-Z0-9_]+$' })
    if (-not $taskNames.Count) { throw 'No supported courses found.' }
    Write-Host ('Available courses: ' + ($taskNames -join ', '))
    $taskChoice = (Read-Host 'Enter one course name, or ALL to import all courses').Trim().ToUpperInvariant()
    $taskSelected = if ($taskChoice -eq 'ALL') { $taskNames } elseif ($taskNames -contains $taskChoice) { @($taskChoice) } else { throw 'Choose one of the listed course names.' }
    foreach ($taskCourse in $taskSelected) {
        if (Test-Path -LiteralPath (Join-Path $taskMaps $taskCourse)) {
            Write-Host "Skipping existing Maps/$taskCourse; your files are preserved."
            continue
        }
        Write-Host "Importing $taskCourse..."
        & $taskImporter extract $taskIso $taskCourse $taskMaps
        if ($LASTEXITCODE -ne 0) { throw "Import failed for $taskCourse. See the messages above." }
    }
    Write-Host 'Ready. Start or restart OpenSlope, open Maps, and choose a course.'
    Read-Host 'Press Enter to close' | Out-Null
} catch {
    Write-Error $_
    exit 1
}
