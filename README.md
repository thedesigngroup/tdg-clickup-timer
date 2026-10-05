# TDG Timer

A small Mac app that logs time straight onto ClickUp tasks. It works like TMetric, except the time is saved in ClickUp itself.

- Open TDG Timer (it sits in your Dock), type a few letters, press **Enter** and the timer starts on that task.
- Starting another task stops the current one.
- No task for it yet? Type the name and choose **Create task** (or press ⌘T). Pick the List and it's created in ClickUp, assigned to you, with the timer running.
- **＋ Add time** logs time you forgot to track ("1h 15m", "1:15", "45m" or "1.5h").
- If you walk away while a timer is running, it asks whether to keep or remove that time.
- It stays in sync with ClickUp's own timer, so a timer started in the browser shows up here too.
- Nothing is set up per Space or List. It reads your workspace live from ClickUp, so new Spaces, Lists and tasks show up on their own (it refreshes every 10 minutes, or press ↻).

## Install (each person, once)

Open **Terminal** and paste:

```
curl -fsSL https://raw.githubusercontent.com/thedesigngroup/tdg-clickup-timer/main/install.sh | bash
```

TDG Timer opens by itself. Paste your ClickUp API token. To get it in ClickUp, click your avatar → **Settings** → **Apps** → **API Token** → **Generate**.

Running the same command again reinstalls the latest version.

## Shipping an update

1. Change the code and push it to `main`.
2. On GitHub, go to **Actions** → **Release** → **Run workflow**. You can leave the version blank and it will bump automatically.

Each person's app checks for updates every few hours and shows an **Install & restart** banner. They can also check right away under Settings → **Check for updates**.

## Keyboard

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move through tasks |
| Enter | Start timer on the selected task |
| Esc | Clear search / close |
| ⌘T | Create a new task (and start the timer on it) |
| ⌘N | Add time manually |
| ⌘, | Settings |

## Notes

- Each person uses their own ClickUp token. It's stored only on their Mac (`~/Library/Application Support/TDG Timer/settings.json`, readable only by them).
- The app isn't Apple-notarized, which is why it's installed with the Terminal command instead of a download.
- To run it from source: `npm install` then `npm start`. To run the UI tests: `node test/ui.test.js` (needs Playwright).
- Close the window and the app keeps running (click the Dock icon to bring it back). Quit with ⌘Q. A running timer shows on the Dock icon and in the window title.
