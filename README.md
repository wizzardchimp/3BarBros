# 3BarBros — Daily Takings

New takings app (separate from BL) with:

- **Editable sites** (add / rename / remove) stored on Google Sheet **Rates** tab  
- **Per-category float** (Reels / Digital; never pool) with **carry-forward** when float &gt; gross  
- MGD (20%), supplier share, site share calculated on **net** (gross − float taken)  
- History, monthly summary, last-21-days totals  
- Password gate (default: `bl26`)

## Live

After Pages is enabled: `https://wizzardchimp.github.io/3BarBros/`

## Setup

### 1. Google Sheet
Create a spreadsheet with tabs (or let the script create them):
- **Data** — Date | Timestamp | JSON (live working copy; can delete/edit)  
- **Rates** — ConfigJSON  
- **LoginLog** — optional  
- **MasterLog** — append-only audit of every submit (Date, Site, Category, Gross, Float, Net, …). Not cleared when Data is deleted.  

Optional backfill of old Data rows: in Apps Script, run function `backfillMasterLogFromData` (skips entries already in MasterLog, so it is safe to re-run).

### 2. Apps Script
1. Extensions → Apps Script  
2. Paste `Code.gs`  
3. Deploy → New deployment → Web app  
   - Execute as: Me  
   - Who has access: Anyone  
4. Copy the `/exec` URL  

### 2b. Lock down the API (recommended)
The web app is deployed as "Anyone", so the `/exec` URL is the only barrier. To require a shared secret:
1. Apps Script → Project Settings → **Script properties** → add `API_TOKEN` = a long random string  
2. In the app: Settings → **API access token** → enter the same value → Save  

When `API_TOKEN` is unset the API stays open (previous behaviour). The in-app password (`APP_PASSWORD`) is only a UI gate — it is visible in the page source and is **not** real security.

Server-side safeguards: writes are serialised with a script lock; submits are idempotent by entry id (a retried POST can't create a duplicate); `clear` needs an explicit confirm flag; `delete` needs an id/timestamp; `deletePhoto` only trashes files inside the receipts folder.

### 3. App Settings
1. Open the site → log in (`bl26`)  
2. Settings → paste API URL → Save  
3. Add sites / categories / float amounts → **Save to Sheet**  

## Float rules
- `toRecover = floatRequired + floatOwed (carry-in)`  
- `floatTaken = min(gross, toRecover)`  
- `net = gross − floatTaken`  
- MGD / rate splits on **net** only (site share % vs supplier % in Settings)  
- `floatOwedAfter` carries to the next collection for that **location + category**  
- Pool: no float (rent or 50/50 as configured)  

## Settings page
Five sections (sticky tabs): **Sites & rates**, **Data**, **Connection**, **Preferences**, **Danger zone**. A status line at the top shows whether the sheet is connected, how many entries loaded and when (or why it failed).
- **Sites & rates:** the saved-sites list comes first, with **+ Add site** opening the form below it. Each site shows its rates in force today, any *scheduled* future changes, and a *Rate history* you can prune. Per site: **Edit**, **Duplicate** (copies the setup under a new name), **Archive** (hides it from Daily Entry but keeps its history; restore any time) and **Remove**. Category names show which filter type they fall under (Reels / Digital / Pool / own type). MGD schedule and a *Recent changes* log (when and what; stored with your settings) sit below.
- **Data:** export all entries, **settings backup & restore** (JSON of sites, rates, dated changes and MGD — a backup of the current settings downloads automatically before a restore), merge sites, and recalculate float.
- **Connection:** **Test connection** checks the URL/token you typed without saving anything; **Save & load data** stores them and loads your entries.
- **Preferences (this device only):** default History/Summary period, and whether to show *Below usual* flags and at what percentage. The About card shows the app version.
- **Danger zone:** delete the most recent collection (shows which one) and clear this device's saved settings (nothing on the sheet is deleted). All confirmations use the in-app popup.

## Types (machine filter)
The **Type** filter groups machines as: **Reels**; **Digital** (anything named Digital, Inspire or GM); **Pool**. They are separate types for filtering, breakdowns, the Summary "By type" table and the float-owed panel. Collection cards still list the real machine names (Inspire, GM…). Any other category name (e.g. Jukebox) is its own type. The rule lives in `machineType()` in `logic.js`.

## History page
Filter by period (this/last business month, 21 days, 3/6/12 months, all, or any specific month), site and type (Reels / Digital / Pool). Shows KPI tiles (with change vs the previous month when a single month is selected), a 12-month net chart (tap a bar to view that month), a breakdown by site or machine, and collapsible collection cards grouped by business month. A collection is marked *Below usual* when its gross is under half the average of that site and machine's previous collections (needs at least 5 earlier ones). "Export this view" downloads exactly what the filters show. Filters are remembered per device.

## Summary page
Uses the same Period / Site / Machine filters as History (shared and remembered), so both pages always agree. Shows the KPI tiles, a 12-month chart of net split into site share vs supplier (tap a bar to filter to that month), **month-end statements** (tap a month for a per-site table with totals and a *View these collections* shortcut to History), totals by site and by machine (tap a name to jump to its collections in History), and **float still to recover** per site and machine as of their latest collections. The month still in progress is labelled and has no % change, since it would be compared with a full month. *Export summary (CSV)* gives month × site totals for the current filters.

## Dated rates (effective dating)
- **MGD** is a global rate with a dated schedule (Settings → *MGD rate*). Add a change with an *Apply from* month; earlier months keep the old rate.
- **Site shares, flat fee, pool rent / pool %** are dated per site: when editing a site, set *apply from* (a business month). Leave it blank only to correct a mistake in the current value.
- **Business month:** collections on the 6th up to the 5th of the next month belong to that month (29 Sep, 30 Sep, 2 Oct, 4 Oct → September; 6 Oct → October).
- A collection uses the rates in force for its own date, so back-dated entries pick up the right rates. Submitted entries store their calculated figures and are never recalculated.
- Takings and float amounts are entered per collection and are not dated.
- Logic lives in `logic.js`; run the tests with `node tests/logic.test.js`.

## Recalculate float from a date
Settings → *Recalculate float from a date*. Pick a from date (and optionally one site), press **Preview changes**, and you'll see every collection that would change (float carried in, net, site share) with before/after totals. **Apply** then saves them to the sheet, after downloading a JSON backup of the original entries.
- Re-runs the float rules in date order per site and machine, starting from the float carried out of the last collection *before* the date.
- Gross takings are never changed. Each collection keeps its saved share %, flat fee and float required; MGD uses the dated rate for each collection's date.
- Safe to re-run: when the data is already consistent it reports *Nothing to change*.
- The MasterLog audit sheet is append-only and keeps the figures as first submitted.

## Releasing front-end changes
`logic.js` is loaded as `logic.js?v=<version>` and `index.html` checks `REQUIRED_LOGIC_VERSION`. When you change `logic.js`, bump `LOGIC_VERSION` in `logic.js` **and** both values in `index.html` together (`node tests/version.test.js` fails if they drift). This stops a phone/browser that cached the old `logic.js` from rendering blank History/Summary pages. If it ever does mismatch, the page reloads once and then shows a red banner instead of failing silently.

## Known limitations
- Editing, deleting or back-dating an entry does not automatically fix the float carried into later entries — run *Recalculate float from a date* in Settings afterwards.
- Receipt photos upload before the entry saves; if the save then fails, the uploaded files stay in Drive.
- Flat fees below the day's gross are not carried forward.

## Password
Change `APP_PASSWORD` in `index.html` if needed.
