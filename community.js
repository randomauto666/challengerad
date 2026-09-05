/* community.js — Discord-Login (Supabase) + Community-Inhalte + Adminpanel.
   Läuft komplett im Browser, spricht direkt mit Supabase (kein eigener Server nötig,
   die Seite bleibt eine normale statische GitHub-Pages-Seite). */
(function () {
  // Direkt konfigurierte Supabase-Zugangsdaten
  const SUPABASE_URL = 'https://tlpithftbxbgpfrhuujz.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_pl6q7KzpjIyFZ4LFuslptg_fHhdT6-V';

  const communityEls = document.querySelectorAll('.community-feature');

  if (typeof window.supabase === 'undefined') {
    communityEls.forEach(el => (el.hidden = true));
    console.error('Supabase SDK (supabase.js) ist nicht im HTML eingebunden.');
    return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const BUCKET = 'custom-images';

  let session = null;
  let profile = null; // { id, discord_name, discord_avatar, is_admin, group_id }
  let visibleEntries = []; // eigene + Gruppe + globale (kommt direkt gefiltert von Supabase/RLS)

  const KIND_LABEL = { item: 'Item', block: 'Block', mob: 'Mob' };

  /* ---------------------------------------------------------------------
     Auth-Status / Header-UI
     --------------------------------------------------------------------- */
  async function refreshSession() {
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (session) {
      const { data: profileRow } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
      profile = profileRow;
    } else {
      profile = null;
    }
    renderAuthUI();
    await loadEntries();
    await loadAnnouncements();
  }

  function renderAuthUI() {
    const loginBtn = $('#discord-login-btn');
    const loggedInBox = $('#discord-logged-in');
    const nameEl = $('#discord-username');
    const avatarEl = $('#discord-avatar');
    const adminLink = $('#open-admin');
    if (!loginBtn || !loggedInBox) return;

    if (session && profile) {
      loginBtn.hidden = true;
      loggedInBox.hidden = false;
      nameEl.textContent = profile.discord_name;
      if (avatarEl) {
        if (profile.discord_avatar) {
          avatarEl.src = profile.discord_avatar;
          avatarEl.hidden = false;
        } else {
          avatarEl.hidden = true;
        }
      }
      if (adminLink) adminLink.hidden = !profile.is_admin;
    } else {
      loginBtn.hidden = false;
      loggedInBox.hidden = true;
      if (adminLink) adminLink.hidden = true;
    }
  }

  $('#discord-login-btn')?.addEventListener('click', async () => {
    await sb.auth.signInWithOAuth({
      provider: 'discord',
      options: { redirectTo: location.origin + location.pathname },
    });
  });

  $('#discord-logout-btn')?.addEventListener('click', async () => {
    await sb.auth.signOut();
    await refreshSession();
    location.hash = '';
  });

  sb.auth.onAuthStateChange(() => refreshSession());

  /* ---------------------------------------------------------------------
     Community-Einträge in den Item-/Mob-Pool einhängen
     --------------------------------------------------------------------- */
  function communityRowToItem(row) {
    const base = {
      id: `community_${row.id}`,
      name: row.short_name ? `${row.name} (${row.short_name})` : row.name,
      en: row.name,
      worlds: row.world ? [row.world] : [],
      defaultIncluded: true,
      icon: null,
      emoji: row.kind === 'mob' ? '🧩' : '🧱',
      imageUrl: row.image_path ? sb.storage.from(BUCKET).getPublicUrl(row.image_path).data.publicUrl : null,
      isCommunity: true,
      communityMeta: row,
    };
    if (row.kind === 'mob') {
      return { ...base, mob: true, block: false, category: 'custom' };
    }
    return { ...base, mob: false, block: row.kind === 'block' };
  }

  function syncCommunityIntoPools() {
    if (typeof MASTER_ITEMS === 'undefined' || typeof MOB_ITEMS === 'undefined') return;
    for (let i = MASTER_ITEMS.length - 1; i >= 0; i--) {
      if (MASTER_ITEMS[i].isCommunity) MASTER_ITEMS.splice(i, 1);
    }
    for (let i = MOB_ITEMS.length - 1; i >= 0; i--) {
      if (MOB_ITEMS[i].isCommunity) MOB_ITEMS.splice(i, 1);
    }
    for (const row of visibleEntries) {
      const item = communityRowToItem(row);
      if (item.mob) MOB_ITEMS.push(item);
      else MASTER_ITEMS.push(item);
    }
    window.refreshWheel?.();
    if (!$('#items-view')?.hidden) window.renderItemsView?.();
    if (!$('#mobs-view')?.hidden) window.renderMobsView?.();
  }

  async function loadEntries() {
    if (!session) {
      visibleEntries = [];
      syncCommunityIntoPools();
      renderMyEntries();
      return;
    }
    const { data, error } = await sb.from('custom_entries').select('*').order('created_at', { ascending: false });
    if (error) {
      console.error('Community-Einträge konnten nicht geladen werden:', error);
      return;
    }
    visibleEntries = data || [];
    syncCommunityIntoPools();
    renderMyEntries();
  }

  /* ---------------------------------------------------------------------
     "Eigenes hinzufügen"-Formular
     --------------------------------------------------------------------- */
  const addForm = $('#add-content-form');
  addForm?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!session) return;
    const statusEl = $('#add-content-status');
    const submitBtn = addForm.querySelector('button[type="submit"]');
    const kind = $('#add-kind').value;
    const name = $('#add-name').value.trim();
    const shortName = $('#add-short-name').value.trim();
    const world = $('#add-world').value;
    const fileInput = $('#add-image');
    const file = fileInput.files[0];

    if (!name) {
      statusEl.textContent = 'Bitte einen Namen eingeben.';
      return;
    }
    submitBtn.disabled = true;
    statusEl.textContent = 'Wird gespeichert …';

    try {
      let imagePath = null;
      if (file) {
        const ext = file.name.split('.').pop();
        imagePath = `${session.user.id}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await sb.storage.from(BUCKET).upload(imagePath, file, { upsert: false });
        if (uploadError) throw uploadError;
      }
      const { error: insertError } = await sb.from('custom_entries').insert({
        user_id: session.user.id,
        kind,
        name,
        short_name: shortName || null,
        image_path: imagePath,
        world,
        is_global: false,
      });
      if (insertError) throw insertError;

      statusEl.textContent = 'Gespeichert! Es taucht jetzt in deinem Rad auf.';
      addForm.reset();
      await loadEntries();
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Fehler beim Speichern: ' + (err.message || err);
    } finally {
      submitBtn.disabled = false;
    }
  });

  function renderMyEntries() {
    const listEl = $('#my-entries-list');
    if (!listEl) return;
    if (!session) {
      listEl.innerHTML = '<p class="empty-history">Melde dich mit Discord an, um eigene Inhalte zu sehen.</p>';
      return;
    }
    const mine = visibleEntries.filter(e => e.user_id === session.user.id);
    const others = visibleEntries.filter(e => e.user_id !== session.user.id);
    let html = '';
    if (mine.length) {
      html += '<h3 class="letter-heading">Meine Einträge</h3>';
      html += mine.map(entryRowHtml).join('');
    }
    if (others.length) {
      html += '<h3 class="letter-heading">Sichtbar durch Gruppe/global</h3>';
      html += others.map(e => entryRowHtml(e, false)).join('');
    }
    listEl.innerHTML = html || '<p class="empty-history">Noch keine eigenen Inhalte. Füge oben dein erstes hinzu!</p>';
  }

  function entryRowHtml(row, deletable = true) {
    const img = row.image_path
      ? `<img class="mc-icon" width="28" height="28" src="${sb.storage.from(BUCKET).getPublicUrl(row.image_path).data.publicUrl}" alt="" />`
      : `<span class="mc-icon-fallback emoji">${row.kind === 'mob' ? '🧩' : '🧱'}</span>`;
    return `
      <div class="item-row" data-entry-id="${row.id}">
        <span class="item-icon">${img}</span>
        <span class="item-text">
          <span class="item-name">${escapeHtml(row.name)}${row.short_name ? ` (${escapeHtml(row.short_name)})` : ''}</span>
          <span class="item-meta">${KIND_LABEL[row.kind] || row.kind}${row.is_global ? ' · Global' : ''}</span>
        </span>
        ${deletable ? `<button class="text-button delete-entry-btn" data-entry-id="${row.id}" type="button">Löschen</button>` : ''}
      </div>`;
  }

  $('#my-entries-list')?.addEventListener('click', async event => {
    const btn = event.target.closest('.delete-entry-btn');
    if (!btn) return;
    if (!confirm('Diesen Eintrag wirklich löschen?')) return;
    const { error } = await sb.from('custom_entries').delete().eq('id', btn.dataset.entryId);
    if (error) {
      alert('Löschen fehlgeschlagen: ' + error.message);
      return;
    }
    await loadEntries();
  });

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------------------------------------------------------------------
     ANKÜNDIGUNGEN (Banner auf der Startseite/Rad)
     --------------------------------------------------------------------- */
  async function loadAnnouncements() {
    const { data, error } = await sb
      .from('announcements')
      .select('*')
      .eq('active', true)
      .order('created_at', { ascending: false });
    if (error) return;
    renderAnnouncementBanner(data || []);
  }

  function renderAnnouncementBanner(list) {
    const container = $('#announcement-banner');
    if (!container) return;
    if (!list.length) {
      container.hidden = true;
      container.innerHTML = '';
      return;
    }
    const dismissed = JSON.parse(sessionStorage.getItem('dismissedAnnouncements') || '[]');
    const toShow = list.filter(a => !dismissed.includes(a.id));
    if (!toShow.length) {
      container.hidden = true;
      return;
    }
    container.hidden = false;
    container.innerHTML = toShow
      .map(
        a => `
      <div class="announcement" data-id="${a.id}">
        <strong>${escapeHtml(a.title)}</strong>
        <p>${escapeHtml(a.body)}</p>
        <button class="announcement-close" data-id="${a.id}" type="button" aria-label="Ankündigung schließen">×</button>
      </div>`
      )
      .join('');
  }

  $('#announcement-banner')?.addEventListener('click', event => {
    const btn = event.target.closest('.announcement-close');
    if (!btn) return;
    const dismissed = JSON.parse(sessionStorage.getItem('dismissedAnnouncements') || '[]');
    dismissed.push(btn.dataset.id);
    sessionStorage.setItem('dismissedAnnouncements', JSON.stringify(dismissed));
    btn.closest('.announcement')?.remove();
    if (!$('#announcement-banner').children.length) $('#announcement-banner').hidden = true;
  });

  /* =====================================================================
     ADMINPANEL
     ===================================================================== */
  let allProfiles = [];
  let allEntries = [];
  let allAnnouncements = [];
  const selectedForMerge = new Set();

  async function renderAdminPanel() {
    const root = $('#admin-view');
    if (!root) return;
    if (!session || !profile?.is_admin) {
      $('#admin-no-access').hidden = false;
      $('#admin-content').hidden = true;
      return;
    }
    $('#admin-no-access').hidden = true;
    $('#admin-content').hidden = false;

    const [{ data: profilesData }, { data: entriesData }, { data: announcementsData }] = await Promise.all([
      sb.from('profiles').select('*').order('created_at', { ascending: true }),
      sb.from('custom_entries').select('*').order('created_at', { ascending: false }),
      sb.from('announcements').select('*').order('created_at', { ascending: false }),
    ]);
    allProfiles = profilesData || [];
    allEntries = entriesData || [];
    allAnnouncements = announcementsData || [];
    renderAdminUsers();
    renderAdminEntries();
    renderAdminAnnouncements();
  }
  window.renderAdminView = renderAdminPanel;

  function groupLabel(groupId) {
    if (!groupId) return '–';
    const members = allProfiles.filter(p => p.group_id === groupId);
    return `Gruppe (${members.length}): ${members.map(m => m.discord_name).join(', ')}`;
  }

  function renderAdminUsers() {
    const listEl = $('#admin-users-list');
    if (!listEl) return;
    listEl.innerHTML = allProfiles
      .map(
        p => `
      <div class="item-row" data-user-id="${p.id}">
        <span class="item-icon">
          <input type="checkbox" class="admin-merge-check" data-user-id="${p.id}" ${selectedForMerge.has(p.id) ? 'checked' : ''} />
        </span>
        <span class="item-text">
          <span class="item-name">${escapeHtml(p.discord_name)}${p.is_admin ? ' 👑' : ''}</span>
          <span class="item-meta">Seit ${new Date(p.created_at).toLocaleDateString('de-DE')} · ${groupLabel(p.group_id)}</span>
        </span>
        <div class="admin-user-actions">
          ${p.group_id ? `<button class="text-button admin-separate-btn" data-user-id="${p.id}" type="button">Trennen</button>` : ''}
          <button class="text-button admin-toggle-admin-btn" data-user-id="${p.id}" data-make="${!p.is_admin}" type="button">${p.is_admin ? 'Admin entziehen' : 'Zum Admin machen'}</button>
        </div>
      </div>`
      )
      .join('');
  }

  $('#admin-users-list')?.addEventListener('change', event => {
    const check = event.target.closest('.admin-merge-check');
    if (!check) return;
    if (check.checked) selectedForMerge.add(check.dataset.userId);
    else selectedForMerge.delete(check.dataset.userId);
  });

  $('#admin-users-list')?.addEventListener('click', async event => {
    const sepBtn = event.target.closest('.admin-separate-btn');
    const adminBtn = event.target.closest('.admin-toggle-admin-btn');
    if (sepBtn) {
      const { error } = await sb.rpc('admin_separate_user', { target_id: sepBtn.dataset.userId });
      if (error) alert('Fehler: ' + error.message);
      await renderAdminPanel();
    } else if (adminBtn) {
      const makeAdmin = adminBtn.dataset.make === 'true';
      const { error } = await sb.rpc('admin_set_admin', { target_id: adminBtn.dataset.userId, make_admin: makeAdmin });
      if (error) alert('Fehler: ' + error.message);
      await renderAdminPanel();
    }
  });

  $('#admin-merge-btn')?.addEventListener('click', async () => {
    if (selectedForMerge.size < 2) {
      alert('Bitte mindestens 2 User auswählen (Häkchen links in der Liste).');
      return;
    }
    const name = prompt('Optionaler Gruppenname (kann leer bleiben):', '') || null;
    const { error } = await sb.rpc('admin_merge_users', { target_ids: [...selectedForMerge], new_group_name: name });
    if (error) {
      alert('Fehler: ' + error.message);
      return;
    }
    selectedForMerge.clear();
    await renderAdminPanel();
  });

  function renderAdminEntries() {
    const listEl = $('#admin-entries-list');
    if (!listEl) return;
    listEl.innerHTML = allEntries
      .map(row => {
        const owner = allProfiles.find(p => p.id === row.user_id);
        const img = row.image_path
          ? `<img class="mc-icon" width="28" height="28" src="${sb.storage.from(BUCKET).getPublicUrl(row.image_path).data.publicUrl}" alt="" />`
          : `<span class="mc-icon-fallback emoji">${row.kind === 'mob' ? '🧩' : '🧱'}</span>`;
        return `
        <div class="item-row" data-entry-id="${row.id}">
          <span class="item-icon">${img}</span>
          <span class="item-text">
            <span class="item-name">${escapeHtml(row.name)}${row.short_name ? ` (${escapeHtml(row.short_name)})` : ''}</span>
            <span class="item-meta">${KIND_LABEL[row.kind] || row.kind} · von ${owner ? escapeHtml(owner.discord_name) : 'unbekannt'}${row.is_global ? ' · GLOBAL' : ''}</span>
          </span>
          <div class="admin-user-actions">
            ${!row.is_global ? `<button class="text-button admin-make-global-btn" data-entry-id="${row.id}" type="button">Global schalten</button>` : ''}
            <button class="text-button admin-delete-entry-btn" data-entry-id="${row.id}" type="button">Löschen</button>
          </div>
        </div>`;
      })
      .join('') || '<p class="empty-history">Noch keine Community-Einträge vorhanden.</p>';
  }

  $('#admin-entries-list')?.addEventListener('click', async event => {
    const delBtn = event.target.closest('.admin-delete-entry-btn');
    const globalBtn = event.target.closest('.admin-make-global-btn');
    if (delBtn) {
      if (!confirm('Eintrag wirklich löschen?')) return;
      const { error } = await sb.from('custom_entries').delete().eq('id', delBtn.dataset.entryId);
      if (error) alert('Fehler: ' + error.message);
      await renderAdminPanel();
      await loadEntries();
    } else if (globalBtn) {
      const { error } = await sb.from('custom_entries').update({ is_global: true }).eq('id', globalBtn.dataset.entryId);
      if (error) alert('Fehler: ' + error.message);
      await renderAdminPanel();
      await loadEntries();
    }
  });

  /* ---- Admin: neues GLOBALES Item/Block/Mob für ALLE hinzufügen ---- */
  const adminAddForm = $('#admin-add-global-form');
  adminAddForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const statusEl = $('#admin-add-global-status');
    const kind = $('#admin-add-kind').value;
    const name = $('#admin-add-name').value.trim();
    const shortName = $('#admin-add-short-name').value.trim();
    const world = $('#admin-add-world').value;
    const file = $('#admin-add-image').files[0];
    if (!name) {
      statusEl.textContent = 'Bitte einen Namen eingeben.';
      return;
    }
    statusEl.textContent = 'Wird gespeichert …';
    try {
      let imagePath = null;
      if (file) {
        const ext = file.name.split('.').pop();
        imagePath = `${session.user.id}/${crypto.randomUUID()}.${ext}`;
        const { error: uploadError } = await sb.storage.from(BUCKET).upload(imagePath, file, { upsert: false });
        if (uploadError) throw uploadError;
      }
      const { error } = await sb.from('custom_entries').insert({
        user_id: session.user.id,
        kind,
        name,
        short_name: shortName || null,
        image_path: imagePath,
        world,
        is_global: true,
      });
      if (error) throw error;
      statusEl.textContent = 'Global hinzugefügt – ab sofort für alle sichtbar!';
      adminAddForm.reset();
      await renderAdminPanel();
      await loadEntries();
    } catch (err) {
      statusEl.textContent = 'Fehler: ' + (err.message || err);
    }
  });

  /* ---- Admin: Ankündigungen verwalten ---- */
  function renderAdminAnnouncements() {
    const listEl = $('#admin-announcements-list');
    if (!listEl) return;
    listEl.innerHTML =
      allAnnouncements
        .map(
          a => `
      <div class="item-row" data-announcement-id="${a.id}">
        <span class="item-text">
          <span class="item-name">${escapeHtml(a.title)} ${a.active ? '' : '(inaktiv)'}</span>
          <span class="item-meta">${escapeHtml(a.body)}</span>
        </span>
        <div class="admin-user-actions">
          <button class="text-button admin-toggle-announcement-btn" data-id="${a.id}" data-make="${!a.active}" type="button">${a.active ? 'Deaktivieren' : 'Aktivieren'}</button>
          <button class="text-button admin-delete-announcement-btn" data-id="${a.id}" type="button">Löschen</button>
        </div>
      </div>`
        )
        .join('') || '<p class="empty-history">Noch keine Ankündigungen.</p>';
  }

  $('#admin-announcements-list')?.addEventListener('click', async event => {
    const toggleBtn = event.target.closest('.admin-toggle-announcement-btn');
    const delBtn = event.target.closest('.admin-delete-announcement-btn');
    if (toggleBtn) {
      const { error } = await sb.from('announcements').update({ active: toggleBtn.dataset.make === 'true' }).eq('id', toggleBtn.dataset.id);
      if (error) alert('Fehler: ' + error.message);
      await renderAdminPanel();
      await loadAnnouncements();
    } else if (delBtn) {
      if (!confirm('Ankündigung wirklich löschen?')) return;
      const { error } = await sb.from('announcements').delete().eq('id', delBtn.dataset.id);
      if (error) alert('Fehler: ' + error.message);
      await renderAdminPanel();
      await loadAnnouncements();
    }
  });

  const announcementForm = $('#admin-add-announcement-form');
  announcementForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const title = $('#admin-announcement-title').value.trim();
    const body = $('#admin-announcement-body').value.trim();
    if (!title || !body) return;
    const { error } = await sb.from('announcements').insert({ title, body, created_by: session.user.id });
    if (error) {
      alert('Fehler: ' + error.message);
      return;
    }
    announcementForm.reset();
    await renderAdminPanel();
    await loadAnnouncements();
  });

  /* ---------------------------------------------------------------------
     Start
     --------------------------------------------------------------------- */
  communityEls.forEach(el => (el.hidden = false));
  refreshSession();
})();
