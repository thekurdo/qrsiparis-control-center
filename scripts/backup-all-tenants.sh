#!/usr/bin/env bash
# Iterates all tenant data dirs on the host and runs backup for each.
# IMPORTANT (per IMPL §1.B B3): also covers /data/internal-panel/ (control-center DB).

set -euo pipefail
ROOT_DATA_DIR="${ROOT_DATA_DIR:-/data}"
BACKUPS_BASE="${BACKUPS_BASE:-/data/backups}"
LOG_FILE="${BACKUP_LOG_FILE:-/var/log/qrsiparis-backup.log}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [host-backup] $*" | tee -a "${LOG_FILE}"
}

DATE_TAG=$(date -u +%Y%m%d-%H%M%S)

# 1. Per-tenant
for tenant_dir in "${ROOT_DATA_DIR}/restaurants/"*/; do
  [ -d "${tenant_dir}" ] || continue
  slug=$(basename "${tenant_dir}")
  db="${tenant_dir}db.sqlite"
  [ ! -f "${db}" ] && { log "skip ${slug}: no db.sqlite"; continue; }
  out_dir="${BACKUPS_BASE}/${slug}"
  mkdir -p "${out_dir}"
  out="${out_dir}/${slug}-${DATE_TAG}.sqlite.gz"

  log "Backing up tenant=${slug}"
  tmp=$(mktemp -t qrsiparis-XXXXXX.sqlite)
  if sqlite3 "${db}" ".backup ${tmp}"; then
    gzip -c "${tmp}" > "${out}"
    log "  → ${out} ($(stat --printf=%s "${out}") bytes)"
  else
    log "  ERROR: backup failed for ${slug}"
  fi
  rm -f "${tmp}"

  # Retention per tenant
  find "${out_dir}" -name '*.sqlite.gz' -mtime "+${RETENTION_DAYS}" -delete
done

# 2. Internal panel DB (PostgreSQL) — pg_dump (control-center DB)
PG_BACKUPS="${BACKUPS_BASE}/internal-panel"
mkdir -p "${PG_BACKUPS}"
PG_OUT="${PG_BACKUPS}/internal-panel-${DATE_TAG}.sql.gz"

if [ -n "${DATABASE_URL:-}" ]; then
  log "Backing up control-center PostgreSQL"
  if pg_dump "${DATABASE_URL}" 2>>"${LOG_FILE}" | gzip -c > "${PG_OUT}"; then
    log "  → ${PG_OUT}"
  else
    log "  ERROR: pg_dump failed"
  fi
  find "${PG_BACKUPS}" -name '*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete
fi

log "Multi-tenant backup complete"
