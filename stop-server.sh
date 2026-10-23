#!/usr/bin/env bash
set -e

PROJECT_ID="emerald-ivy-509712-r5"
REGION="us-central1"
SERVICE_NAME="tserver"

echo "==> Deleting Cloud Run service $SERVICE_NAME..."
gcloud run services delete "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --quiet

echo "==> Cloud Run service $SERVICE_NAME deleted successfully."
