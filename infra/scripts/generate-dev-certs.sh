#!/usr/bin/env bash
#
# infra/scripts/generate-dev-certs.sh
#
# Generates a local, dev-only mTLS Certificate Authority and one leaf
# certificate per service, for use by packages/mtls in local/CI environments.
#
# This is NOT a production CA. It exists so every service-to-service call
# can be mTLS-authenticated in dev/CI without depending on a real PKI or
# the (still-blocked) HSM. Production certificate issuance is a separate,
# unbuilt concern — see packages/mtls/README.md, "Production gap" section.
#
# Usage:
#   infra/scripts/generate-dev-certs.sh [output-dir] [service ...]
#
#   output-dir   Defaults to certs/dev at the repo root.
#   service ...  Defaults to the 14 services + api-gateway list below.
#                Re-run with an explicit single service name to add/rotate
#                just that one without touching the others' keys.
#
# Output layout:
#   <output-dir>/ca/ca.crt              CA certificate (distribute to every
#                                        service as the trust anchor)
#   <output-dir>/ca/ca.key              CA private key (dev-only; in
#                                        production this is the thing that
#                                        would live in an HSM/offline root)
#   <output-dir>/<service>/<service>.crt   leaf cert, CN=<service>,
#                                           SAN=DNS:<service>,DNS:localhost
#   <output-dir>/<service>/<service>.key   leaf private key
#
# Idempotent: re-running regenerates the CA only if ca.key is missing, and
# regenerates a leaf only for the services listed on the command line (or
# all of them if none are given), so `generate-dev-certs.sh docs/repo-layout.txt
# document-issuance` rotates just one service without re-issuing everyone
# else's certs (and without touching the CA).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OUT_DIR="${1:-${REPO_ROOT}/certs/dev}"
shift || true

DEFAULT_SERVICES=(
  auth
  citizen-locker-api
  agency-workspace-api
  document-issuance
  consent-engine
  verification-engine
  qr-verification
  offline-verifier
  payment-engine
  notifications
  reporting-engine
  admin-api
  api-gateway
  ussd-gateway
)

SERVICES=("$@")
if [ ${#SERVICES[@]} -eq 0 ]; then
  SERVICES=("${DEFAULT_SERVICES[@]}")
fi

CA_DIR="${OUT_DIR}/ca"
CA_KEY="${CA_DIR}/ca.key"
CA_CRT="${CA_DIR}/ca.crt"
CA_SUBJ="/C=LR/O=Liberia Document Locker (DEV ONLY)/CN=liberia-locker-dev-ca"
CA_DAYS=3650      # 10 years — dev CA, not a production rotation policy
LEAF_DAYS=825     # ~2.25 years, under the CA/Browser Forum's max leaf lifetime

mkdir -p "${CA_DIR}"

if [ ! -f "${CA_KEY}" ]; then
  echo "==> No existing dev CA at ${CA_KEY} — generating one."
  openssl ecparam -name prime256v1 -genkey -noout -out "${CA_KEY}"
  chmod 600 "${CA_KEY}"
  openssl req -x509 -new -key "${CA_KEY}" -sha256 -days "${CA_DAYS}" \
    -subj "${CA_SUBJ}" \
    -out "${CA_CRT}"
  echo "==> Dev CA created: ${CA_CRT}"
else
  echo "==> Reusing existing dev CA at ${CA_KEY} (delete it to force a new root)."
fi

for SERVICE in "${SERVICES[@]}"; do
  SVC_DIR="${OUT_DIR}/${SERVICE}"
  mkdir -p "${SVC_DIR}"

  KEY="${SVC_DIR}/${SERVICE}.key"
  CSR="${SVC_DIR}/${SERVICE}.csr"
  CRT="${SVC_DIR}/${SERVICE}.crt"
  EXT="${SVC_DIR}/${SERVICE}.ext.cnf"

  echo "==> Issuing leaf cert for '${SERVICE}'"

  cat > "${EXT}" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=@alt_names

[alt_names]
DNS.1 = ${SERVICE}
DNS.2 = localhost
DNS.3 = ${SERVICE}.internal
EOF

  openssl ecparam -name prime256v1 -genkey -noout -out "${KEY}"
  chmod 600 "${KEY}"

  openssl req -new -key "${KEY}" \
    -subj "/C=LR/O=Liberia Document Locker (DEV ONLY)/CN=${SERVICE}" \
    -out "${CSR}"

  openssl x509 -req -in "${CSR}" \
    -CA "${CA_CRT}" -CAkey "${CA_KEY}" -CAcreateserial \
    -days "${LEAF_DAYS}" -sha256 \
    -extfile "${EXT}" \
    -out "${CRT}"

  rm -f "${CSR}" "${EXT}"

  echo "    -> ${CRT}"
  echo "    -> ${KEY}"
done

echo ""
echo "==> Done. CA trust anchor: ${CA_CRT}"
echo "==> Point each service at:"
echo "      MTLS_CA_PATH=${CA_CRT}"
echo "      MTLS_CERT_PATH=${OUT_DIR}/<service>/<service>.crt"
echo "      MTLS_KEY_PATH=${OUT_DIR}/<service>/<service>.key"
echo "==> These are dev-only certs. Do not commit ${OUT_DIR} — it is gitignored."
