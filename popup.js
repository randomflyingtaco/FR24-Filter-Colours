const PRESETS = ['#ffadad','#ffd6a5','#fdffb6','#caffbf','#9bf6ff','#a0c4ff','#bdb2ff','#ffc6ff'];

let groups        = [];
let filters       = [];
let assignments   = {};
let claimedAirports = [];

// sync per-item quota is ~8KB; surface a silent quota/write failure instead of losing config quietly.
function syncSet(obj) {
  chrome.storage.sync.set(obj, () => {
    if (chrome.runtime.lastError) console.warn('[FR24FC] sync write failed:', chrome.runtime.lastError.message);
  });
}

function setToggleUI(enabled) {
  const btn = document.getElementById('toggleEnabled');
  btn.textContent       = enabled ? 'On' : 'Off';
  btn.style.background  = enabled ? '#22c55e' : '#ef4444';
  btn.style.color       = '#fff';
  btn.style.borderColor = enabled ? '#16a34a' : '#dc2626';
}

async function load() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(['groups', 'assignments', 'showAllAirports', 'hideEmptyAirportDots', 'defaultAirportColor', 'extensionEnabled', 'claimedAirports', 'maptrackUrl', 'maptrackUser', 'maptrackPass']),
    chrome.storage.local.get(['fr24Filters']),
  ]);
  filters         = local.fr24Filters    || [];
  assignments     = sync.assignments     || {};
  groups          = sync.groups          || [];
  claimedAirports = sync.claimedAirports || [];
  document.getElementById('showAllAirports').checked      = sync.showAllAirports      || false;
  document.getElementById('hideEmptyAirportDots').checked = sync.hideEmptyAirportDots || false;
  document.getElementById('defaultAirportColor').value    = sync.defaultAirportColor  || '#ff3b3b';
  setToggleUI(sync.extensionEnabled !== false);
  document.getElementById('maptrackUrl').value  = sync.maptrackUrl  || '';
  document.getElementById('maptrackUser').value = sync.maptrackUser || '';
  document.getElementById('maptrackPass').value = sync.maptrackPass || '';
  checkMapTrackConnection(sync.maptrackUrl || '', sync.maptrackUser || '', sync.maptrackPass || '');
  render();
}

function checkMapTrackConnection(url, user, pass) {
  const el = document.getElementById('maptrackStatus');
  if (!url) {
    el.textContent = 'Not configured - MapTrack features disabled.';
    el.style.color = '#888';
    setMapTrackDependentUI(false);
    return;
  }
  el.textContent = 'Checking…';
  el.style.color = '#888';
  // Visually disable while checking but don't clear storage — result not known yet
  document.getElementById('hideEmptySection').classList.add('maptrack-disabled');
  chrome.runtime.sendMessage({ type: 'pingMapTrack', url, user, pass }, resp => {
    if (resp?.ok) {
      el.textContent = `Connected to ${url}`;
      el.style.color = '#16a34a';
      setMapTrackDependentUI(true);
    } else {
      el.textContent = 'Connection failed - check URL and credentials.';
      el.style.color = '#ef4444';
      setMapTrackDependentUI(false);
    }
  });
}

function setMapTrackDependentUI(connected) {
  document.getElementById('hideEmptySection').classList.toggle('maptrack-disabled', !connected);
  if (!connected) {
    document.getElementById('hideEmptyAirportDots').checked = false;
    syncSet({ hideEmptyAirportDots: false });
  }
}

function saveMapTrack() {
  const url  = document.getElementById('maptrackUrl').value.trim();
  const user = document.getElementById('maptrackUser').value.trim();
  const pass = document.getElementById('maptrackPass').value;
  syncSet({ maptrackUrl: url, maptrackUser: user, maptrackPass: pass });
  checkMapTrackConnection(url, user, pass);
}

document.getElementById('maptrackUrl').addEventListener('change',  saveMapTrack);
document.getElementById('maptrackUser').addEventListener('change', saveMapTrack);
document.getElementById('maptrackPass').addEventListener('change', saveMapTrack);

document.getElementById('showAllAirports').addEventListener('change', e => {
  syncSet({ showAllAirports: e.target.checked });
});
document.getElementById('hideEmptyAirportDots').addEventListener('change', e => {
  syncSet({ hideEmptyAirportDots: e.target.checked });
});
document.getElementById('defaultAirportColor').addEventListener('input', e => {
  syncSet({ defaultAirportColor: e.target.value });
});

function save() {
  syncSet({ groups, assignments });
}

function render() {
  renderGroups();
  renderFilters();
  renderClaimed();
}

