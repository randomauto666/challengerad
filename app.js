(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  /* ---------- Shared state ---------- */
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('rad-der-challenges') : null;
  const saved = JSON.parse(localStorage.getItem('rdc-state') || '{}');
  const state = {
    worlds: saved.worlds || [],
    hideDrawn: Boolean(saved.hideDrawn),
    drawn: saved.drawn || [],
    history: saved.history || [],
    itemOverrides: saved.itemOverrides || {},
    hotkey: saved.hotkey || 'O',
    overlayVisible: saved.overlayVisible !== false,
    lastWin: saved.lastWin || null,
  };

  function persist() {
    localStorage.setItem('rdc-state', JSON.stringify(state));
    channel?.postMessage({ type: 'state', state });
  }

  function isIncluded(item) {
    const override = state.itemOverrides[item.id];
    return override === undefined ? item.defaultIncluded : override;
  }

  function setIncluded(item, value) {
    if (value === item.defaultIncluded) delete state.itemOverrides[item.id];
    else state.itemOverrides[item.id] = value;
  }

  const WORLD_LABEL = { overworld: 'Oberwelt', nether: 'Nether', end: 'End', misc: 'Sonstige' };
  const WORLD_ICON = { overworld: '◆', nether: '✦', end: '✧', misc: '●' };
  const COLOR_HEX = {
    white: '#f2f0e6', orange: '#e5811c', magenta: '#bd44b3', light_blue: '#3ab3da', yellow: '#f0c81e',
    lime: '#70b81a', pink: '#eb96b3', gray: '#3e4447', light_gray: '#8f9294', cyan: '#158991',
    purple: '#7b2fbe', blue: '#33399e', brown: '#66512b', green: '#556e1c', red: '#a02722', black: '#191a1c',
  };

  function primaryWorld(item) { return item.worlds[0] || 'misc'; }
  function colorSwatch(id) {
    const prefix = Object.keys(COLOR_HEX).find(c => id === `${c}_bed` || id === `${c}_banner` || id.startsWith(`${c}_`));
    return prefix ? COLOR_HEX[prefix] : null;
  }
  function escapeHtml(text) { const el = document.createElement('span'); el.textContent = text; return el.innerHTML; }

  function iconMarkup(item, size) {
    if (item.icon) {
      return `<img class="mc-icon" width="${size}" height="${size}" loading="lazy" src="icons/${item.icon}" alt="" />`;
    }
    // Mobs haben keine Bilddatei, sondern ein passendes Emoji als leichtgewichtiges Icon.
    if (item.emoji) {
      return `<span class="mc-icon-fallback emoji" style="font-size:${Math.round(size * 0.65)}px">${item.emoji}</span>`;
    }
    const swatch = colorSwatch(item.id);
    const style = swatch ? ` style="background:${swatch}"` : '';
    const cls = swatch ? 'mc-icon-fallback swatch' : `mc-icon-fallback ${primaryWorld(item)}`;
    return `<span class="${cls}"${style}>${escapeHtml(item.name.charAt(0))}</span>`;
  }

  /* Gemeinsamer Ziehpool: Items/Blöcke UND Mobs zusammen, damit das Rad auch
     "Finde/Zähme/Besiege dieses Mob"-Challenges ziehen kann. */
  const ALL_POOL_ITEMS = (typeof MOB_ITEMS !== 'undefined') ? MASTER_ITEMS.concat(MOB_ITEMS) : MASTER_ITEMS;

  /* =====================================================================
     RAD (Wheel)
     ===================================================================== */
  (function initWheel() {
    const wheel = $('.wheel-slices');
    const spinButton = $('#spin-button');
    const status = $('#pool-status');
    const dialog = $('#win-dialog');
    const filters = $$('#world-filters input');
    const hideDrawn = $('#hide-drawn');
    const historyList = $('#history-list');
    if (!spinButton) return;

    let spinning = false;
    let currentRotation = 0;
    const SPIN_DURATION_MS = 4550; // an die 4.5s CSS-Transition der .wheel-slices angeglichen

    /* ---------- Drehsound (Web Audio API, keine externe Audiodatei nötig) ---------- */
    let audioCtx = null;
    function getAudioCtx() {
      if (!audioCtx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    }
    function playSpinSound() {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const duration = SPIN_DURATION_MS / 1000;
      const now = ctx.currentTime;

      // Whirr: gefilterter Rauschton, der abklingt wie ein sich verlangsamendes Rad.
      const bufferSize = ctx.sampleRate * duration;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 1.1;
      filter.frequency.setValueAtTime(1400, now);
      filter.frequency.exponentialRampToValueAtTime(220, now + duration);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.15);
      gain.gain.setValueAtTime(0.22, now + duration - 1.6);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      noise.connect(filter).connect(gain).connect(ctx.destination);
      noise.start(now);
      noise.stop(now + duration);

      // Klick-Ticks: simulieren die Rasterklicken eines Glücksrads, werden seltener.
      const tickCount = 26;
      for (let i = 0; i < tickCount; i++) {
        const t = duration * (1 - Math.pow(1 - i / tickCount, 2.1));
        const osc = ctx.createOscillator();
        const tickGain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 900;
        tickGain.gain.setValueAtTime(0.001, now + t);
        tickGain.gain.exponentialRampToValueAtTime(0.16, now + t + 0.005);
        tickGain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.04);
        osc.connect(tickGain).connect(ctx.destination);
        osc.start(now + t);
        osc.stop(now + t + 0.05);
      }
    }

    function itemWorlds(item) { return item.worlds; }
    function pool() {
      return ALL_POOL_ITEMS.filter(item => isIncluded(item)).filter(item => {
        const correctWorld = !state.worlds.length || itemWorlds(item).some(w => state.worlds.includes(w));
        return correctWorld && (!state.hideDrawn || !state.drawn.includes(item.id));
      });
    }

    function refresh() {
      filters.forEach(input => (input.checked = state.worlds.includes(input.value)));
      hideDrawn.checked = state.hideDrawn;
      const available = pool().length;
      status.textContent = available ? `${available} mögliche Items im Rad` : 'Keine Items übrig – zurücksetzen oder Filter ändern.';
      spinButton.disabled = spinning || !available;
      historyList.innerHTML = state.history.length
        ? state.history.slice(0, 12).map(item => `<li><span class="tiny-icon">◆</span>${escapeHtml(item.name)}</li>`).join('')
        : '<li class="empty-history">Noch keine Challenge gezogen.</li>';
    }
    window.refreshWheel = refresh;

    function win(item) {
      state.lastWin = item;
      state.drawn = [...new Set([item.id, ...state.drawn])];
      state.history = [item, ...state.history.filter(old => old.id !== item.id)].slice(0, 50);
      persist();
      refresh();
      $('#win-name').textContent = item.name;
      $('#win-world').textContent = WORLD_LABEL[primaryWorld(item)];
      $('#win-icon').innerHTML = item.icon
        ? `<img src="icons/${item.icon}" alt="" width="64" height="64" />`
        : item.emoji || WORLD_ICON[primaryWorld(item)];
      dialog.showModal();
    }

    function spin() {
      const choices = pool();
      if (spinning || !choices.length) return;
      spinning = true;
      refresh();
      const item = choices[Math.floor(Math.random() * choices.length)];
      // Fixe Drehung: Das Rad dreht sich bei jedem Spin exakt gleich (immer 7 volle
      // Umdrehungen in dieselbe Richtung, gleiche Dauer/Kurve aus dem CSS) – nur das
      // gewonnene Item ist zufällig, nicht die Optik der Drehung selbst.
      // Rotation bleibt außerdem im 360°-Raster beschränkt (Fix: vorher wuchs der Wert
      // unbegrenzt und die Ziersegmente liefen dadurch aus dem 45°-Raster der
      // Farbsegmente – das erzeugte den "Ruckler"-Bug).
      const FULL_TURNS = 7;
      currentRotation = (currentRotation % 360) + FULL_TURNS * 360;
      wheel.style.transform = `rotate(${currentRotation}deg)`;
      playSpinSound();
      window.setTimeout(() => {
        spinning = false;
        win(item);
      }, SPIN_DURATION_MS);
    }
    window.spinWheel = spin;

    filters.forEach(input =>
      input.addEventListener('change', () => {
        state.worlds = filters.filter(box => box.checked).map(box => box.value);
        persist();
        refresh();
      })
    );
    hideDrawn.addEventListener('change', () => {
      state.hideDrawn = hideDrawn.checked;
      persist();
      refresh();
    });
    $('#clear-history').addEventListener('click', () => {
      state.drawn = [];
      state.history = [];
      persist();
      refresh();
    });
    spinButton.addEventListener('click', spin);
    $('#close-dialog').addEventListener('click', () => dialog.close());
    $('#spin-again').addEventListener('click', () => {
      dialog.close();
      spin();
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
    document.addEventListener('keydown', event => {
      if (event.target.matches('input, textarea, select')) return;
      if (event.key.toUpperCase() === state.hotkey.toUpperCase()) {
        state.overlayVisible = !state.overlayVisible;
        persist();
      }
      if (event.key === ' ' && !dialog.open && !$('#items-view').matches(':not([hidden])')) {
        event.preventDefault();
        spin();
      }
    });
    window.addEventListener('storage', event => {
      if (event.key === 'rdc-state') {
        Object.assign(state, JSON.parse(event.newValue || '{}'));
        refresh();
      }
    });

    refresh();
  })();

  /* =====================================================================
     ITEMLISTE (Full item browser)
     ===================================================================== */
  (function initItemsView() {
    const listEl = $('#items-list');
    if (!listEl) return;
    const searchInput = $('#items-search');
    const typeSelect = $('#filter-type');
    const worldSelect = $('#filter-world');
    const stateSelect = $('#filter-state');
    const countEl = $('#items-count');
    const letterNav = $('#letter-nav');
    const resetButton = $('#reset-items');

    const sorted = [...MASTER_ITEMS].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const normCache = new Map(sorted.map(item => [item.id, `${item.name} ${item.en}`.toLowerCase()]));

    function matches(item) {
      const q = searchInput.value.trim().toLowerCase();
      if (q && !normCache.get(item.id).includes(q)) return false;
      const type = typeSelect.value;
      if (type === 'block' && !item.block) return false;
      if (type === 'item' && item.block) return false;
      const world = worldSelect.value;
      if (world === 'misc') {
        if (item.worlds.length) return false;
      } else if (world !== 'all' && !item.worlds.includes(world)) {
        return false;
      }
      const st = stateSelect.value;
      if (st === 'on' && !isIncluded(item)) return false;
      if (st === 'off' && isIncluded(item)) return false;
      return true;
    }

    function render() {
      const results = sorted.filter(matches);
      const total = MASTER_ITEMS.length;
      const activeCount = MASTER_ITEMS.filter(isIncluded).length;
      countEl.textContent = `${results.length} von ${total} Einträgen angezeigt · ${activeCount} aktuell ziehbar`;

      const letters = [];
      let html = '';
      let currentLetter = '';
      for (const item of results) {
        const letter = /[A-ZÄÖÜ]/i.test(item.name.charAt(0)) ? item.name.charAt(0).toUpperCase() : '#';
        if (letter !== currentLetter) {
          currentLetter = letter;
          letters.push(letter);
          html += `<h3 class="letter-heading" id="letter-${letter}">${letter}</h3>`;
        }
        const on = isIncluded(item);
        html += `
          <div class="item-row" data-id="${item.id}">
            <span class="item-icon">${iconMarkup(item, 28)}</span>
            <span class="item-text">
              <span class="item-name">${escapeHtml(item.name)}</span>
              <span class="item-meta">${item.block ? 'Block' : 'Item'} · ${WORLD_LABEL[primaryWorld(item)]}</span>
            </span>
            <label class="switch small" title="${on ? 'Ziehbar – klicken zum Ausschließen' : 'Ausgeschlossen – klicken zum Aktivieren'}">
              <input type="checkbox" class="item-toggle" data-id="${item.id}" ${on ? 'checked' : ''} />
              <span class="switch-track"></span>
            </label>
          </div>`;
      }
      listEl.innerHTML = html || '<p class="empty-history">Keine Treffer für diese Suche/Filter.</p>';
      // Eigene data-Navigation statt echter #Hash-Links: die Ansicht Rad/Itemliste wird
      // selbst über location.hash gesteuert, ein Sprung-Link würde diesen sonst überschreiben.
      letterNav.innerHTML = letters.map(l => `<a href="#" data-letter="${l}">${l}</a>`).join('');
    }

    letterNav.addEventListener('click', event => {
      const link = event.target.closest('a[data-letter]');
      if (!link) return;
      event.preventDefault();
      document.getElementById(`letter-${link.dataset.letter}`)?.scrollIntoView({ block: 'start' });
    });

    listEl.addEventListener('change', event => {
      const target = event.target;
      if (!target.matches('.item-toggle')) return;
      const item = MASTER_ITEMS.find(i => i.id === target.dataset.id);
      if (!item) return;
      setIncluded(item, target.checked);
      persist();
      const row = target.closest('.item-row');
      row.querySelector('.switch').title = target.checked ? 'Ziehbar – klicken zum Ausschließen' : 'Ausgeschlossen – klicken zum Aktivieren';
      countEl.textContent = `${listEl.querySelectorAll('.item-row').length} von ${MASTER_ITEMS.length} Einträgen angezeigt · ${MASTER_ITEMS.filter(isIncluded).length} aktuell ziehbar`;
      window.refreshWheel?.();
    });

    let debounceTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(render, 120);
    });
    [typeSelect, worldSelect, stateSelect].forEach(select => select.addEventListener('change', render));
    resetButton.addEventListener('click', () => {
      state.itemOverrides = {};
      persist();
      render();
      window.refreshWheel?.();
    });

    window.renderItemsView = render;
  })();

  /* =====================================================================
     MOBLISTE (funktioniert 1:1 wie die Itemliste, nur für Mobs)
     ===================================================================== */
  (function initMobsView() {
    const listEl = $('#mobs-list');
    if (!listEl || typeof MOB_ITEMS === 'undefined') return;
    const searchInput = $('#mobs-search');
    const catSelect = $('#mob-filter-category');
    const worldSelect = $('#mob-filter-world');
    const stateSelect = $('#mob-filter-state');
    const countEl = $('#mobs-count');
    const letterNav = $('#mob-letter-nav');
    const resetButton = $('#reset-mobs');

    const sorted = [...MOB_ITEMS].sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const normCache = new Map(sorted.map(item => [item.id, `${item.name} ${item.en}`.toLowerCase()]));

    function matches(item) {
      const q = searchInput.value.trim().toLowerCase();
      if (q && !normCache.get(item.id).includes(q)) return false;
      const cat = catSelect.value;
      if (cat !== 'all' && item.category !== cat) return false;
      const world = worldSelect.value;
      if (world === 'misc') {
        if (item.worlds.length) return false;
      } else if (world !== 'all' && !item.worlds.includes(world)) {
        return false;
      }
      const st = stateSelect.value;
      if (st === 'on' && !isIncluded(item)) return false;
      if (st === 'off' && isIncluded(item)) return false;
      return true;
    }

    function render() {
      const results = sorted.filter(matches);
      const total = MOB_ITEMS.length;
      const activeCount = MOB_ITEMS.filter(isIncluded).length;
      countEl.textContent = `${results.length} von ${total} Mobs angezeigt · ${activeCount} aktuell ziehbar`;

      const letters = [];
      let html = '';
      let currentLetter = '';
      for (const item of results) {
        const letter = /[A-ZÄÖÜ]/i.test(item.name.charAt(0)) ? item.name.charAt(0).toUpperCase() : '#';
        if (letter !== currentLetter) {
          currentLetter = letter;
          letters.push(letter);
          html += `<h3 class="letter-heading" id="mob-letter-${letter}">${letter}</h3>`;
        }
        const on = isIncluded(item);
        html += `
          <div class="item-row" data-id="${item.id}">
            <span class="item-icon">${iconMarkup(item, 28)}</span>
            <span class="item-text">
              <span class="item-name">${escapeHtml(item.name)}</span>
              <span class="item-meta">${item.category === 'custom' ? 'Custom-Mob' : 'Vanilla-Mob'} · ${WORLD_LABEL[primaryWorld(item)]}</span>
            </span>
            <label class="switch small" title="${on ? 'Ziehbar – klicken zum Ausschließen' : 'Ausgeschlossen – klicken zum Aktivieren'}">
              <input type="checkbox" class="item-toggle" data-id="${item.id}" ${on ? 'checked' : ''} />
              <span class="switch-track"></span>
            </label>
          </div>`;
      }
      listEl.innerHTML = html || '<p class="empty-history">Keine Treffer für diese Suche/Filter.</p>';
      letterNav.innerHTML = letters.map(l => `<a href="#" data-letter="${l}">${l}</a>`).join('');
    }

    letterNav.addEventListener('click', event => {
      const link = event.target.closest('a[data-letter]');
      if (!link) return;
      event.preventDefault();
      document.getElementById(`mob-letter-${link.dataset.letter}`)?.scrollIntoView({ block: 'start' });
    });

    listEl.addEventListener('change', event => {
      const target = event.target;
      if (!target.matches('.item-toggle')) return;
      const item = MOB_ITEMS.find(i => i.id === target.dataset.id);
      if (!item) return;
      setIncluded(item, target.checked);
      persist();
      const row = target.closest('.item-row');
      row.querySelector('.switch').title = target.checked ? 'Ziehbar – klicken zum Ausschließen' : 'Ausgeschlossen – klicken zum Aktivieren';
      countEl.textContent = `${listEl.querySelectorAll('.item-row').length} von ${MOB_ITEMS.length} Mobs angezeigt · ${MOB_ITEMS.filter(isIncluded).length} aktuell ziehbar`;
      window.refreshWheel?.();
    });

    let debounceTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(render, 120);
    });
    [catSelect, worldSelect, stateSelect].forEach(select => select.addEventListener('change', render));
    resetButton.addEventListener('click', () => {
      MOB_ITEMS.forEach(item => delete state.itemOverrides[item.id]);
      persist();
      render();
      window.refreshWheel?.();
    });

    window.renderMobsView = render;
  })();

  /* =====================================================================
     Ansichten wechseln (alles bleibt eine Website, kein Neuladen)
     ===================================================================== */
  (function initRouting() {
    const wheelView = $('#wheel-view');
    const itemsView = $('#items-view');
    const mobsView = $('#mobs-view');
    if (!wheelView || !itemsView) return;

    function applyRoute() {
      const route = location.hash === '#mobs' ? 'mobs' : location.hash === '#items' ? 'items' : 'wheel';
      wheelView.hidden = route !== 'wheel';
      itemsView.hidden = route !== 'items';
      if (mobsView) mobsView.hidden = route !== 'mobs';
      if (route === 'items') {
        window.renderItemsView?.();
        itemsView.scrollTop = 0;
        window.scrollTo(0, 0);
      } else if (route === 'mobs') {
        window.renderMobsView?.();
        mobsView.scrollTop = 0;
        window.scrollTo(0, 0);
      }
    }
    window.addEventListener('hashchange', applyRoute);
    $$('.back-to-wheel-link').forEach(link =>
      link.addEventListener('click', event => {
        event.preventDefault();
        history.pushState('', document.title, location.pathname + location.search);
        applyRoute();
      })
    );
    applyRoute();
  })();
})();
