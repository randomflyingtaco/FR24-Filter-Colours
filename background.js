let designatedTabId = null;
let _url  = '';
let _auth = '';
let _configLoaded;

function loadConfig() {
  _configLoaded = new Promise(resolve => {
    chrome.storage.sync.get({ maptrackUrl: '', maptrackUser: '', maptrackPass: '' }, ({ maptrackUrl, maptrackUser, maptrackPass }) => {
      _url  = maptrackUrl.replace(/\/$/, '');
      _auth = (maptrackUser && maptrackPass)
        ? 'Basic ' + btoa(maptrackUser + ':' + maptrackPass)
        : '';
      resolve();
    });
  });
}

loadConfig();
chrome.storage.onChanged.addListener(loadConfig);

// Closed designated tab must not block command draining for the remaining tabs
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === designatedTabId) designatedTabId = null;
});

function mtFetch(path, opts = {}) {
  return _configLoaded.then(() => {
    if (!_url) return null; // no server configured — callers check for null
    const headers = { ...(opts.headers || {}) };
    if (_auth) headers['Authorization'] = _auth;
    return fetch(_url + path, { ...opts, headers });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'pingMapTrack') {
    const url = (msg.url || '').replace(/\/$/, '');
    if (!url) { sendResponse({ ok: false, noServer: true }); return false; }
    const headers = {};
    if (msg.user && msg.pass) headers['Authorization'] = 'Basic ' + btoa(msg.user + ':' + msg.pass);
    fetch(url + '/scraper/status', { headers })
      .then(r => sendResponse(r.ok ? { ok: true } : { ok: false, status: r.status }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'pushFR24Credentials') {
    _configLoaded.then(() => {
      if (!_url) return;
      chrome.storage.local.get({ lastCredentialsPush: 0 }, ({ lastCredentialsPush }) => {
        const age = Date.now() - lastCredentialsPush;
        const doPush = () => {
          chrome.cookies.getAll({ name: 'cf_clearance', partitionKey: {} }, cookies => {
            const cookie = cookies[0] ?? null;
            if (!cookie) return;
            mtFetch('/scraper/fr24-credentials', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: msg.token, cf_clearance: cookie.value }),
            }).then(r => {
              if (r?.ok) chrome.storage.local.set({ lastCredentialsPush: Date.now() });
            }).catch(() => {});
          });
        };
        if (age >= 23 * 60 * 60 * 1000) { doPush(); return; }
        mtFetch('/scraper/fr24-credentials')
          .then(r => r ? r.json() : null)
          .then(data => { if (!data?.stored) doPush(); })
          .catch(() => {});
      });
    });
    return false;
  }

  if (msg.type === 'becomeDesignated') {
    designatedTabId = sender.tab?.id ?? null;
    return false;
  }

  if (msg.type === 'getRegMap') {
    mtFetch('/scraper/reg-map')
      .then(r => r ? r.json() : null)
      .then(data => sendResponse(data ? { ok: true, data } : { ok: false, noServer: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'postFilters') {
    mtFetch('/scraper/filters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.data),
    }).catch(() => {});
    return false;
  }

  if (msg.type === 'postLogEvent') {
    mtFetch('/scraper/log-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.entry),
    }).catch(() => {});
    return false;
  }

  if (msg.type === 'getMapTrackClaimed') {
    mtFetch('/scraper/claimed')
      .then(r => r ? r.json() : null)
      .then(data => sendResponse(data !== null ? { ok: true, data } : { ok: false, noServer: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'getFilterCommands') {
    const tabId = sender.tab?.id;
    if (designatedTabId !== null && tabId !== designatedTabId) {
      sendResponse({ cmds: [] });
      return false;
    }
    if (designatedTabId === null) designatedTabId = tabId ?? null;
    mtFetch('/scraper/filter-commands')
      .then(r => r ? r.json() : [])
      .then(cmds => sendResponse({ cmds: Array.isArray(cmds) ? cmds : [] }))
      .catch(() => sendResponse({ cmds: [] }));
    return true;
  }
});
