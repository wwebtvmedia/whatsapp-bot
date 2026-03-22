# backup-mongo.ps1
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupFolder = "backups"
$containerName = "mongo"

# Ensure backup folder exists
if (-not (Test-Path $backupFolder)) {
    New-Item -ItemType Directory -Path $backupFolder
}

# Execute the backup using docker exec + mongodump
docker exec $containerName mongodump --archive > "$backupFolder/mongo-backup-$timestamp.archive"

Write-Host "✅ Backup completed: $backupFolder/mongo-backup-$timestamp.archive"
