(function () {
  'use strict';

  console.log('[FR24FC] injected.js loaded');

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

  // --- Filter matching ---

  function matchesCond(ac, c) {
    switch (c.type) {
      case 'Registration': return ac.reg  === c.value;
      case 'Aircraft':     return ac.type === c.value; // null icao → always false for this condition
      case 'Altitude':     return ac.alt  >= c.value[0] && ac.alt <= c.value[1];
      case 'Airport':      return (c.direction === 'in' ? ac.dest : ac.origin) === c.value;
      case 'Airline':
        // matched by callsign prefix — misses codeshares with non-standard callsigns
        return !!(ac.callsign?.startsWith(c.value));
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
        // destination (Airport direction:in) last = highest priority; reg next; everything else first
        function prio(f) {
          if (f.conditions.some(c => c.type === 'Airport' && c.direction === 'in')) return 2;
          if (f.conditions.some(c => c.type === 'Registration')) return 1;
          return 0;
        }
        return prio(a) - prio(b);
      });

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
        el.addEventListener('mouseenter', () => { lbl.style.display = 'block'; });
        el.addEventListener('mouseleave', () => { lbl.style.display = 'none'; });
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
      const raw = document.documentElement.dataset.fr24filtercommands;
      if (raw) {
        document.documentElement.removeAttribute('data-fr24filtercommands');
        try {
          const cmds = JSON.parse(raw);
          if (cmds.some(c => c.type === 'refresh')) {
            document.querySelector('#bottom-panel__filters-button')?.click();
          }
        } catch (_) {}
      }
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
