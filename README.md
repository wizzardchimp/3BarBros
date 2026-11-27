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

## Daily Entry page (mobile-first)
- **Last 21 days** panel at the top: net, site share and collections with the change vs the prior 21 days, a bar chart of net per day, and a collapsible per-site breakdown (MGD, supplier, site share). Tap the heading to **collapse it to one line** (remembered on the phone). *History →* jumps to that period.
- **Site cards** show when each site was last collected (⏰ after its own overdue limit, red a week later), its 21-day net with a share bar and trend, and any float still to recover.
- **Form:** one compact card per machine: the gross field with the machine's *usual amount* beside the label (a ⚠ check appears when a figure is far from usual, e.g. an extra zero), then live **Net / Site / Supplier / MGD** in a single row. **Float to recover** is tucked behind a *+ Add float to recover* button (it opens by itself when the field already has a value, e.g. a restored draft or an edit); float carried in from earlier collections is always shown. Pool has its own card, and receipts are one row. On a desktop the machine cards sit two across. Enter jumps to the next visible field.
- **Date chips** (Today / Yesterday / pick) show which business month it counts toward and warn for future or long back-dated entries.
- **Sticky bar** at the bottom keeps the live total and the **Review →** button in thumb reach. The review sheet shows the breakdown, any unusual-amount warnings and receipts before saving.
- **After saving:** a *Saved* banner with **Undo** and **Next: <site>**, and the dashboard updates immediately.
- **Unsent figures are kept** on the phone (per site and date) if the signal drops or the tab closes, and restored when you come back.

## Works without signal, and installs like an app
- **Install:** open the site on your phone and choose *Add to Home Screen* (iPhone: Share → Add to Home Screen; Android: menu → Install app). It opens full screen with its own icon.
- **No signal:** the app opens from the data saved on the phone. A collection that can't be sent is **kept on the phone and sent automatically** when signal returns (also when you reopen the app, and every 30 s while waiting). A banner shows what is waiting; **Send now** forces a try. The sheet de-dupes by collection id, so a lost reply never creates a duplicate. Float is worked out from the saved data, and you are prompted to recheck it after the collection arrives.
- **Receipts** upload as soon as you add them (✓ sent); removing one deletes it from Drive. If a receipt can't upload, it travels with the queued collection.
- **Float recheck prompt:** after a collection is added late, back-dated, edited or deleted, a banner offers *Review* (opens Recalculate float from that date).
- **Edit a saved collection:** History → open a card → **Edit**. It reopens in the entry form, saves in place (same id) and recalculates with that date's rates. (The MasterLog audit sheet keeps the figures as first submitted.)
- **Next site:** after saving, the banner offers the next site not yet collected that day.

## Signing in with a PIN (optional, recommended)
By default the app uses one shared password that is visible in the page source. To give each person their own PIN:
1. Open the Google Sheet → menu **3BarBros → Add person / reset PIN** → name and PIN (4–12 letters/numbers). The menu appears after you paste the new `Code.gs` and reload the sheet.
2. The moment the **first** person is added, sign-in becomes **required for the whole API** (reads and writes). Add everyone who needs access, or they are locked out.
3. People enter their name + PIN once; the phone stays signed in for 30 days (Settings → Connection → *Sign out*). Activity logs and notification emails then show the **verified** name.
4. Five wrong PINs lock that name for 15 minutes and email you. PINs are stored hashed in the **Users** tab, never in plain text. **3BarBros → Remove person** revokes access (their phone token stops working at expiry; reset their PIN to cut access immediately only after removing them).
5. Emergency off-switch: Script Property `AUTH` = `off` restores the old shared-password behaviour.

## Backups
- **Back up now** (Settings → Data) saves a full copy of the sheet to the Drive folder **3BarBros Backups**; the newest 14 are kept. The app warns if the last backup is over 3 days old.
- **Nightly backup:** in the sheet choose **3BarBros → Turn on daily backup** (about 3am). If a backup fails you get an email.

## Email notifications (login + what they did)
The owner of the Google Sheet is emailed when someone **logs in** (name from the login box, device, time) and gets a **digest of what they did** (collections saved / edited / deleted, settings changed) about 5 minutes after it starts. **Clear all** is emailed immediately. Every action is also written to the **ActivityLog** tab. The names are entered at login so they say *who*, but they are not authentication (the password is shared).

One-time setup:
1. Apps Script → paste the latest `Code.gs`.
2. Run **`__authMail`** once from the editor and accept the permissions (send email, triggers).
3. Deploy → Manage deployments → edit → **New version**.
4. In the app: Settings → Connection → **Send test email**.

Script Properties (optional): `NOTIFY_EMAIL` (send elsewhere), `NOTIFY` = `off` (pause emails; logging continues). A cap of 25 emails/day protects your Gmail quota. If emails can't be sent (e.g. permission not granted) saving is never affected. If running `__authMail` fails with *“Specified permissions are not sufficient … script.send_mail”*, your project has a manifest with a fixed `oauthScopes` list. In Apps Script: Project Settings (gear) → tick **Show “appsscript.json” manifest file in editor**, open `appsscript.json`, and either delete the whole `oauthScopes` block (Apps Script then works the permissions out from the code) or add these three lines to it (keep the others, mind the commas):
```
"https://www.googleapis.com/auth/script.send_mail",
"https://www.googleapis.com/auth/script.scriptapp",
"https://www.googleapis.com/auth/userinfo.email"
```
Then run `__authMail` again and accept the new permissions.

