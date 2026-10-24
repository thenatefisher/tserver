# Admin panel

Open `/admin` and enter the existing `ADMIN_TOKEN`. No keys are created or rotated by the panel. Without a configured server token, admin connections are rejected. Players retain public access. Login uses the socket handshake; the dashboard is revealed only after the server confirms admin authentication. The token is held in memory, never in browser storage. Sign out clears it; reload requires login again.

The left navigation contains Event logs, Sessions, Clients & meshes, and World & terrain. The footer always reports server-wide connected players (including the lobby), registered meshes across every session, server uptime, session count, lobby count and the range of session tick rates. These private metrics refresh once per second independently of session timers, including when no sessions exist. Admins log into the server lobby. A session selector appears only in the mesh and world tools; it never changes footer totals or the all-session event stream. Logs cover every session and lobby connection; the log session filter is optional.

The event stream retains the latest 1,000 events in server memory, including connections before registration, transport upgrades, disconnect reasons, registration attempts, accepted descriptors, exact validation failures, rejected commands and admin commands. Both `register_actor` and actor packages submitted with `join_session` are covered. Logs are delivered only to authenticated admins and disappear on server restart.

Expand an event for its observed peer IP, unverified forwarded IP, raw user agent, inferred browser family, client hints, platform, mobile hint, origin, language and transport. Reported protocol/schema/contract versions are recorded when supplied; absent versions are null (unknown). First action frames also record the client's protocol version. Server protocol version, JSON Schema draft and a SHA-256 fingerprint of the current schema set identify the server contract; they do not establish which schema a client used.

Registration package summaries include fields such as name, client type, physics profile and mesh metadata. Raw GLB payloads are replaced by base64 character counts. Credential-like field names are redacted; depth, arrays, fields and strings have limits and large packages are truncated. Forwarded headers and client declarations are not verified identities.

Search covers the full retained JSON. Combine it with event, severity, exact session, client/IP and local time filters. Pause freezes a browser snapshot while the server and browser continue retaining their bounded live history. Export downloads the filtered snapshot as JSON. Reset clears filters. Empty results are shown explicitly.

Styling is compiled locally with Tailwind CSS; there is no runtime CDN dependency. After editing the panel markup or classes, run `npm run build:admin`. Commit `modules/server/public/admin.css` with the source so production installs can omit development dependencies.

## Session management

The Sessions module operates independently of observer session membership. Select a session to edit its name, player limit (1–256), tick rate (1–120 Hz), discovery mode label, admission state and terrain preset, or create a new session using a unique ID. Closed admission blocks new players while existing players continue. Tick rate updates replace the live session timers. Capacity cannot be reduced below occupied and reconnect-reserved slots. Parameter updates include a revision check; reload before saving when another admin changed the configuration. Changes are held in memory.

The roster includes playing, loading and unregistered selected players. Remove to lobby keeps the connection open; Kick disconnects it; Ban IP disconnects matching members of that session and removes matching reconnect reservations. Move checks the destination's admission, capacity and bans before leaving the original session, preserving the original membership on failure. Banned addresses can be unbanned, and reconnect reservations can be released without exposing resume tokens.

Deleting requires typing the exact session ID. It returns members to the lobby, releases reservations, stops the simulation and disposes world state. The admin can delete every session and create a new one while global logs and stats continue.

Private server commands are `admin_list_sessions`, `admin_create_session`, `admin_update_session`, `admin_delete_session`, `admin_session_user`, `admin_session_unban` and `admin_revoke_reservation`. All require an authenticated admin and accept acknowledgment callbacks. They explicitly target session IDs and do not depend on the admin's inspected session. `admin_server_metrics` and `admin_sessions` are delivered only to admins; they contain no authentication or resumption secrets.
