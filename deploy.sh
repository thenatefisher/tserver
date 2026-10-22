#!/usr/bin/env bash
# Deploy the application with a fresh admin credential. Inputs: gcloud credentials
# and optional PROJECT_ID/REGION/SERVICE_NAME. Output: deployed service and an owner-only
# .admin-secret.tmp file. Side effects: updates Cloud Run ADMIN_TOKEN and rotates access
# after a successful deployment. Coupling: server sockets validate ADMIN_TOKEN.
set -euo pipefail
umask 077

deploy_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$deploy_root"
PROJECT_ID="${PROJECT_ID:-emerald-ivy-509712-r5}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-tserver}"
PUBLIC_GAME_URL="${PUBLIC_GAME_URL:-https://open.thisagentmd.com}"
# Only an origin is accepted; validation also makes flags-file serialization unambiguous.
if [[ ! "$PUBLIC_GAME_URL" =~ ^https?://[a-zA-Z0-9.:-]+$ ]]; then
  printf '%s\n' 'PUBLIC_GAME_URL must be an HTTP(S) origin without a path.' >&2
  exit 1
fi

printf '%s\n' '==> Authenticated as:'
gcloud auth list

# Stage credentials separately: a failed deployment must not overwrite the secret
# for the currently running revision. Never put the token in shell arguments/logs.
pending_secret="$(mktemp "$deploy_root/.admin-secret.tmp.XXXXXX")"
deploy_flags=''
cleanup() { rm -f "$pending_secret" "$deploy_flags"; }
trap cleanup EXIT
deploy_flags="$(mktemp "$deploy_root/.admin-deploy-flags.tmp.XXXXXX")"
openssl rand -hex 32 > "$pending_secret"
printf '{"--update-env-vars":{"ADMIN_TOKEN":"%s","PUBLIC_GAME_URL":"%s"}}\n' "$(cat "$pending_secret")" "$PUBLIC_GAME_URL" > "$deploy_flags"

printf '==> Deploying %s to Cloud Run (Region: %s, Project: %s)...\n' "$SERVICE_NAME" "$REGION" "$PROJECT_ID"
# update-env-vars preserves other configured environment values; flags-file avoids
# exposing the credential in the process command line or embedding it in the image.
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --allow-unauthenticated \
  --timeout 3600 \
  --max-instances 1 \
  --session-affinity \
  --flags-file "$deploy_flags"

mv -f "$pending_secret" "$deploy_root/.admin-secret.tmp"
chmod 600 "$deploy_root/.admin-secret.tmp"
printf '%s\n' '==> Deployment complete!' 'Admin secret saved to .admin-secret.tmp (owner read/write only).'
printf '%s\n' 'Open /admin and paste the file contents into the Admin token field.' 'Service URL:'
gcloud run services describe "$SERVICE_NAME" --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)'
