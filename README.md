# ⚔️ Quest Log

A simple, gamified brain-dump + to-do + habit tracker for iPhone, built as an installable web app (PWA).
No accounts, no server — your data stays on your phone.

## How it works

| Tab | What it's for |
| --- | --- |
| **☀️ Today** | Your 1–3 focus items for the day, today's habits, and what you've finished. Unfinished items from earlier days show up under *From before* — keep them or send them back, no guilt. |
| **📥 Inbox** | Where every quick thought lands. Tap **＋** anywhere to dump stuff in (one per line). Tap an item to send it to Today or a list. Clear it for bonus XP. |
| **🗂 Lists** | Someday/maybe buckets: Life Progress, Errands, Projects, Other — or make your own. |
| **🔁 Habits** | Recurring things (workout, ride bike, cook). Pick which days, build 🔥 streaks. Tap any of the last 7 days to fix a forgotten check-in. |

Finishing tasks gives **+10 XP**, habits **+5 XP**, inbox zero **+20 XP**. Every 100 XP is a level.

**⚙️ Settings → Import from Apple Notes** — paste a whole note. `- [ ]` checklists get sorted into lists by their
section headers, loose jot-downs go to the Inbox, and runs of tracking numbers get bundled into one
"📦 Track packages" task with the numbers in its note. You get a preview to uncheck anything first.

## Screenshots → notes

In the **＋ Brain dump** sheet, tap **📷 Add a screenshot** (or paste an image on a PC), optionally type a few words,
and tap **Add**. The app reads it and creates a task, then opens it so you can tweak it.

- **Basic reading** (default, free): on-device text recognition copies the text off the image.
- **Smart reading** (⚙️ → Reading screenshots): add your own Anthropic API key and Claude writes a clean title,
  keeps only the useful details (dates, prices, addresses, order numbers), pulls out links, and picks the list.
  Roughly 2–3¢ per screenshot. The key is stored only on that device and is never synced or backed up.

## Phone + PC sync

**⚙️ Settings → Sync between devices.** Make a GitHub token with only the `gist` permission, paste it in,
and do the same on your other device. Your data is stored in a private (secret) gist named `questlog.json`.
The app pulls changes whenever you open or switch back to it, and pushes a couple of seconds after each change.
Edits are merged record by record (newest change wins), so using both devices offline doesn't wipe anything out.

On a PC, just open the site in any browser (Chrome/Edge can also "Install" it as an app). Press **N** to brain-dump.

## Install on iPhone

1. Host it (see below) and open the URL in **Safari**.
2. Tap **Share** → **Add to Home Screen**.
3. Open it from the home-screen icon — it runs full-screen and works offline.

> Data is stored on the device in the home-screen app. Use **⚙️ → Back up my data** once in a while
> (saves a file you can put in iCloud Drive).

## Hosting with GitHub Pages

Repo **Settings → Pages → Build and deployment → Deploy from a branch**, pick the branch and `/ (root)`, save.
A minute later it's live at `https://<username>.github.io/<repo-name>/`.

## Developing

It's plain HTML/CSS/JS — no build step.

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

- `index.html` — page shell
- `styles.css` — all styling (light + dark mode)
- `app.js` — state, rendering, actions, Notes importer
- `sw.js` — offline cache (bump `CACHE` when shipping changes so phones pick them up)
- `manifest.webmanifest`, `icons/` — install metadata

## Ideas for later

- Reminders / notifications
- Due dates & recurring tasks ("pay rent every 1st")
- Rewards shop: spend XP on treats you define
