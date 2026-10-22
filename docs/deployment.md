# Deployment and admin access

Run `./deploy.sh` with an authenticated Google Cloud CLI. The defaults target the existing project/service/region; override `PROJECT_ID`, `SERVICE_NAME` or `REGION` when needed.

Each deployment generates a new 256-bit random `ADMIN_TOKEN` and updates that Cloud Run environment value without removing other configured environment values. The credential is passed through an owner-only temporary gcloud flags file rather than command-line arguments. Deployment itself changes the live service and requires the usual project permissions.

After a successful deployment, the script saves the token as `.admin-secret.tmp` in the repository root, with mode 0600. Read that file locally and paste its contents into the **Admin token** field at `/admin`. Do not put the token in URLs. Successful deployments rotate admin access; previously saved browser tokens must be replaced. A failed deployment preserves the prior saved secret and cleans up newly staged credential files. If deployment succeeds but the local process is interrupted before saving the file, recover the configured value through the service's authorized environment configuration.

`.admin-secret.tmp*` and `.admin-deploy-flags.tmp*` are excluded by `.gitignore`, `.dockerignore` and `.gcloudignore`. Keep the dotfile private and temporary; removing it locally does not revoke the already configured Cloud Run token. Rotate by deploying again. The application already reads `ADMIN_TOKEN`; local `npm start` can still receive it through the environment. Without it, the existing local trusted-LAN admin behavior is unchanged.

The dashboard document is served at `/admin`; `/admin.html` redirects there. Public `/` is only a `text/markdown` agent instruction document pointing to `https://open.thisagentmd.com/mcp`, with no admin UI or secret. `/ping`, `/sessions`, and the player `/fly` interface remain separate routes. Serving the admin login document does not authorize data access: the Socket.IO admin handshake must supply the configured token.

## Public local-file browser clients

Cloud Run exposes the game at `https://open.thisagentmd.com` on public HTTPS port 443. It does not expose a public custom port 4242; changing container PORT only changes internal ingress. DNS/custom-domain/TLS mapping must point this hostname to the deployed service. Load `https://open.thisagentmd.com/tbn.js` from local HTML; the file bundles Socket.IO and defaults to the public game URL. Raw `/socket.io/socket.io.js` and `/socket.io/` use the same origin. Cloud Run handles HTTP-to-HTTPS at ingress; clients should use the HTTPS script URL rather than rely on port-80 assets. No separate port-80 process runs inside the container.

`PUBLIC_GAME_URL` controls the advertised origin and hosted adapter default. `ALLOWED_BROWSER_ORIGINS` optionally adds comma-separated exact hosted origins. The server permits literal `Origin: null` for local-file pages and missing Origin for native clients, plus its hosted origin/local development views. Polling receives matching CORS headers without credentials, and WebSocket admission checks the same origin policy. Opaque origins cannot prove a page is a local file; origin admission is not admin authorization. Admin tokens remain required on configured deployments.

Deployment uses public invocation, a one-hour request timeout for WebSockets, session affinity and a maximum of one instance because game sessions are in memory. Connections still reconnect/register after timeouts or deployment. Revisions/restarts lose session state; session affinity alone does not make state durable or synchronize instances. The script updates configuration only when explicitly run; source changes do not change live DNS, certificates or services.
