# System messages

The server sends a complete `system_messages` snapshot to each admitted connection, including lobby clients and reconnects. Publishing replaces the list globally across sessions; `[]` withdraws every notice. Snapshots are validated against `tbn/schemas/system-messages.schema.json`, with an additional unique-ID check. Invalid publication leaves the current list untouched.

Embedded servers accept `createGameServer({systemMessages: [{id: 'maintenance-v1', text: 'Maintenance at 02:00 UTC.'}]})` and expose `server.publishSystemMessages(next)`. Authenticated operators can send `admin_publish_system_messages` with the array directly and receive the usual `{ok,reason?}` acknowledgment. This command does not require joining a session. Keep the same ID for repeat broadcasts and restarts; assign a new ID when editing text that dismissed clients should see again.

For durable single-instance operation, set `SYSTEM_MESSAGES_FILE` to an absolute JSON file path, or pass `systemMessagesFile` to `createGameServer`. The parent directory must exist. Existing files load at startup; missing files start with the configured list (empty by default). Each successful publication atomically replaces the file before updating memory or broadcasting. Invalid saved data fails startup. Without this option notices are held in memory only.

For multiple instances, use a shared durable operator store and propagate committed replacements to each instance's `publishSystemMessages`. The local JSON file is intended for a single writer; it does not watch external edits or synchronize instances. A Socket.IO adapter alone does not update each instance's in-memory connection snapshot.

The browser SDK 3.1.0+ owns the dismissible overlay, including with `ui:false`; generated clients must preserve it and must not add local notification networking. Text is literal, never HTML. Dismissal persistence belongs to the SDK's notification-preferences bridge and can be blocked by browser cookie/iframe policy. The server does not store dismissal preferences. Fullscreen games should fullscreen a wrapper containing the canvas so SDK HTML overlays remain visible.

Server tests cover empty/active snapshots, repeated and changed IDs, reconnects, withdrawal, HTML-looking text, invalid lists, authorization, persistence and failed saves. Browser handoff testing must additionally cover dismiss/reload/reconnect, blocked cookie storage (`system_message_storage`), dismissal events, fullscreen and disposal of overlays/bridge. Persistent dismissal has not been verified by these server tests.
