// Inject into page context so it can access window.google and window.fetch
const s = document.createElement('script');
s.src = chrome.runtime.getURL('injected.js');
(document.head || document.documentElement).appendChild(s);

// Read FR24 filters from server-rendered page state and cache in storage for the popup
function tryReadFilters() {
  const el = document.querySelector('#app[data-page]');
  if (!el) return false;
  try {
    const data    = JSON.parse(el.dataset.page);
    const filters = data.props.dispatcher.filters.filters.map(f => ({
      id:         f.id,
      name:       f.name,
      enabled:    f.enabled,
      hasAirport: f.conditions.some(c => c.type === 'Airport'),
    }));
    chrome.storage.local.set({ fr24Filters: filters }); // local only — re-populated from the page on each visit

    const airportCodes = [...new Set(
      data.props.dispatcher.filters.filters
        .filter(f => f.enabled)
        .flatMap(f => f.conditions.filter(c => c.type === 'Airport').map(c => c.value))
    )];
    document.documentElement.dataset.fr24airports = JSON.stringify(airportCodes);
    return true;
  } catch (e) { return false; }
}

if (!tryReadFilters()) {
  const obs = new MutationObserver(() => { if (tryReadFilters()) obs.disconnect(); });
  obs.observe(document, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'refreshFilters') {
    document.documentElement.dataset.fr24refreshsig = Date.now();
  }
});

// Push groups + assignments config to injected.js via dataset attributes
function pushConfig() {
  chrome.storage.sync.get({ groups: [], assignments: {}, showAllAirports: false, hideEmptyAirportDots: false, defaultAirportColor: '#ff3b3b', extensionEnabled: true, claimedAirports: [] }, ({ groups, assignments, showAllAirports, hideEmptyAirportDots, defaultAirportColor, extensionEnabled, claimedAirports }) => {
    document.documentElement.dataset.fr24groups             = JSON.stringify(groups);
    document.documentElement.dataset.fr24assignments        = JSON.stringify(assignments);
    document.documentElement.dataset.fr24showallair         = showAllAirports      ? '1' : '';
    document.documentElement.dataset.fr24hideempty          = hideEmptyAirportDots ? '1' : '';
    document.documentElement.dataset.fr24defaultairportcolor = defaultAirportColor;
    document.documentElement.dataset.fr24enabled            = extensionEnabled ? '1' : '';
    document.documentElement.dataset.fr24claimed            = JSON.stringify(claimedAirports);
  });
}

function fetchMapTrackClaimed() {
  if (!alive()) return;
  chrome.runtime.sendMessage({ type: 'getMapTrackClaimed' }, resp => {
    if (chrome.runtime.lastError || !resp?.ok) return;
    document.documentElement.dataset.fr24maptrackclaimed = JSON.stringify(resp.data);
  });
}
function alive() { return !!chrome.runtime?.id; }

pushConfig();
fetchMapTrackClaimed();
chrome.storage.onChanged.addListener(() => { if (alive()) pushConfig(); });

function fetchRegMap() {
  if (!alive()) { document.removeEventListener('visibilitychange', onVisible); return; }
  chrome.runtime.sendMessage({ type: 'getRegMap' }, resp => {
    if (chrome.runtime.lastError) return;
    if (resp?.ok) {
      document.documentElement.dataset.fr24regmap = JSON.stringify(resp.data);
      console.log('[FR24FC] regmap loaded:', Object.keys(resp.data.regs || {}).length, 'regs');
    }
  });
}

function fetchFilterCommands() {
  if (!alive()) return;
  chrome.runtime.sendMessage({ type: 'getFilterCommands' }, resp => {
    if (chrome.runtime.lastError) return;
    if (resp?.cmds?.length) {
      console.log('[FR24FC] draining', resp.cmds.length, 'command(s) in this tab');
      document.documentElement.dataset.fr24filtercommands = JSON.stringify(resp.cmds);
    }
  });
}

// Relay filter list from injected.js (page context) to MapTrack via background.js
// Also keep chrome.storage.local in sync so the popup sees new/deleted filters without a page refresh
new MutationObserver(() => {
  if (!alive()) return;
  const raw = document.documentElement.dataset.fr24filterlist;
  if (!raw) return;
  const parsed = JSON.parse(raw);
  chrome.runtime.sendMessage({ type: 'postFilters', data: parsed });
  chrome.storage.local.set({
    fr24Filters: parsed.map(f => ({
      id:         String(f.id),
      name:       f.name,
      enabled:    f.enabled,
      hasAirport: (f.conditions || []).some(c => c.type === 'Airport'),
    })),
  });
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-fr24filterlist'] });

function onVisible() {
  if (document.visibilityState !== 'visible') return;
  if (alive()) chrome.runtime.sendMessage({ type: 'becomeDesignated' }).catch(() => {});
  fetchRegMap();
  fetchFilterCommands();
  fetchMapTrackClaimed();
}

new MutationObserver(() => {
  const token = document.documentElement.dataset.fr24accesstoken;
  if (token && alive()) chrome.runtime.sendMessage({ type: 'pushFR24Credentials', token }).catch(() => {});
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-fr24accesstoken'] });
// push immediately if token already on DOM (e.g. extension reloaded on open tab)
{ const token = document.documentElement.dataset.fr24accesstoken;
  if (token && alive()) chrome.runtime.sendMessage({ type: 'pushFR24Credentials', token }).catch(() => {}); }

// Relay activity-log entries from injected.js (page context) to MapTrack
window.addEventListener('message', e => {
  if (e.source !== window || e.data?.fr24fc !== 'log-event') return;
  if (alive()) chrome.runtime.sendMessage({ type: 'postLogEvent', entry: e.data.entry }).catch(() => {});
});

fetchRegMap();
fetchFilterCommands();
setInterval(fetchFilterCommands, 10000);   // pick up refresh signals without needing a tab switch
setInterval(fetchMapTrackClaimed, 30000);  // keep claimed airport rings in sync
document.addEventListener('visibilitychange', onVisible);
// visibilitychange never fires between two VISIBLE windows; without this, a
// second FR24 window can hold command designation while the user watches the first
window.addEventListener('focus', () => {
  if (alive()) chrome.runtime.sendMessage({ type: 'becomeDesignated' }).catch(() => {});
});
