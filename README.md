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

## Known limitations
- Editing/back-dating an entry does not recalculate `floatOwedAfter` on later entries.
- Receipt photos upload before the entry saves; if the save then fails, the uploaded files stay in Drive.
- Flat fees below the day's gross are not carried forward.

## Password
Change `APP_PASSWORD` in `index.html` if needed.
