# Deployment and admin access

Run `./deploy.sh` with an authenticated Google Cloud CLI. The defaults target the existing project/service/region; override `PROJECT_ID`, `SERVICE_NAME` or `REGION` when needed.

Each deployment generates a new 256-bit random `ADMIN_TOKEN` and updates that Cloud Run environment value without removing other configured environment values. The credential is passed through an owner-only temporary gcloud flags file rather than command-line arguments. Deployment itself changes the live service and requires the usual project permissions.

After a successful deployment, the script saves the token as `.admin-secret.tmp` in the repository root, with mode 0600. Read that file locally and paste its contents into the **Admin token** field at `/admin`. Do not put the token in URLs. Successful deployments rotate admin access; previously saved browser tokens must be replaced. A failed deployment preserves the prior saved secret and cleans up newly staged credential files. If deployment succeeds but the local process is interrupted before saving the file, recover the configured value through the service's authorized environment configuration.

`.admin-secret.tmp*` and `.admin-deploy-flags.tmp*` are excluded by `.gitignore`, `.dockerignore` and `.gcloudignore`. Keep the dotfile private and temporary; removing it locally does not revoke the already configured Cloud Run token. Rotate by deploying again. The application already reads `ADMIN_TOKEN`; local `npm start` can still receive it through the environment. Without it, the existing local trusted-LAN admin behavior is unchanged.

The dashboard document is served at `/admin`; `/admin.html` redirects there. Public `/` is only a `text/markdown` agent instruction document pointing to `https://open.thisagentmd.com/mcp`, with no admin UI or secret. `/ping`, `/sessions`, and the player `/fly` interface remain separate routes. Serving the admin login document does not authorize data access: the Socket.IO admin handshake must supply the configured token.
