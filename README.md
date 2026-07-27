# FR24 Filter Colours

A browser extension (Chrome and Firefox) that colour-codes aircraft on [Flightradar24](https://www.flightradar24.com) by filter group, so you can instantly see which of your filters an aircraft belongs to without having to enable filters one at a time.

It also marks airports from your filters directly on the map, colour-coded by country.

<img width="984" height="574" alt="Screenshot 2026-07-09 at 10 58 54" src="https://github.com/user-attachments/assets/9e262dc4-78fa-42ba-92c3-0a1a36179c17" />
<p align="center">
  <img width="318" height="506" alt="Screenshot 2026-07-09 at 10 56 08" src="https://github.com/user-attachments/assets/ea2d73f4-ccd5-4631-86f7-7882a32f9eb3" />
  <img width="312" height="264" alt="Screenshot 2026-07-09 at 10 56 22" src="https://github.com/user-attachments/assets/225cff05-e31f-4835-85ec-9a36ce4426c6" />
</p>

---

## What it does

- Draws a **coloured ring** around each aircraft that matches one of your FR24 filters
- Shows a **label** to the left of the ring with the aircraft's altitude and colour group name
- Draws a **coloured dot** on airport locations from your FR24 Airport filter conditions, colour-coded by country
- Marks **claimed airports** with a gold ring overlay (airports you've unlocked in Skycards)
- Colour groups and filter assignments **sync across devices** via your browser account

The extension is **display-only**: it reads your existing FR24 filters and aircraft positions, but never creates, modifies, or deletes anything on FR24.

---

## Requirements: check your FR24 map settings first

The extension can only colour what FR24 actually sends to your browser, and FR24 only sends the fields its own display needs. **If the data a filter matches on is switched off in FR24's own settings, that filter silently colours nothing** - there is no error and no warning, the rings simply never appear.

Before setting anything else up, open FR24's map settings and turn on:

| FR24 setting | Required for |
|---|---|
| **Aircraft labels** on, with **Registration** ticked in its dropdown | Registration filters, and the registration shown on the extension's own labels |
| **Aircraft labels** on, with **Route** ticked in its dropdown | Airport filters, both origin and destination matching |
| **Aircraft labels** on, with **Type** ticked in its dropdown | Aircraft type filters (e.g. `C152`, `B738`) |
| **Airline logos** (or show logo on hover) | Exact "painted as" airline matching; without it, "painted as" falls back to callsign matching |

If you change any of these while FR24 is already open, reload the page.

---

## Installation

This is an unpacked extension; it isn't on the Chrome Web Store or Firefox Add-ons.

### Chrome

1. Download or clone this repository
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the folder containing this extension
5. Navigate to [flightradar24.com](https://www.flightradar24.com). The extension activates automatically

> **Syncing across devices:** because this is an unpacked extension, both installs must use the same copy of the folder (e.g. via Google Drive). The `"key"` field in `manifest.json` ensures both Chrome installs share the same extension ID so `chrome.storage.sync` works correctly across them. This field is Chrome-specific and is ignored by Firefox.

### Firefox

Firefox requires version 121 or later (released January 2024).

1. Download or clone this repository
2. Go to `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…** and select `manifest.json` inside the extension folder
4. Navigate to [flightradar24.com](https://www.flightradar24.com)

> **Note:** Firefox temporary add-ons are removed when the browser is closed. For a persistent install you would need to sign the extension via [Mozilla's self-distribution process](https://extensionworkshop.com/documentation/publish/self-distribution/). Sync via `browser.storage.sync` works if you are signed into Firefox Sync.

### About the `"key"` field in manifest.json

Unpacked extensions in Chrome normally get a random ID each time they are loaded, which would break sync because Chrome namespaces storage by extension ID. The `"key"` field is an RSA public key that Chrome uses to derive a stable, consistent ID instead.

It is safe to share publicly; it is the public half of a key pair and reveals nothing sensitive. See the [Chrome extension documentation](https://developer.chrome.com/docs/extensions/reference/manifest/key).

To generate your own stable ID:

```bash
openssl genrsa 2048 | openssl rsa -pubout -outform DER | openssl base64 -A
```

Paste the output as the `"key"` value in `manifest.json`.

---

## Setup

### 1. Create colour groups

Click the extension icon to open the popup. Under **Colour Groups**, click **+ Add group**, give it a name (e.g. `Austria`), and pick a colour. You can also click **From filters** to generate one group per filter automatically.

### 2. Assign filters to groups

The **Filters** tab lists all your FR24 filters. Use the dropdown next to each filter to assign it to a colour group. Filter changes are picked up automatically; click **↺ Refresh** to force a re-read.

> **Filters not showing?** Open [flightradar24.com](https://www.flightradar24.com) first; the extension reads the filter list from the FR24 page. The popup will show "Open flightradar24.com first to load filters" until then.

> **Renamed or deleted a filter?** If you delete and recreate a filter in FR24, it gets a new ID; reassign it to a colour group in the popup. Renaming a filter is fine and picks up automatically.

### 3. Airport dots

FR24 filters that use **Airport** conditions automatically have those airports marked on the map. The dot colour comes from a **colour group whose name matches the airport's country**, not which filter the airport is in.

So if you have a group named `Austria` with a red colour, all airports in Austria that appear in your filters will show as red dots.

- **Show all airport dots:** also shows airports with no matching colour group, using the default colour
- **Default colour:** colour used for unmatched airports when "show all" is on (defaults to red)

### 4. Claimed airports

The **Airports** tab has a **Claimed Airports** section. Add IATA codes for airports you've unlocked in Skycards; they appear on the map as a gold ring overlay. These sync across devices via your browser account.

---

## Settings tab

The Settings tab contains an optional integration with MapTrack, a private companion service currently in early alpha and not yet publicly available. If you haven't been given access, all fields on this tab can be left blank and the extension works fully without it.

---

## File reference

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3, Chrome and Firefox 121+) |
| `background.js` | Service worker; handles optional server communication and message routing |
| `content.js` | Bridge between the FR24 page and the service worker |
| `injected.js` | Runs in the FR24 window context; hooks the aircraft store, runs filter matching, draws the map overlay |
| `popup.html` / `popup.js` | Three-tab popup: Filters, Airports, Settings |

---

## Notes

- The extension never creates, modifies, or deletes anything on FR24. It reads filter and aircraft data from the page, and may make read-only requests to the FR24 filter API to keep its local state in sync when you make changes in the FR24 UI.
- Disabling a filter in the FR24 UI hides its aircraft and airport dots in the extension automatically.
- The **On/Off** button pauses the extension (hides all dots) without uninstalling it.
- If dots aren't showing after installing on a new device, fully quit and restart the browser.
- The filter list is populated from the FR24 page; you must have [flightradar24.com](https://www.flightradar24.com) open before the popup can show filter assignments.
- **Airline filters:** "painted as" filters match the aircraft's actual livery only when **airline logos** are enabled in FR24's own map settings (see [Requirements](#requirements-check-your-fr24-map-settings-first)). Without logos, "painted as" falls back to callsign matching, which reflects who is *operating* the flight and can mismatch when an aircraft flies for an airline other than its livery. "Operating as" filters always match by callsign; the rare flight using a non-standard callsign (some charters/ferry flights) may be missed.

---

## Performance

The extension processes every aircraft position update from FR24 and redraws its overlay on every map pan or zoom. Airport dots are viewport-culled: only dots inside the current map view are positioned, and off-screen dots are hidden rather than destroyed, so panning remains smooth even with **Show all airport dots** enabled.

Under normal use the overhead is negligible. FR24's **show all aircraft** mode can still put thousands of aircraft on screen and cause FR24 itself to lag, but that is a FR24 limitation rather than an extension one.

---

## Skycards use case

This extension was built with the [FR24 Skycards](https://www.flightradar24.com/skycards) game in mind. A typical setup:

- One colour group per country you're working on
- Airport filters for each country (e.g. `Europe - A:G`) containing the airport codes for airports you still need to unlock; these appear as coloured dots on the map so you can see at a glance which airports to watch
- Registration or airline filters to highlight aircraft known to serve those airports
- Airports you've already unlocked go in **Claimed airports** so their locations are still visible on the map with a gold ring
