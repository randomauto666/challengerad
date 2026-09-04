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
    const swatch = colorSwatch(item.id);
    const style = swatch ? ` style="background:${swatch}"` : '';
    const cls = swatch ? 'mc-icon-fallback swatch' : `mc-icon-fallback ${primaryWorld(item)}`;
    return `<span class="${cls}"${style}>${escapeHtml(item.name.charAt(0))}</span>`;
  }

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

    function itemWorlds(item) { return item.worlds; }
    function pool() {
      return MASTER_ITEMS.filter(item => isIncluded(item)).filter(item => {
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
        : WORLD_ICON[primaryWorld(item)];
      dialog.showModal();
    }

    function spin() {
      const choices = pool();
      if (spinning || !choices.length) return;
      spinning = true;
      refresh();
      const item = choices[Math.floor(Math.random() * choices.length)];
      // Rotation bleibt beschränkt (Fix: vorher wuchs der Wert unbegrenzt und die Ziersegmente
      // liefen dadurch aus dem 45°-Raster der Farbsegmente – das erzeugte den "Ruckler"-Bug).
      currentRotation = (currentRotation % 360) + 1800 + Math.floor(Math.random() * 1440);
      wheel.style.transform = `rotate(${currentRotation}deg)`;
      window.setTimeout(() => {
        spinning = false;
        win(item);
      }, 4550);
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
     Ansichten wechseln (alles bleibt eine Website, kein Neuladen)
     ===================================================================== */
  (function initRouting() {
    const wheelView = $('#wheel-view');
    const itemsView = $('#items-view');
    if (!wheelView || !itemsView) return;

    function applyRoute() {
      const showItems = location.hash === '#items';
      wheelView.hidden = showItems;
      itemsView.hidden = !showItems;
      if (showItems) {
        window.renderItemsView?.();
        itemsView.scrollTop = 0;
        window.scrollTo(0, 0);
      }
    }
    window.addEventListener('hashchange', applyRoute);
    $('#back-to-wheel')?.addEventListener('click', event => {
      event.preventDefault();
      history.pushState('', document.title, location.pathname + location.search);
      applyRoute();
    });
    applyRoute();
  })();
})();
