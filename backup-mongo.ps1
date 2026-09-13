# backup-mongo.ps1
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupFolder = "backups"

# Containers are named by compose (no fixed container_name in docker-compose.yml),
# so resolve the stack's Mongo through its compose labels.
$projectName = "whatsapp-bot"
$serviceName = "mongo"
$containerName = docker ps --filter "label=com.docker.compose.project=$projectName" --filter "label=com.docker.compose.service=$serviceName" --format "{{.Names}}" | Select-Object -First 1

if (-not $containerName) {
    Write-Host "❌ No running '$serviceName' container found for project '$projectName'. Is the stack up? (./install.sh)"
    exit 1
}

# Ensure backup folder exists
if (-not (Test-Path $backupFolder)) {
    New-Item -ItemType Directory -Path $backupFolder
}

# Execute the backup using docker exec + mongodump
docker exec $containerName mongodump --archive > "$backupFolder/mongo-backup-$timestamp.archive"

Write-Host "✅ Backup completed: $backupFolder/mongo-backup-$timestamp.archive"
