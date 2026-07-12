const PRESETS = ['#ffadad','#ffd6a5','#fdffb6','#caffbf','#9bf6ff','#a0c4ff','#bdb2ff','#ffc6ff'];

let groups        = [];
let filters       = [];
let assignments   = {};
let claimedAirports = [];

function setToggleUI(enabled) {
  const btn = document.getElementById('toggleEnabled');
  btn.textContent       = enabled ? 'On' : 'Off';
  btn.style.background  = enabled ? '#22c55e' : '#ef4444';
  btn.style.color       = '#fff';
  btn.style.borderColor = enabled ? '#16a34a' : '#dc2626';
}

async function load() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(['groups', 'assignments', 'showAllAirports', 'defaultAirportColor', 'extensionEnabled', 'claimedAirports']),
    chrome.storage.local.get(['fr24Filters']),
  ]);
  filters         = local.fr24Filters    || [];
  assignments     = sync.assignments     || {};
  groups          = sync.groups          || [];
  claimedAirports = sync.claimedAirports || [];
  document.getElementById('showAllAirports').checked   = sync.showAllAirports    || false;
  document.getElementById('defaultAirportColor').value = sync.defaultAirportColor || '#ff3b3b';
  setToggleUI(sync.extensionEnabled !== false);
  render();
}

document.getElementById('showAllAirports').addEventListener('change', e => {
  chrome.storage.sync.set({ showAllAirports: e.target.checked });
});
document.getElementById('defaultAirportColor').addEventListener('input', e => {
  chrome.storage.sync.set({ defaultAirportColor: e.target.value });
});

function save() {
  chrome.storage.sync.set({ groups, assignments });
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
      chrome.storage.sync.set({ claimedAirports });
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

function uid() {
  return crypto.randomUUID();
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addClaim() {
  const input = document.getElementById('claimInput');
  const codes  = input.value.trim().toUpperCase();
  for (code of codes.split(/[\s,]+/)) {
    if (code && !claimedAirports.includes(code)) {
      claimedAirports.push(code);
    }
  }
  chrome.storage.sync.set({ claimedAirports });
  input.value = '';
  renderClaimed();
}

document.getElementById('addClaim').addEventListener('click', addClaim);
document.getElementById('claimInput').addEventListener('keydown', e => { if (e.key === 'Enter') addClaim(); });
document.getElementById('clearClaims').addEventListener('click', () => {
  claimedAirports = [];
  chrome.storage.sync.set({ claimedAirports });
  renderClaimed();
});

document.getElementById('toggleEnabled').addEventListener('click', () => {
  chrome.storage.sync.get({ extensionEnabled: true }, ({ extensionEnabled }) => {
    const next = !extensionEnabled;
    chrome.storage.sync.set({ extensionEnabled: next });
    setToggleUI(next);
  });
});

document.getElementById('refreshFilters').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    chrome.tabs.sendMessage(tabs[0].id, { type: 'refreshFilters' });
  });
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