function renderClaimed() {
  const list = document.getElementById('claimedList');
  const clearBtn = document.getElementById('clearClaims');
  list.innerHTML = '';
  for (const code of claimedAirports) {
    const chip = document.createElement('div');
    chip.style.cssText = 'display:flex;align-items:center;gap:3px;background:#fef9c3;border:1px solid #fcd34d;border-radius:4px;padding:2px 6px;font-size:12px;font-weight:600;';
    chip.innerHTML = esc(code);
    const x = document.createElement('button');
    x.textContent = '×';
    x.style.cssText = 'background:none;border:none;cursor:pointer;color:#92400e;font-size:14px;line-height:1;padding:0 0 0 3px;';
    x.addEventListener('click', () => {
      claimedAirports = claimedAirports.filter(c => c !== code);
      syncSet({ claimedAirports });
      renderClaimed();
    });
    chip.appendChild(x);
    list.appendChild(chip);
  }
  clearBtn.style.display = claimedAirports.length ? 'block' : 'none';
}

function renderGroups() {
  const el = document.getElementById('groups');
  el.innerHTML = '';
  for (const g of groups) {
    const row = document.createElement('div');
    row.className = 'group';

    const colorInput = document.createElement('input');
    colorInput.type  = 'color';
    colorInput.value = g.color;
    colorInput.addEventListener('input', e => { g.color = e.target.value; save(); });

    const nameInput = document.createElement('input');
    nameInput.type        = 'text';
    nameInput.value       = g.name;
    nameInput.placeholder = 'Group name';
    nameInput.addEventListener('input', e => {
      g.name = e.target.value;
      save();
      renderFilters(); // update select option labels live
    });

    const del = document.createElement('button');
    del.className   = 'del';
    del.textContent = '×';
    del.title       = 'Delete group';
    del.addEventListener('click', () => {
      for (const fId of Object.keys(assignments)) {
        if (assignments[fId] === g.id) delete assignments[fId];
      }
      groups = groups.filter(x => x.id !== g.id);
      save();
      render();
    });

    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    for (const hex of PRESETS) {
      const s = document.createElement('button');
      s.className = 'swatch';
      s.style.background = hex;
      s.title = hex;
      s.addEventListener('click', () => { g.color = hex; colorInput.value = hex; save(); });
      swatches.appendChild(s);
    }

    row.append(colorInput, nameInput, del);
    el.append(row, swatches);
  }
}

function renderFilters() {
  const el = document.getElementById('filters');
  el.innerHTML = '';

  if (filters.length === 0) {
    el.innerHTML = '<p id="noFilters">Open flightradar24.com first to load filters.</p>';
    return;
  }

  for (const f of filters) {
    const row = document.createElement('div');
    row.className = 'filter-row';

    const name = document.createElement('span');
    name.className   = 'filter-name';
    name.textContent = f.name;
    name.title       = f.name;

    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">— none —</option>' +
      groups.map(g => {
        const selected = assignments[f.id] === g.id ? ' selected' : '';
        return `<option value="${esc(g.id)}"${selected}>${esc(g.name || 'Unnamed')}</option>`;
      }).join('');
    sel.addEventListener('change', e => {
      if (e.target.value) assignments[f.id] = e.target.value;
      else delete assignments[f.id];
      save();
    });

    row.append(name, sel);
    el.appendChild(row);
  }
}

document.getElementById('addGroup').addEventListener('click', () => {
  groups.push({ id: uid(), name: 'New group', color: '#db89ea' });
  save();
  render();
});

document.getElementById('autoCreateGroups').addEventListener('click', () => {
  const existingNames = new Set(groups.map(g => g.name));
  const toAdd = filters.filter(f => !existingNames.has(f.name));
  if (!toAdd.length) return;
  const palette = PRESETS;
  toAdd.forEach((f, i) => {
    groups.push({ id: uid(), name: f.name, color: palette[i % palette.length] });
  });
  save();
  render();
});

function uid() {
  return crypto.randomUUID();
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addClaim() {
  const input = document.getElementById('claimInput');
  const code  = input.value.trim().toUpperCase();
  if (!code || claimedAirports.includes(code)) { input.value = ''; return; }
  claimedAirports.push(code);
  syncSet({ claimedAirports });
  input.value = '';
  renderClaimed();
}

document.getElementById('addClaim').addEventListener('click', addClaim);
document.getElementById('claimInput').addEventListener('keydown', e => { if (e.key === 'Enter') addClaim(); });
document.getElementById('clearClaims').addEventListener('click', () => {
  claimedAirports = [];
  syncSet({ claimedAirports });
  renderClaimed();
});

document.getElementById('toggleEnabled').addEventListener('click', () => {
  chrome.storage.sync.get({ extensionEnabled: true }, ({ extensionEnabled }) => {
    const next = !extensionEnabled;
    syncSet({ extensionEnabled: next });
    setToggleUI(next);
  });
});

document.getElementById('refreshFilters').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(tabs[0].id, { type: 'refreshFilters' });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.fr24Filters) {
    filters = changes.fr24Filters.newValue || [];
    renderFilters();
  }
});

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('[id^="tab-"]').forEach(p => p.style.display = 'none');
    document.getElementById('tab-' + btn.dataset.tab).style.display = '';
  });
});

load();
