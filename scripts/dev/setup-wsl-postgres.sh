#!/usr/bin/env bash
# Fallback dev setup when Docker is unavailable: PostgreSQL 18 + pgvector inside a WSL/Ubuntu distro.
# Usage (from Windows): wsl -d Ubuntu -- bash scripts/dev/setup-wsl-postgres.sh
# Idempotent. Creates role "comparator" (dev password) and databases "comparator", "comparator_test" (wiped by tests)
# and "comparator_bench" (synthetic load benchmark).
set -euo pipefail

if ! command -v pg_lsclusters >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql-18 postgresql-18-pgvector
fi

PSQL=(sudo -u postgres psql -v ON_ERROR_STOP=1 -tA)

"${PSQL[@]}" -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'comparator') THEN
    CREATE ROLE comparator LOGIN PASSWORD 'comparator_dev' CREATEDB;
  END IF;
END \$\$;"

for db in comparator comparator_test comparator_bench; do
  if [ "$("${PSQL[@]}" -c "SELECT 1 FROM pg_database WHERE datname = '$db'")" != "1" ]; then
    sudo -u postgres createdb -O comparator "$db"
  fi
  # Extensions need superuser on first creation; migrations then only use them.
  "${PSQL[@]}" -d "$db" -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS citext;"
done

"${PSQL[@]}" -c "SELECT version();"
"${PSQL[@]}" -d comparator -c "SELECT extname || ' ' || extversion FROM pg_extension ORDER BY 1;"
