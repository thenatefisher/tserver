/** Session management UI; commands explicitly target a session and do not join the admin to it. */
export function mountSessionManagement(socket) {
    const $ = id => document.getElementById(id);
    let catalog = { sessions: [], presets: [], defaults: { tickRate: 30, maxPlayers: 16 } };
    let catalogSignature = '';
    let selectedId = null, revision = 0, originalTerrain = '', rosterSignature = '', busy = false, dirty = false;
    const form = $('session-editor');
    const notice = message => { $('session-notice').textContent = message; };
    function controls(disabled) {
        busy = disabled;
        for (const button of document.querySelectorAll('#panel-sessions button')) button.disabled = disabled;
    }
    function command(event, request) {
        if (busy) return Promise.reject(new Error('Wait for the current command to finish'));
        controls(true);
        return new Promise((resolve, reject) => socket.timeout(10000).emit(event, request, (error, result) => {
            controls(false);
            if (error || !result?.ok) {
                const reason = error ? 'Command timed out. Check current server state before retrying.' : result?.reason || 'Command failed';
                notice(reason); reject(new Error(reason));
            } else resolve(result);
        }));
    }
    function terrainOptions(value) {
        const options = catalog.presets.map(preset => new Option(preset.name, preset.id));
        if (!value) options.unshift(new Option('Keep custom / procedural terrain', ''));
        $('edit-session-terrain').replaceChildren(...options);
        $('edit-session-terrain').value = value || '';
    }
    function edit(id) {
        selectedId = id; dirty = false; rosterSignature = '';
        const session = catalog.sessions.find(item => item.id === id);
        revision = session?.revision || 0; originalTerrain = session?.terrainPreset || '';
        $('edit-session-id').value = session?.id || '';
        $('edit-session-id').readOnly = Boolean(session);
        $('edit-session-name').value = session?.name || '';
        $('edit-session-limit').value = session?.maxPlayers ?? catalog.defaults.maxPlayers;
        $('edit-session-rate').value = session?.tickRate ?? catalog.defaults.tickRate;
        $('edit-session-mode').value = session?.gameMode || 'free-play';
        $('edit-session-admission').value = String(session?.acceptingPlayers ?? true);
        terrainOptions(session ? originalTerrain : (catalog.presets.find(preset => preset.id === 'flat')?.id || ''));
        $('session-editor-title').textContent = session ? `Manage ${session.name}` : 'Create session';
        $('save-session').textContent = session ? 'Save parameters' : 'Create session';
        $('delete-session').hidden = !session; $('reload-session').hidden = !session;
        $('session-members').hidden = !session;
        $('session-editor-state').textContent = session ? `Revision ${revision}` : 'New session';
        renderCatalog(); renderMembers();
    }
    function button(label, action, danger = false) {
        const node = document.createElement('button'); node.type = 'button'; node.textContent = label;
        if (danger) node.className = 'danger';
        node.disabled = busy; node.addEventListener('click', action); return node;
    }
    function renderCatalog() {
        const signature = JSON.stringify({ selectedId, busy, sessions: catalog.sessions.map(session => ({ id: session.id, name: session.name, count: session.playerCount, max: session.maxPlayers, status: session.status })) });
        if (signature === catalogSignature) return;
        catalogSignature = signature;
        const list = $('managed-session-list'); list.replaceChildren();
        for (const session of catalog.sessions) {
            const node = button(`${session.name} · ${session.playerCount}/${session.maxPlayers} · ${session.status}`, () => { notice(''); edit(session.id); });
            node.className = 'w-full text-left';
            node.setAttribute('aria-pressed', String(session.id === selectedId));
            if (session.id === selectedId) node.className += ' border-cyan-700 text-cyan-300';
            list.append(node);
        }
        if (!catalog.sessions.length) list.textContent = 'No sessions. Create a session to admit players.';
    }
    async function userAction(user, action, targetSessionId) {
        try {
            await command('admin_session_user', { sessionId: selectedId, clientId: user.id, action, targetSessionId });
            notice(`${action === 'move' ? 'Moved' : action === 'ban' ? 'Banned' : action === 'remove' ? 'Removed' : 'Kicked'} ${user.name}.`);
        } catch { /* command displays the server error */ }
    }
    function renderMembers() {
        const session = catalog.sessions.find(item => item.id === selectedId);
        if (!session) { $('session-members').hidden = true; return; }
        $('session-member-count').textContent = `${session.users.length} connected · ${session.reservations.length} reconnect reservations · ${session.maxPlayers} slots`;
        const signature = JSON.stringify({ users: session.users, reservations: session.reservations, bans: session.bans,
            destinations: catalog.sessions.map(item => ({ id: item.id, name: item.name, joinable: item.joinable })) });
        if (signature === rosterSignature) return;
        rosterSignature = signature;
        const body = $('session-users'); body.replaceChildren();
        for (const user of session.users) {
            const row = body.insertRow();
            for (const value of [`${user.name}\n${user.id}`, `${user.status}\n${user.address}`, user.browser]) {
                const cell = row.insertCell(); cell.textContent = value; cell.style.whiteSpace = 'pre-line';
            }
            const actions = row.insertCell(), wrapper = document.createElement('div'); wrapper.className = 'flex flex-wrap gap-2';
            wrapper.append(button('Remove to lobby', () => userAction(user, 'remove')), button('Kick', () => userAction(user, 'kick'), true), button('Ban IP', () => userAction(user, 'ban'), true));
            const destination = document.createElement('select'); destination.setAttribute('aria-label', `Move ${user.name} to session`);
            destination.append(new Option('Move to session…', ''));
            for (const target of catalog.sessions.filter(item => item.id !== selectedId && item.joinable)) destination.append(new Option(target.name, target.id));
            const move = button('Move', () => { if (destination.value) userAction(user, 'move', destination.value); });
            move.disabled = busy || !destination.value;
            destination.addEventListener('change', () => { move.disabled = busy || !destination.value; });
            wrapper.append(destination, move); actions.append(wrapper);
        }
        if (!session.users.length) { const cell = body.insertRow().insertCell(); cell.colSpan = 4; cell.textContent = 'No connected players in this session.'; }
        const reservations = $('session-reservations'); reservations.replaceChildren();
        for (const saved of session.reservations) {
            const row = document.createElement('div'); row.className = 'flex flex-wrap items-center justify-between gap-3';
            const text = document.createElement('span'); text.textContent = `${saved.name} · ${saved.address} · expires ${new Date(saved.expiresAt).toLocaleTimeString()}`;
            row.append(text, button('Release slot', async () => { try { await command('admin_revoke_reservation', { sessionId: selectedId, playerId: saved.playerId }); notice('Reconnect reservation released.'); } catch {} }));
            reservations.append(row);
        }
        if (!session.reservations.length) reservations.textContent = 'No reserved slots.';
        const bans = $('session-bans'); bans.replaceChildren();
        for (const address of session.bans) {
            const row = document.createElement('div'); row.className = 'flex items-center justify-between gap-3';
            const text = document.createElement('span'); text.textContent = address;
            row.append(text, button('Unban', async () => { try { await command('admin_session_unban', { sessionId: selectedId, address }); notice(`Unbanned ${address}.`); } catch {} })); bans.append(row);
        }
        if (!session.bans.length) bans.textContent = 'No banned addresses.';
    }
    form.addEventListener('input', () => { dirty = true; $('session-editor-state').textContent = 'Unsaved changes'; });
    form.addEventListener('change', () => { dirty = true; $('session-editor-state').textContent = 'Unsaved changes'; });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const parameters = { name: $('edit-session-name').value.trim(), maxPlayers: Number($('edit-session-limit').value),
            tickRate: Number($('edit-session-rate').value), gameMode: $('edit-session-mode').value,
            acceptingPlayers: $('edit-session-admission').value === 'true' };
        const terrain = $('edit-session-terrain').value;
        if (terrain && (!selectedId || terrain !== originalTerrain)) parameters.terrainPreset = terrain;
        const id = selectedId || $('edit-session-id').value;
        try {
            const result = await command(selectedId ? 'admin_update_session' : 'admin_create_session', selectedId ?
                { sessionId: selectedId, expectedRevision: revision, parameters } : { id, parameters });
            // Ack precedes the refreshed catalog: select on the next catalog snapshot.
            selectedId = result.sessionId; dirty = false; revision = result.revision ?? 0;
            pendingSelection = id;
            notice('Session saved.');
        } catch { /* keep edits available for correction */ }
    });
    let pendingSelection = null;
    $('new-session').addEventListener('click', () => { notice(''); edit(null); });
    $('reload-session').addEventListener('click', () => edit(selectedId));
    $('delete-session').addEventListener('click', () => {
        const session = catalog.sessions.find(item => item.id === selectedId); if (!session) return;
        $('delete-session-description').textContent = `Delete ${session.name} (${session.id})? Its ${session.users.length} connected players return to the lobby. World state, bans and ${session.reservations.length} reconnect reservations will be removed.`;
        $('delete-session-confirm').value = ''; $('delete-session-error').textContent = '';
        $('delete-session-dialog').showModal();
    });
    $('cancel-delete-session').addEventListener('click', () => $('delete-session-dialog').close());
    $('delete-session-form').addEventListener('submit', async event => {
        event.preventDefault();
        if ($('delete-session-confirm').value !== selectedId) { $('delete-session-error').textContent = 'The session ID does not match.'; return; }
        try {
            await command('admin_delete_session', { sessionId: selectedId, confirmId: $('delete-session-confirm').value });
            $('delete-session-dialog').close(); edit(null); notice('Session deleted. Players returned to the lobby.');
        } catch (error) { $('delete-session-error').textContent = error.message; }
    });
    socket.on('admin_sessions', snapshot => {
        catalog = snapshot;
        if (pendingSelection && catalog.sessions.some(item => item.id === pendingSelection)) { const id = pendingSelection; pendingSelection = null; edit(id); }
        else if (selectedId && !catalog.sessions.some(item => item.id === selectedId)) { edit(null); notice('The selected session was deleted.'); }
        else {
            renderCatalog(); renderMembers();
            const session = catalog.sessions.find(item => item.id === selectedId);
            if (session && session.revision !== revision) $('session-editor-state').textContent = 'Updated elsewhere · reload parameters';
            else if (!selectedId && !dirty) terrainOptions($('edit-session-terrain').value || 'flat');
        }
    });
    socket.on('disconnect', () => {
        catalog = { sessions: [], presets: [], defaults: { tickRate: 30, maxPlayers: 16 } };
        pendingSelection = null; controls(false); $('delete-session-dialog').close(); edit(null); notice('');
    });
    edit(null);
}
