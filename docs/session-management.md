# Session admission and client migration

A socket without `auth.sessionId` connects to the lobby. It receives `sessions_list` immediately and when membership or the session registry changes. No actor, resource subscriptions, or physics membership is created in the lobby. `GET /sessions` remains available for discovery.

Summaries include `playerCount` (occupied and reconnect-reserved slots), `reservedPlayers`, `maxPlayers` (default 16), `gameMode`, `status`, `joinable`, and `unavailableReason`, alongside existing identity/terrain/count fields. An admin observer does not occupy a player slot. Availability is advisory; admission checks capacity and bans again.

## Wire protocol

Commands accept an optional Socket.IO acknowledgment callback. Success is `{ok:true,...result}`; failure is `{ok:false,event,reason}` and also emits the existing rejection event.

- `join_session`: `{sessionId, actor, waitForReady:true}` validates the actor without changing either world, reserves membership, emits `session_loading`, and sends protocol/terrain/manifests. A rejected join preserves existing membership. Existing registered clients may still switch with a session ID string.
- `data_ack`: acknowledge each delivered `data_version` only after its corresponding resource has been processed. Terrain and registration catalog acknowledgments must match their current versions before activation.
- `client_ready`: activates the prepared actor and emits `session_joined`. Loading reservations expire after 30 seconds and emit `session_left` with a reason. Loading clients cannot send actions or replace registration.
- `leave_session`: removes the actor and subscriptions and emits `session_left`; the socket remains available in the lobby. Repeated leave is safe.
- `resume_session`: `{resumeToken}` consumes a single-use reconnect reservation, rechecks bans, and restores the saved registration, position, orientation, and health with neutral controls. Unexpected transport loss reserves a slot for 30 seconds. Explicit disconnect, kick, leave, or session removal does not reserve a slot.

`session_joined` includes `playerId` (stable through resumption) and `resumeToken` (private to that connection). Actor IDs remain transport-bound for compatibility: use `init` for the current actor ID, and clear mesh/state caches when it changes. A resumed connection receives a fresh token. Tokens and reservations are in memory and do not survive a server restart. Clients must return to session selection after expiration. Resumption restores membership immediately; the explicit loading gate applies to fresh joins.

Session removal emits `session_closed` and returns members to the lobby. Explicit `auth.sessionId` selection remains supported for legacy clients, including the admin dashboard and Flight Lab. It skips the new loading boundary; clients should migrate to explicit admission.

## Adapter implemented in this repository

`modules/server/public/tbn-client.js` is the classic-script adapter bundled by this game server. It continues returning the Socket.IO socket:

```js
const socket = TBN.connect({ actor }); // Connects to the lobby.
socket.on('sessions_list', renderSessionChoices);
await socket.joinSession(selectedId, actor, { waitForReady: true });
// Process the incoming resources and acknowledge their data_version envelopes.
await socket.ready();
// Later:
await socket.leaveSession();
```

Handlers must be installed before joining. The adapter retains resume tokens in memory and tries resumption after transport reconnect. It does not acknowledge resources automatically: the application owns decoding/loading. Join, ready, and leave promises have 10-second acknowledgment timeouts. A command timeout is ambiguous; the server may have committed it, so use the membership events to reconcile UI state rather than retrying blindly.

## Suggested changes to the public ES-module library

Inspected https://open.thisagentmd.com/tbn.js on October 23, 2026. That library exports `createClient()` and connects to https://game.thisagentmd.com; it is a separate API from the classic-script adapter above. The public deployment was inspected but has not been modified.

1. Make `connect()` enter `lobby` after transport connection and maintain `client.sessions` from `sessions_list`. Its current connect handler waits for protocol/player ID, which the server only sends after session admission. Present a session selector or expose enough state for the game to render one.
2. Remove the `client.registered` prerequisite in `joinSession(id)`. Send `{sessionId:id,actor,waitForReady:true}` with a bounded acknowledgment and return a promise. Remove automatic `register()` calls from `protocol_info` and `init` for this path: registration is now submitted with the join request.
3. Separate `loading` and `playing` from `registration_accepted`. Currently that event sets `registered=true` and starts the 30 Hz input loop. Allow `flush()` only after `session_joined`; actor validation alone must not enable controls.
4. Add `ready()` and `leaveSession()`. Cache payloads with their session/version envelopes, acknowledge terrain/catalog only after processing, and let the renderer signal readiness after required meshes are decoded. The current `data_version` listener forwards events without acknowledging them. Retry readiness if the required catalog changes during loading.
5. Handle `session_left` and `session_closed` by stopping input, clearing world/state/mesh/hit caches, and returning to the lobby. Currently closure only calls `clearInput()`, leaving `registered` and stale world caches intact. Guard asynchronous GLB callbacks with a membership generation so previous-session assets cannot enter the new world.
6. Separate `client.playerId` from `client.actorId`. Currently `init` assigns the socket/actor ID to `playerId`; use `actorId` for finding the controlled actor and the new stable `playerId` for player identity. Retain resume tokens across transport resets, attempt `resume_session`, and return to the lobby on expiration. Clear tokens on explicit leave/disposal/closure.
7. Return structured admission errors without destroying an existing playing state. Currently every rejection calls `fail()` and sets global status to `error`; a failed switch should preserve the current world and controls. Clear held input while a switch is pending, and reset sequence/cache state after a successful switch.
8. Publish these lifecycle changes with a library version and integration tests against the new server protocol. The existing wire `PROTOCOL_VERSION=2` still describes control frames; library API/lifecycle compatibility should be versioned separately.
