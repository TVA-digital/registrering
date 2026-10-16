#!/usr/bin/env bash
# Deployer backup-påmeldingen til Google Cloud Run med Firestore som database.
#
# Bruk:  PROJECT_ID=mitt-prosjekt ./deploy-cloudrun.sh
# Krever: gcloud CLI innlogget med en bruker som har Owner/Editor i prosjektet.
set -euo pipefail

: "${PROJECT_ID:?Sett PROJECT_ID, f.eks. PROJECT_ID=tva-pamelding ./deploy-cloudrun.sh}"
REGION="${REGION:-europe-north1}"          # Finland – nærmeste GCP-region til Norge
SERVICE="${SERVICE:-pamelding-backup}"
SECRET="${SECRET:-pamelding-admin-passord}"

gcloud config set project "$PROJECT_ID" >/dev/null

if [[ "$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null)" != "True" ]]; then
  echo "✘ Fakturering er ikke aktivert for $PROJECT_ID."
  echo "  Gå til https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID og koble på en faktureringskonto."
  exit 1
fi

echo "→ Aktiverer nødvendige API-er …"
gcloud services enable run.googleapis.com firestore.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

echo "→ Oppretter Firestore-database (hopper over hvis den finnes) …"
if ! gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then
  gcloud firestore databases create --location="$REGION" --type=firestore-native
fi

echo "→ Admin-passord i Secret Manager …"
if ! gcloud secrets describe "$SECRET" >/dev/null 2>&1; then
  PASSORD="$(openssl rand -base64 18)"
  printf '%s' "$PASSORD" | gcloud secrets create "$SECRET" --data-file=- --replication-policy=automatic
  echo "   Nytt admin-passord (lagre det i passordhvelvet): $PASSORD"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:$RUN_SA" \
  --role=roles/secretmanager.secretAccessor >/dev/null
# Tjenestekontoen trenger Firestore-tilgang, og på nye prosjekter også rettighet til å bygge fra kildekode
for ROLE in roles/datastore.user roles/cloudbuild.builds.builder roles/logging.logWriter roles/artifactregistry.writer roles/storage.objectViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$RUN_SA" \
    --role="$ROLE" --condition=None >/dev/null
done

echo "→ Bygger og deployer til Cloud Run …"
gcloud run deploy "$SERVICE" \
  --source . \
  --quiet \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 20 \
  --concurrency 80 \
  --memory 512Mi \
  --set-env-vars "STORAGE=firestore,GOOGLE_CLOUD_PROJECT=$PROJECT_ID" \
  --set-secrets "ADMIN_PASSWORD=${SECRET}:latest"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "✓ Ferdig! Påmelding: $URL"
echo "  Admin/eksport:    $URL/admin   (bruker: admin)"
