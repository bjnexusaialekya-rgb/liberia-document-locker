#!/usr/bin/env bash
# Idempotent Vault bootstrap for local/dev/staging: enables the Transit
# secrets engine and creates the 3 sensitivity-tier keys named in the
# master blueprint (RFP #11). Safe to re-run.
#
# Requires: `vault` CLI on PATH, VAULT_ADDR and VAULT_TOKEN set (or pass
# them inline: VAULT_ADDR=... VAULT_TOKEN=... ./scripts/bootstrap-vault.sh).
#
# The Node package (src/kms.ts VaultKms.bootstrap()) does the same thing
# over the HTTP API directly and is what services actually call at
# startup — this script exists for humans setting up a fresh local Vault
# without writing a Node script first, and as the documented manual
# equivalent for the README.

set -euo pipefail

: "${VAULT_ADDR:?VAULT_ADDR must be set, e.g. http://127.0.0.1:8200}"
: "${VAULT_TOKEN:?VAULT_TOKEN must be set}"

if ! command -v vault >/dev/null 2>&1; then
  echo "error: 'vault' CLI not found on PATH. Install it or use the HTTP API directly (see README)." >&2
  exit 1
fi

echo "==> Checking Vault health at ${VAULT_ADDR}"
vault status || true # non-zero exit on sealed/uninitialized dev vault is expected in some states; don't abort on this alone

echo "==> Enabling transit secrets engine (no-op if already enabled)"
if ! vault secrets list -format=json | grep -q '"transit/"'; then
  vault secrets enable transit
else
  echo "    transit/ already enabled"
fi

for tier in pii-standard pii-biometric payment-data; do
  echo "==> Ensuring key '${tier}' exists"
  if vault read -format=json "transit/keys/${tier}" >/dev/null 2>&1; then
    echo "    ${tier} already exists"
  else
    vault write -f "transit/keys/${tier}" type=aes256-gcm96
    echo "    ${tier} created"
  fi
done

echo "==> Done. Tier keys:"
vault list transit/keys