## Settings extras
- **Overdue days per site:** each site has its own *Flag as overdue after N days* (default 14; red a week later) for the ⏰ marker on Daily Entry.
- **Appearance:** Preferences → Light / Dark / Match my phone, and *Large figures* for dim light (this device only). Dark mode is a simple inverted theme, so occasional colours may look slightly different from light mode.
- **Undo:** after changing a rate, MGD, archiving or removing a site, a *Saved — Undo* bar appears for 15 seconds.

## Settings page
Five sections (sticky tabs): **Sites & rates**, **Data**, **Connection**, **Preferences**, **Danger zone**. A status line at the top shows whether the sheet is connected, how many entries loaded and when (or why it failed).
- **Sites & rates:** the saved-sites list comes first, with **+ Add site** opening the form below it. Each site shows its rates in force today, any *scheduled* future changes, and a *Rate history* you can prune. Per site: **Edit**, **Duplicate** (copies the setup under a new name), **Archive** (hides it from Daily Entry but keeps its history; restore any time) and **Remove**. Category names show which filter type they fall under (Reels / Digital / Pool / own type). MGD schedule and a *Recent changes* log (when and what; stored with your settings) sit below.
- **Data:** export all entries, **settings backup & restore** (JSON of sites, rates, dated changes and MGD — a backup of the current settings downloads automatically before a restore), merge sites, and recalculate float.
- **Connection:** **Test connection** checks the URL/token you typed without saving anything; **Save & load data** stores them and loads your entries.
- **Preferences (this device only):** default History/Summary period, and whether to show *Below usual* flags and at what percentage. The About card shows the app version.
- **Danger zone:** delete the most recent collection (shows which one) and clear this device's saved settings (nothing on the sheet is deleted). All confirmations use the in-app popup.

## Types (machine filter)
The **Type** filter groups machines as: **Reels**; **Digital** (anything named Digital, Inspire or GM); **Pool**. They are separate types for filtering, breakdowns, the Summary "By type" table and the float-owed panel. Collection cards still list the real machine names (Inspire, GM…). Any other category name (e.g. Jukebox) is its own type. The rule lives in `machineType()` in `logic.js`.

## Month-end statements
In Summary, open a site and each business month has **Print / PDF** and **Share**. Print gives a clean one-page statement (every collection and machine, then net, MGD, supplier share and site share). Share uses your phone's share sheet (or copies the text). Statements always include all machines for that site and month, whatever the filters.

## History page
Filter by period (this/last business month, 21 days, 3/6/12 months, all, or any specific month), site and type (Reels / Digital / Pool). Shows KPI tiles (with change vs the previous month when a single month is selected), a 12-month net chart (tap a bar to view that month), a breakdown by site or machine, and collapsible collection cards grouped by business month, with **search** (date, site, machine or amount) and **sort** (newest, oldest, highest or lowest net). A collection is marked *Below usual* when its gross is under half the average of that site and machine's previous collections (needs at least 5 earlier ones). "Export this view" downloads exactly what the filters show. Filters are remembered per device.

## Summary page
Uses the same Period / Site / Type filters as History (shared and remembered), so both pages always agree. From the top: the KPI tiles, a 12-month chart of net split into site share vs supplier (tap a bar to filter to that month), then a **list of sites** for the filtered period (net, site share, supplier, collections, with an *All sites* total).

**Tap a site name** to expand one all-encompassing table in place (no jump to History): every collection grouped by business month (newest first), each machine in each collection (Reels, Digital, Inspire, GM…), month subtotals, totals by machine, and a grand total that matches the list. Receipt links are shown on the collection. With only one site it opens automatically. *Open in History* inside it is the only link out. **Machine trends:** under *Totals by machine* each machine has a small sparkline of its last collections and how the latest compares with the earlier average. When a single month is selected, each site also shows its change on the month before. The Type filter narrows the table to those machines.

Below that: **float still to recover** per site and machine as of the latest collections. The month still in progress is labelled. *Export summary (CSV)* gives month × site totals for the current filters.


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
`logic.js` is loaded as `logic.js?v=<version>` and `index.html` checks `REQUIRED_LOGIC_VERSION`. When you change `logic.js`, bump `LOGIC_VERSION` in `logic.js`, both values in `index.html` **and** `VERSION` in `sw.js` together (`node tests/version.test.js` fails if they drift). Run all checks with `node tests/logic.test.js && node tests/backend.test.js && node tests/version.test.js`. This stops a phone/browser that cached the old `logic.js` from rendering blank History/Summary pages. If it ever does mismatch, the page reloads once and then shows a red banner instead of failing silently.

## Known limitations
- Editing, deleting or back-dating an entry does not automatically fix the float carried into later entries — run *Recalculate float from a date* in Settings afterwards.
- Receipt photos upload before the entry saves; if the save then fails, the uploaded files stay in Drive.
- Flat fees below the day's gross are not carried forward.

## Password
Change `APP_PASSWORD` in `index.html` if needed.
