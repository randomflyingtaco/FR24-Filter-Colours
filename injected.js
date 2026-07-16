(function () {
  'use strict';

  console.log('[FR24FC] injected.js loaded');

  // Save the native fetch before any patch so the refresh handler can always reach the real API.
  const _nativeFetch = window.fetch;

  // --- Config (written by content.js via dataset) ---
  // Returns filterId → hex colour map for all currently assigned filters

  function getFilterColorMap() {
    try {
      const groups      = JSON.parse(document.documentElement.dataset.fr24groups      || '[]');
      const assignments = JSON.parse(document.documentElement.dataset.fr24assignments || '{}');
      const groupMeta   = Object.fromEntries(groups.map(g => [g.id, { color: g.color, name: g.name }]));
      const result = {};
      for (const [filterId, groupId] of Object.entries(assignments)) {
        if (groupMeta[groupId]) result[filterId] = groupMeta[groupId];
      }
      return result;
    } catch (e) { return {}; }
  }

  // --- Reg → airport map (fetched by content.js from MapTrack server) ---

  let _regMap = null;
  function getRegMap() {
    if (_regMap) return _regMap;
    try {
      const data = JSON.parse(document.documentElement.dataset.fr24regmap || '{}');
      _regMap = data.regs || {};
    } catch (_) { _regMap = {}; }
    return _regMap;
  }

  function getAccessToken() {
    try {
      return document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
        ._s.get('dispatcher').$state.dispatcher.accessToken;
    } catch (_) { return null; }
  }

  function onRegMapChanged(newData) {
    _regMap = null; // invalidate cache so getRegMap() re-reads fresh data
    scheduleRedraw();
  }

  // --- Filter loading (read once from page's server-rendered state) ---

  let allFilters = null; // [{id, conditions}]

  function loadFilters() {
    if (allFilters) return;
    try {
      const data = JSON.parse(document.querySelector('#app').dataset.page);
      allFilters = data.props.dispatcher.filters.filters.map(f => ({
        id:         f.id,
        name:       f.name,
        enabled:    f.enabled,
        conditions: f.conditions,
      }));
      console.log('[FR24FC] filters loaded:', allFilters.length);
    } catch (e) {
      console.warn('[FR24FC] filter load failed:', e);
    }
  }

  // --- Airline DB (numeric id → ICAO) for exact 'painted as' matching (E3) ---
  // FR24's feed attaches the livery airline as a numeric id (aircraft.logoId), but
  // only when the user's FR24 map settings have airline logos or logo-on-hover
  // enabled. The public airline list maps that id to the ICAO code filter
  // conditions use. Lazy: fetched once per session, only when an assigned filter
  // actually has a painted condition. Fail-soft: while null, matchesCond falls
  // back to the callsign heuristic.

  let _airlineIcaoById = null;
  let _airlineDbLoading = false;

  function ensureAirlineDb() {
    if (_airlineIcaoById || _airlineDbLoading) return;
    _airlineDbLoading = true;
    _nativeFetch('https://www.flightradar24.com/mobile/airlines?format=2&version=0')
      .then(r => r.json())
      .then(d => {
        if (!Array.isArray(d?.rows)) throw new Error('unexpected shape');
        _airlineIcaoById = new Map(d.rows.filter(a => a.icao).map(a => [a.id, a.icao]));
        console.log('[FR24FC] airline db loaded:', _airlineIcaoById.size);
        // Re-match so already-coloured aircraft correct themselves with exact livery data
        if (aircraftStore) processAircraftMap(aircraftStore.$state.aircraftMap);
      })
      .catch(e => {
        console.warn('[FR24FC] airline db load failed (painted filters fall back to callsign):', e);
        setTimeout(() => { _airlineDbLoading = false; }, 60000); // allow a retry, rate-limited
      });
  }

  // --- Filter matching ---

  function matchesCond(ac, c) {
    switch (c.type) {
      case 'Registration': return ac.reg  === c.value;
      case 'Aircraft':     return ac.type === c.value; // null icao → always false for this condition
      case 'Altitude':     return ac.alt  >= c.value[0] && ac.alt <= c.value[1];
      case 'Airport':      return (c.direction === 'in' ? ac.dest : ac.origin) === c.value;
      case 'Airline':
        // 'painted' matches exactly via the livery id when FR24 supplies one (needs
        // airline logos or logo-on-hover enabled in FR24's map settings) and the
        // airline db has loaded. Otherwise BOTH operators fall back to callsign
        // prefix — the callsign reflects the OPERATOR, so the fallback can
        // false-positive when a plane flies for an airline other than its livery
        // (reporter-approved 2026-07-16). 'operating' stays callsign-based: FR24
        // decodes the operator id from its feed but drops it before the aircraft
        // store, so exact operator matching has no data source (rare non-standard
        // callsigns are missed).
        if (c.operator === 'painted' && ac.logoId != null && _airlineIcaoById) {
          return _airlineIcaoById.get(ac.logoId) === c.value;
        }
        return !!(c.value && ac.callsign?.startsWith(c.value));
      default: return false;
    }
  }

  // Altitude acts as a modifier (AND'd with the rest); all other condition types OR'd
  function matchesFilter(ac, conditions) {
    const altConds   = conditions.filter(c => c.type === 'Altitude');
    const otherConds = conditions.filter(c => c.type !== 'Altitude');
    const altPass   = altConds.length   === 0 || altConds.some(c  => matchesCond(ac, c));
    const otherPass = otherConds.length === 0 || otherConds.some(c => matchesCond(ac, c));
    return altPass && otherPass;
  }

  // --- Aircraft data: id → { lat, lng, filterId } ---
  // Colour is resolved at render time from the current config so colour changes
  // don't require re-running the full match loop

  const acData = new Map();

  function isEnabled() {
    return document.documentElement.dataset.fr24enabled === '1';
  }

  function clearAll() {
    for (const el of markers.values()) el.remove();
    markers.clear();
    acData.clear();
    for (const el of apMarkers.values()) el.remove();
    apMarkers.clear();
    container?.querySelectorAll('[data-ap]').forEach(el => el.remove());
  }

  function processAircraftMap(aircraftMap) {
    if (!isEnabled()) return;
    loadFilters();
    if (!allFilters) return;

    const filterColorMap   = getFilterColorMap();
    const assignedFilters  = allFilters
      .filter(f => f.enabled && filterColorMap[f.id])
      .sort((a, b) => {
        // First match wins in the loop below, so highest priority sorts FIRST:
        // destination (Airport direction:in), then reg, then everything else.
        // (Was ascending, which inverted the documented priority: a reg filter
        // stole the match from a destination filter. Fixed 2026-07-16.)
        function prio(f) {
          if (f.conditions.some(c => c.type === 'Airport' && c.direction === 'in')) return 2;
          if (f.conditions.some(c => c.type === 'Registration')) return 1;
          return 0;
        }
        return prio(b) - prio(a);
      });

    if (!_airlineIcaoById && assignedFilters.some(f =>
      f.conditions.some(c => c.type === 'Airline' && c.operator === 'painted'))) ensureAirlineDb();

    acData.clear();
    for (const [id, a] of Object.entries(aircraftMap)) {
      const ac = {
        lat:      a.latitude,
        lng:      a.longitude,
        alt:      a.altitude,
        type:     a.icao,
        reg:      a.registration,
        origin:   a.from,
        dest:     a.to,
        callsign: a.callsign,
        logoId:   a.logoId,
      };
      for (const f of assignedFilters) {
        if (matchesFilter(ac, f.conditions)) {
          acData.set(id, { lat: ac.lat, lng: ac.lng, filterId: f.id, alt: ac.alt, reg: ac.reg, dest: ac.dest });
          break; // first matched filter wins
        }
      }
    }

    console.log(`[FR24FC] ${acData.size}/${Object.keys(aircraftMap).length} matched`);
    scheduleRedraw();
  }

  // --- Pinia store watch ---

  let aircraftStore    = null;
  let dispatcherStore  = null;

  function updateAirportCodesFromAllFilters() {
    if (!allFilters) return;
    const codes = [...new Set(
      allFilters.filter(f => f.enabled)
                .flatMap(f => f.conditions.filter(c => c.type === 'Airport').map(c => c.value))
    )];
    document.documentElement.dataset.fr24airports = JSON.stringify(codes);
  }

  function syncFilterListToDataset() {
    try { document.documentElement.dataset.fr24filterlist = JSON.stringify(allFilters); } catch (_) {}
  }

  function updateFiltersFromStore(dispatcher) {
    const raw = dispatcher?.filters?.filters;
    if (!raw) return;
    allFilters = raw.map(f => ({ id: String(f.id), name: f.name, enabled: f.enabled, conditions: f.conditions }));
    updateAirportCodesFromAllFilters();
    if (aircraftStore) processAircraftMap(aircraftStore.$state.aircraftMap);
    syncFilterListToDataset();
  }

  // The filter button is conditionally rendered by FR24's Vue (absent while
  // logged out and during app mount), so a one-shot querySelector can miss a
  // button that appears moments later. Poll until it exists, re-querying every
  // attempt because Vue can also REPLACE the node at any time.
  function waitForFilterButton(timeoutMs) {
    return new Promise(resolve => {
      const t0 = Date.now();
      (function poll() {
        const btn = document.querySelector('#bottom-panel__filters-button');
        if (btn && btn.isConnected) return resolve(btn);
        if (Date.now() - t0 >= timeoutMs) return resolve(null);
        setTimeout(poll, 150);
      })();
    });
  }

  // FR24's Vue does not process the re-read while the tab is hidden (owner
  // confirmed 2026-07-16: clicks land but nothing updates until tabbed in), so
  // clicking a hidden tab wastes the toggle. Defer until visible; the runner's
  // _cmdRunning guard holds later batches in order while we wait.
  function waitForVisible() {
    if (document.visibilityState === 'visible') return Promise.resolve();
    console.log('[FR24FC] refresh click deferred until tab is visible');
    return new Promise(r => document.addEventListener('visibilitychange', function h() {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', h);
      r();
    }));
  }

  // Double-toggle: FR24 re-reads its filters only on the sidebar's closed→open
  // transition, and one click just toggles. If the sidebar was already open, a
  // single click would close it (no re-read) and leave icons stale. Two clicks
  // always pass through exactly one open AND return the sidebar to its starting
  // state. The gap between them matters: a synchronous open→close can coalesce
  // in FR24's Vue reactivity to a no-op and skip the re-read entirely.
  // Each click waits for tab visibility and a LIVE re-queried button: the old
  // single-capture version silently lost clicks when the button was missing at
  // drain time or was replaced by Vue between the two clicks (a detached-node
  // click is a no-op). Every failure now warns, so a D3 contract violation is
  // visible. Async, so callers can await the full double-click (.finally waits
  // on a returned thenable), keeping stacked batches from interleaving clicks.
  // 750ms is the tuning knob - raise if the re-read doesn't stick.
  async function clickFilterButton() {
    await waitForVisible();
    const first = await waitForFilterButton(10000);
    if (!first) { console.warn('[FR24FC] refresh click FAILED: filter button not found within 10s'); return; }
    first.click();
    console.log('[FR24FC] refresh click 1/2');
    await new Promise(r => setTimeout(r, 750));
    await waitForVisible(); // user may have tabbed away mid-gap
    const second = await waitForFilterButton(5000);
    if (!second) { console.warn('[FR24FC] refresh click 2/2 FAILED: filter button gone; sidebar left toggled'); return; }
    second.click();
    console.log('[FR24FC] refresh click 2/2');
  }

  // B13: the refresh contract is "re-click FR24's filter button". Sync internal state
  // first (so the click re-applies the POST-mutation filter list), but the click itself
  // must happen exactly once per drained batch containing a refresh — even if the
  // webAPI fetch fails or returns no list. Zero clicks is the bug.
  function refreshFilters(token) {
    return _nativeFetch('https://www.flightradar24.com/webapi/v1/filters?only=filters', {
      headers: { accesstoken: token },
    }).then(r => r.json()).then(({ data: d }) => {
      const list = d?.filters;
      if (!list) return;
      allFilters = list.map(f => ({ id: String(f.id), name: f.name, enabled: f.enabled, conditions: f.conditions }));
      updateAirportCodesFromAllFilters();
      if (aircraftStore) processAircraftMap(aircraftStore.$state.aircraftMap);
      syncFilterListToDataset();
      // Patch the Pinia dispatcher store so the click re-applies the fresh list,
      // not the page's stale one (the mutation happened server-side via webAPI).
      if (dispatcherStore) {
        try {
          dispatcherStore.$patch(state => {
            const f = state?.dispatcher?.filters;
            if (f && Array.isArray(f.filters)) f.filters = list;
          });
        } catch (_) {}
      }
      console.log('[FR24FC] filters refreshed:', allFilters.length);
    }).catch(() => {}).finally(clickFilterButton);
  }

  // No-creds path: replay a server-composed FR24 request spec
  // ({type:'fr24', method, path, body, log}) with the page's access token.
  // The server owns command semantics and log formatting; the extension only
  // executes and reports. Path is pinned to the filters API as a trust boundary.
  async function executeCommand(cmd, token) {
    if (!/^\/webapi\/v1\/filters(\/|\?|$)/.test(cmd.path || '')) {
      console.warn('[FR24FC] rejected command path:', cmd.path);
      return;
    }
    let ok = false;
    try {
      const r = await _nativeFetch('https://www.flightradar24.com' + cmd.path, {
        method: cmd.method,
        headers: { accesstoken: token, ...(cmd.body != null && { 'Content-Type': 'application/json' }) },
        body: cmd.body != null ? JSON.stringify(cmd.body) : undefined,
      });
      ok = r.ok;
    } catch (_) {}
    console.log(`[FR24FC] cmd ${cmd.method} ${cmd.path} -> ${ok ? 'ok' : 'FAILED'}`);
    if (cmd.log) {
      window.postMessage({ fr24fc: 'log-event', entry: { ...cmd.log, ok, source: 'extension' } }, '*');
    }
  }

  // Backlog decouples draining (attribute writes) from execution: batches drained
  // before the token exists wait, and overlapping batches run strictly in order.
  let _cmdBacklog = [];
  let _cmdRunning = false;

  function processFilterCommands() {
    const raw = document.documentElement.dataset.fr24filtercommands;
    if (raw) {
      document.documentElement.removeAttribute('data-fr24filtercommands');
      try { _cmdBacklog.push(...JSON.parse(raw)); } catch (_) {}
    }
    if (_cmdRunning || !_cmdBacklog.length) return;
    const token = getAccessToken();
    if (!token) {
      // Mutations need the token - hold them (retried when the dispatcher store lands).
      // A refresh-only backlog can still honour the contract with a bare click,
      // serialized through _cmdRunning so it can't interleave with a later batch.
      if (_cmdBacklog.every(c => c.type === 'refresh')) {
        _cmdBacklog = [];
        _cmdRunning = true;
        clickFilterButton().finally(() => { _cmdRunning = false; });
      }
      return;
    }
    _cmdRunning = true;
    (async () => {
      while (_cmdBacklog.length) {
        const cmds = _cmdBacklog; _cmdBacklog = [];
        let needRefresh = false;
        for (const cmd of cmds) {
          if (cmd.type === 'refresh') { needRefresh = true; continue; }
          if (cmd.type === 'fr24')    { await executeCommand(cmd, token); continue; }
          console.warn('[FR24FC] unknown command type:', cmd.type);
        }
        // One effective re-click per batch, strictly after its mutations (duplicates coalesced)
        if (needRefresh) await refreshFilters(token);
      }
    })().finally(() => { _cmdRunning = false; });
  }

  const dispatcherTimer = setInterval(() => {
    const app   = document.querySelector('#app')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const dispatcher  = pinia?._s?.get('dispatcher');
    if (!dispatcher) return;
    clearInterval(dispatcherTimer);
    dispatcherStore = dispatcher;
    console.log('[FR24FC] dispatcher store found');
    const _token = getAccessToken();
    if (_token) document.documentElement.dataset.fr24accesstoken = _token;
    updateFiltersFromStore(dispatcher.$state.dispatcher);
    dispatcher.$subscribe((_, state) => updateFiltersFromStore(state.dispatcher));
    // Commands drained by content.js before our observer existed sit unprocessed
    // on the dataset — pick them up now that the token/store are available.
    processFilterCommands();

    // Intercept fetch to catch filter save/delete API calls
    const _origFetch = window.fetch;
    window.fetch = async function(...args) {
      const response = await _origFetch.apply(this, args);
      const url    = (typeof args[0] === 'string' ? args[0] : args[0]?.url) || '';
      const method = (args[1]?.method || 'GET').toUpperCase();
      if (method === 'GET' || !url.includes('filter')) return response;

      console.log('[FR24FC] filter API call:', method, url);

      if (method === 'DELETE') {
        const id = url.match(/\/(\d+)\/?$/)?.[1];
        if (id && allFilters) {
          allFilters = allFilters.filter(f => f.id !== id);
          updateAirportCodesFromAllFilters();
          if (aircraftStore) processAircraftMap(aircraftStore.$state.aircraftMap);
          syncFilterListToDataset();
          console.log('[FR24FC] filter deleted:', id);
        }
      } else {
        response.clone().json().then(({ data }) => {
          const raw = data?.filters;
          if (!raw) {
            // empty=true response omits filter list; fetch it fresh so enable/disable is reflected immediately
            const token = getAccessToken();
            if (!token) return;
            _origFetch('https://www.flightradar24.com/webapi/v1/filters?only=filters', {
              headers: { accesstoken: token },
            }).then(r => r.json()).then(({ data: d }) => {
              const list = d?.filters;
              if (!list) return;
              allFilters = list.map(f => ({ id: String(f.id), name: f.name, enabled: f.enabled, conditions: f.conditions }));
              updateAirportCodesFromAllFilters();
              if (aircraftStore) processAircraftMap(aircraftStore.$state.aircraftMap);
              syncFilterListToDataset();
            }).catch(() => {});
            return;
          }
          allFilters = raw.map(f => ({ id: String(f.id), name: f.name, enabled: f.enabled, conditions: f.conditions }));
          updateAirportCodesFromAllFilters();
          if (aircraftStore) processAircraftMap(aircraftStore.$state.aircraftMap);
          syncFilterListToDataset();
        }).catch(e => console.warn('[FR24FC] response parse error:', e));
      }
      return response;
    };
  }, 200);

  let processTimer = null;
  function scheduleProcess(aircraftMap) {
    clearTimeout(processTimer);
    processTimer = setTimeout(() => processAircraftMap(aircraftMap), 300);
  }

  const storeTimer = setInterval(() => {
    const app   = document.querySelector('#app')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const store = pinia?._s?.get('aircraft');
    if (!store) return;
    clearInterval(storeTimer);
    aircraftStore = store;
    console.log('[FR24FC] aircraft store found, subscribing');
    processAircraftMap(store.$state.aircraftMap);
    store.$subscribe((_, state) => scheduleProcess(state.aircraftMap));
  }, 200);

  // --- Map overlay ---

  let mapObj       = null;
  let container    = null;
  let overlayProj  = null;
  const markers = new Map(); // id → div element

  function initOverlay(map) {
    if (mapObj) return;
    mapObj    = map;
    container = document.createElement('div');
    // z-index 200 sits under FR24's aircraft canvas; ring shape keeps direction arrow visible through the transparent centre
    container.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:200;';
    map.getDiv().appendChild(container);
    map.addListener('bounds_changed',     scheduleRedraw);
    map.addListener('projection_changed', scheduleRedraw);

    // Use OverlayView to get fromLatLngToContainerPixel — the only API that
    // correctly handles grey bars and extreme zoom-out without manual maths.
    const ov = new google.maps.OverlayView();
    ov.onAdd    = function() {};
    ov.draw     = function() { overlayProj = this.getProjection(); scheduleRedraw(); };
    ov.onRemove = function() { overlayProj = null; };
    ov.setMap(map);

    console.log('[FR24FC] overlay attached to map');
  }

  let rafId = null;
  function scheduleRedraw() {
    if (!rafId) rafId = requestAnimationFrame(() => { rafId = null; redraw(); });
  }

  // Use OverlayView projection for pixel coords — handles grey bars, zoom limits,
  // and extended bounds automatically. sw/ne/scale kept in signature for call-site compat.
  function toPixel(proj, sw, ne, scale, lat, lng) {
    if (overlayProj) {
      const px = overlayProj.fromLatLngToContainerPixel(new google.maps.LatLng(lat, lng));
      if (px) {
        // antimeridian wrap: if x is far off-screen, shift by one world width
        const worldW = 256 * scale;
        let { x, y } = px;
        if (x < -worldW / 2) x += worldW;
        else if (x > container.offsetWidth + worldW / 2) x -= worldW;
        return { x, y };
      }
    }
    // fallback (before overlayProj is ready): centre-anchor formula
    const wp     = proj.fromLatLngToPoint(new google.maps.LatLng(lat, lng));
    const cp     = proj.fromLatLngToPoint(mapObj.getCenter());
    const worldW = 256 * scale;
    let x = container.offsetWidth  / 2 + (wp.x - cp.x) * scale;
    const y = container.offsetHeight / 2 + (wp.y - cp.y) * scale;
    if (x < -worldW / 2) x += worldW;
    else if (x > worldW * 1.5) x -= worldW;
    return { x, y };
  }

  function redraw() {
    if (!mapObj || !container) return;
    const proj   = mapObj.getProjection();
    const bounds = mapObj.getBounds();
    if (!proj || !bounds) return;

    const filterColorMap = getFilterColorMap();
    const ne        = proj.fromLatLngToPoint(bounds.getNorthEast());
    const sw        = proj.fromLatLngToPoint(bounds.getSouthWest());
    // scale derived from bounds span, not getZoom() — keeps scale/bounds in sync during zoom animation
    const worldSpan   = ne.x >= sw.x ? (ne.x - sw.x) : (256 - sw.x + ne.x);
    const scale     = container.offsetWidth / worldSpan;

    const regMap       = getRegMap();
    const regMapActive = Object.keys(regMap).length > 0;

    const seen = new Set();
    for (const [id, { lat, lng, filterId, alt, reg, dest }] of acData) {
      const meta = filterColorMap[filterId];
      if (!meta) continue; // filter unassigned — skip
      const { color, name } = meta;

      seen.add(id);
      const { x, y } = toPixel(proj, sw, ne, scale, lat, lng);

      if (!markers.has(id)) {
        const el = document.createElement('div');
        // ring not filled circle — aircraft direction arrow stays visible through transparent centre
        el.style.cssText = 'position:absolute;width:26px;height:26px;border-radius:50%;transform:translate(-50%,-50%);background:transparent;border:3px solid transparent;z-index:2;';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'position:absolute;right:calc(100% + 4px);top:50%;transform:translateY(-50%);white-space:pre;text-align:center;font:bold 11px/1.4 sans-serif;color:#fff;background:rgba(25,30,40,0.85);padding:2px 5px;border-radius:3px;';
        el.appendChild(lbl);
        container.appendChild(el);
        markers.set(id, el);
      }
      const el    = markers.get(id);
      el.style.borderColor = color;
      el.style.opacity     = '0.9';
      el.style.left       = x + 'px';
      el.style.top        = y + 'px';
      const ri = regMap[reg];
      const isDestFilter = allFilters?.find(f => f.id === filterId)
        ?.conditions?.some(c => c.type === 'Airport' && c.direction === 'in');
      let topLine;
      if (isDestFilter) {
        topLine = name || '';
      } else if (ri?.airports?.length) {
        const byCountry = {};
        for (const { iata, country } of ri.airports) (byCountry[country] ??= []).push(iata);
        topLine = Object.entries(byCountry).map(([c, codes]) => `${c} - ${codes.join('/')}`).join('\n');
      } else {
        topLine = ri ? `${ri.country} - ${ri.iata}` : (name || '');
      }
      el.firstChild.textContent = topLine + (alt ? '\n' + alt.toLocaleString() + 'ft' : '');

      // Red text: MapTrack active + reg-matched (not dest-matched) + dest set + dest ≠ home airport(s)
      let labelColor = '#fff';
      if (regMapActive && !isDestFilter && dest && ri) {
        const homeCodes = ri.airports ? ri.airports.map(a => a.iata) : (ri.iata || '').split('/');
        if (!homeCodes.includes(dest)) labelColor = '#ff4444';
      }
      el.firstChild.style.color = labelColor;
    }

    for (const [id, el] of markers) {
      if (!seen.has(id)) { el.remove(); markers.delete(id); }
    }

    drawAirportDots(proj, ne, sw, scale);
    drawClaimedAirports(proj, ne, sw, scale);
  }

  // --- Google Maps hook ---

  function hookMaps() {
    const Orig = google.maps.Map;
    function PatchedMap(el, opts) {
      const m = new Orig(el, opts);
      initOverlay(m);
      google.maps.Map = Orig;
      return m;
    }
    PatchedMap.prototype = Orig.prototype;
    google.maps.Map = PatchedMap;

    const origSetMap = google.maps.OverlayView.prototype.setMap;
    google.maps.OverlayView.prototype.setMap = function (map) {
      if (map) initOverlay(map);
      return origSetMap.apply(this, arguments);
    };
  }

  const hookTimer = setInterval(() => {
    if (!window.google?.maps?.Map) return;
    clearInterval(hookTimer);
    hookMaps();
  }, 50);

  // --- Airport hunt dots ---

  function getFilterAirportCodes() {
    try { return new Set(JSON.parse(document.documentElement.dataset.fr24airports || '[]')); }
    catch (e) { return new Set(); }
  }

  const airportDots  = new Map(); // iata → {lat, lng, country}
  const claimedDots  = new Map(); // iata → {lat, lng}
  const apMarkers    = new Map(); // iata → div element
  let   apStoreRef   = null;

  function getClaimedCodes() {
    try {
      const manual   = JSON.parse(document.documentElement.dataset.fr24claimed           || '[]');
      const maptrack = JSON.parse(document.documentElement.dataset.fr24maptrackclaimed   || '[]');
      return new Set([...manual, ...maptrack]);
    }
    catch (e) { return new Set(); }
  }

  function processAirports(data) {
    const filterCodes  = getFilterAirportCodes();
    const claimedCodes = getClaimedCodes();
    const entries = Array.isArray(data) ? data : Object.values(data);
    for (const ap of entries) {
      const code = ap.iata || ap.icao || ap.code || ap.id;
      const lat  = ap.lat ?? ap.latitude;
      const lng  = ap.lon ?? ap.lng ?? ap.longitude;
      if (!code || lat == null || lng == null) continue;
      if (filterCodes.has(code)) airportDots.set(code, { lat, lng, country: ap.country });
      else if (airportDots.has(code)) airportDots.delete(code);
      if (claimedCodes.has(code)) claimedDots.set(code, { lat, lng });
    }
    scheduleRedraw();
  }

  function updateClaimedLocations() {
    claimedDots.clear();
    const codes = getClaimedCodes();
    if (!codes.size) { scheduleRedraw(); return; }
    if (apStoreRef) {
      const state = apStoreRef.$state;
      const data  = state.airportMap ?? state.airports ?? state.airportsMap;
      if (data) {
        const entries = Array.isArray(data) ? data : Object.values(data);
        for (const ap of entries) {
          const code = ap.iata || ap.icao || ap.code || ap.id;
          if (!codes.has(code)) continue;
          const lat = ap.lat ?? ap.latitude;
          const lng = ap.lon ?? ap.lng ?? ap.longitude;
          if (lat != null && lng != null) claimedDots.set(code, { lat, lng });
        }
      }
    }
    scheduleRedraw();
  }

  const apStoreTimer = setInterval(() => {
    const app   = document.querySelector('#app')?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    if (!pinia) return;
    for (const [name, store] of pinia._s) {
      const s = store.$state;
      if (!s) continue;
      const candidate = s.airportMap ?? s.airports ?? s.airportsMap;
      if (!candidate) continue;
      clearInterval(apStoreTimer);
      apStoreRef = store;
      console.log('[FR24FC] airport store found:', name);
      processAirports(candidate);
      updateClaimedLocations();
      store.$subscribe((_, state) => {
        const d = state.airportMap ?? state.airports ?? state.airportsMap;
        if (d) processAirports(d);
      });
      return;
    }
  }, 500);

  function getActiveAirportCodes() {
    const regMap = getRegMap();
    const active = new Set();
    for (const { reg } of acData.values()) {
      const ri = reg && regMap[reg];
      if (ri) ri.iata.split('/').forEach(c => active.add(c));
    }
    return active;
  }

  function drawAirportDots(proj, ne, sw, scale) {
    const codes        = getFilterAirportCodes();
    const showAll      = !!document.documentElement.dataset.fr24showallair;
    const hideEmpty    = document.documentElement.dataset.fr24hideempty === '1';
    const defaultColor = document.documentElement.dataset.fr24defaultairportcolor || '#ff3b3b';

    const groups = JSON.parse(document.documentElement.dataset.fr24groups || '[]');
    const countryColor = {};
    for (const g of groups) if (g.name && g.color) countryColor[g.name] = g.color;

    const apCountry = {};
    for (const ri of Object.values(getRegMap())) {
      const airports = ri.airports || (ri.iata || '').split('/').map(i => ({ iata: i, country: ri.country }));
      for (const { iata, country } of airports) {
        if (!apCountry[iata]) apCountry[iata] = country;
      }
    }
    for (const [code, ap] of airportDots) {
      if (ap.country && !apCountry[code]) apCountry[code] = ap.country;
    }

    const activeAirports = hideEmpty ? getActiveAirportCodes() : null;

    // Cleanup stale markers (removed from filter, lost country colour, or no longer active)
    for (const [code, el] of apMarkers) {
      const hasColor = !!countryColor[apCountry[code]];
      if (!codes.has(code) || (!showAll && !hasColor) || (!showAll && hideEmpty && !activeAirports.has(code))) {
        el.remove();
        apMarkers.delete(code);
      }
    }

    // bounds-cull — only position dots inside the current viewport; hide others without destroying them
    const viewBounds = mapObj.getBounds();

    for (const [code, { lat, lng }] of airportDots) {
      if (!codes.has(code)) continue;
      if (!showAll && hideEmpty && !activeAirports.has(code)) continue;
      const color = countryColor[apCountry[code]];
      if (!showAll && !color) continue;

      if (viewBounds && !viewBounds.contains(new google.maps.LatLng(lat, lng))) {
        const el = apMarkers.get(code);
        if (el) el.style.display = 'none';
        continue;
      }

      let el = apMarkers.get(code);
      if (!el) {
        el = document.createElement('div');
        el.dataset.ap = code;
        el.style.cssText = 'position:absolute;width:14px;height:14px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 1px #000;transform:translate(-50%,-50%);pointer-events:auto;cursor:default;z-index:1;';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'display:none;position:absolute;bottom:calc(100% + 5px);left:50%;transform:translateX(-50%);white-space:nowrap;font:bold 11px/1.4 sans-serif;color:#fff;background:rgba(25,30,40,0.85);padding:2px 5px;border-radius:3px;pointer-events:none;';
        lbl.textContent = code;
        el.appendChild(lbl);
        // Raise above aircraft rings (z-index:2) on hover so the code popup isn't buried
        el.addEventListener('mouseenter', () => { lbl.style.display = 'block'; el.style.zIndex = '3'; });
        el.addEventListener('mouseleave', () => { lbl.style.display = 'none';  el.style.zIndex = '1'; });
        container.appendChild(el);
        apMarkers.set(code, el);
      }
      el.style.display = '';
      el.style.background = color || defaultColor;
      const { x, y } = toPixel(proj, sw, ne, scale, lat, lng);
      el.style.left = x + 'px';
      el.style.top  = y + 'px';
    }
  }

  function drawClaimedAirports(proj, ne, sw, scale) {
    const active = getClaimedCodes();
    // Remove stars for codes no longer claimed
    for (const el of container.querySelectorAll('[data-claimed]')) {
      if (!active.has(el.dataset.claimed)) el.remove();
    }
    for (const [code, { lat, lng }] of claimedDots) {
      const { x, y } = toPixel(proj, sw, ne, scale, lat, lng);
      let el = container.querySelector(`[data-claimed="${code}"]`);
      if (!el) {
        el = document.createElement('div');
        el.dataset.claimed = code;
        el.style.cssText = 'position:absolute;width:14px;height:14px;border-radius:50%;border:3px solid #ffd700;background:transparent;box-shadow:0 0 0 1px rgba(0,0,0,0.6);transform:translate(-50%,-50%);pointer-events:none;';
        container.appendChild(el);
      }
      el.style.left = x + 'px';
      el.style.top  = y + 'px';
    }
  }

  // Reprocess on assignment/colour changes so new assignments show immediately
  new MutationObserver((mutations) => {
    if (mutations.some(m => m.attributeName === 'data-fr24airports')) {
      // Re-process from Pinia store so newly-added filter airports get picked up immediately
      if (apStoreRef) {
        const s = apStoreRef.$state;
        const d = s.airportMap ?? s.airports ?? s.airportsMap;
        if (d) processAirports(d);
      }
    }
    if (mutations.some(m => m.attributeName === 'data-fr24regmap')) {
      _regMap = null;
      try {
        onRegMapChanged(JSON.parse(document.documentElement.dataset.fr24regmap || '{}'));
      } catch (_) {}
    }
    if (mutations.some(m => m.attributeName === 'data-fr24filtercommands')) {
      processFilterCommands();
    }
    if (!isEnabled()) { clearAll(); return; }
    if (aircraftStore) processAircraftMap(aircraftStore.$state.aircraftMap);
    else scheduleRedraw();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-fr24groups', 'data-fr24assignments', 'data-fr24airports', 'data-fr24showallair', 'data-fr24hideempty', 'data-fr24defaultairportcolor', 'data-fr24enabled', 'data-fr24claimed', 'data-fr24regmap', 'data-fr24filtercommands'] });

  new MutationObserver(() => {
    updateClaimedLocations();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-fr24claimed', 'data-fr24maptrackclaimed'] });

  new MutationObserver(() => {
    if (dispatcherStore) {
      allFilters = null;
      updateFiltersFromStore(dispatcherStore.$state.dispatcher);
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-fr24refreshsig'] });
})();
