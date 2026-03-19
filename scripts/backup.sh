#!/bin/bash
set -euo pipefail

# Database backup script for Discord Secretary
# Environment variables:
#   DATABASE_URL     - PostgreSQL connection string (required)
#   BACKUP_DIR       - Directory to store backups (default: /backups)
#   BACKUP_RETENTION_DAYS - Days to keep old backups (default: 7)

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="secretary_${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: DATABASE_URL is required" >&2
    exit 1
fi

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

# Run backup
echo "Starting backup to ${FILEPATH}..."
pg_dump "${DATABASE_URL}" | gzip > "${FILEPATH}"

# Verify file size
FILE_SIZE=$(stat -f%z "${FILEPATH}" 2>/dev/null || stat --format=%s "${FILEPATH}" 2>/dev/null || echo "0")
if [ "${FILE_SIZE}" -eq 0 ]; then
    echo "ERROR: Backup file is empty" >&2
    rm -f "${FILEPATH}"
    exit 1
fi

echo "Backup complete: ${FILENAME} (${FILE_SIZE} bytes)"

# Clean up old backups
if [ "${BACKUP_RETENTION_DAYS}" -gt 0 ]; then
    DELETED=$(find "${BACKUP_DIR}" -name "secretary_*.sql.gz" -mtime +"${BACKUP_RETENTION_DAYS}" -delete -print | wc -l)
    if [ "${DELETED}" -gt 0 ]; then
        echo "Deleted ${DELETED} backup(s) older than ${BACKUP_RETENTION_DAYS} days"
    fi
fi
