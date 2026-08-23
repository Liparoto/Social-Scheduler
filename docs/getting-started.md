# Getting started

**For someone setting up SocialScheduler on their own computer for the first time.**
No programming needed. You will use the Terminal (Mac) or Command Prompt (Windows) a
handful of times, and every command you need is written out to copy.

Works on **Mac and Windows**. Where they differ, both are shown.

---

## What you're actually setting up

SocialScheduler runs **entirely on your own computer**. There is no website to sign into,
no account to create, no subscription. You write and schedule posts in a page that opens in
your browser, and a background program publishes them at the times you picked.

That has one consequence worth understanding up front:

> **Your computer must be awake and running for a post to go out.** If it's asleep at 9am,
> the 9am post goes out when you next wake it — not at 9am. Nothing is lost, it's just late.

Your posts, images, and passwords never leave your machine. Nobody else — including whoever
gave you this — can see them or post to your accounts.

**Roughly an hour**, most of it in Part 4. Parts 1–3 are mostly waiting for downloads.

---

## Part 1 — Install two free programs

SocialScheduler is built on two pieces of software you probably don't have yet. Install both,
then restart your computer.

1. **Node.js** — https://nodejs.org — take the big green **LTS** button.
2. **Python** — https://python.org/downloads — take the big yellow **Download Python** button.
   - **On Windows:** on the very first installer screen, tick **"Add Python to PATH"** at the
     bottom before clicking Install. It's easy to miss and things fail later without it.
   - **On Mac:** after installing, open the `Python 3.x` folder in Applications and
     double-click **Install Certificates.command**. Skipping this makes downloads fail later
     with confusing security errors.

Restart your computer once both are done.

---

## Part 2 — Get the code

**Mac:** press `Cmd + Space`, type `Terminal`, press Enter.
**Windows:** press the Start key, type `cmd`, press Enter.

A window with a text prompt appears. Type this and press Enter:

```
cd Documents
```

Then:

```
git clone https://github.com/Liparoto/Social-Scheduler.git
```

That creates a **Social-Scheduler** folder inside your Documents — your own private copy.

> **Windows:** if it says `git` is not recognized, install Git from https://git-scm.com/download/win
> (all default options), close the window, open a new one, and run the two commands again.

> **Don't use GitHub's green "Download ZIP" button.** It looks equivalent and isn't — the
> update button will never work afterwards.

---

## Part 3 — Start it for the first time

Open the **Social-Scheduler** folder in Documents and double-click:

- **Mac:** `Start-SocialScheduler-Mac.command`
- **Windows:** `Start-SocialScheduler-Windows.bat`

> **Mac:** the first time, macOS may refuse to open it. Right-click the file → **Open** →
> **Open**. You only do this once.

A window opens and prints a lot of text for several minutes — it's downloading everything it
needs. When it finishes, your browser opens to **http://localhost:3939** and the window
closes itself. That's normal: it keeps running in the background.

**You can't post anything yet, and you can't break anything either.** A fresh install starts
in dry-run mode, where it pretends to publish and writes what it *would* have done to a log.
It stays that way until you deliberately change it in Part 6.

Have a look round. Nothing you click here will post to the internet.

---

## Part 4 — Connect your first account

This is the fiddly part, and it isn't your fault. Meta (Facebook and Instagram's owner)
requires every install to register as a "developer app" — even a private one only ever used
on your own accounts. It's free and doesn't need approval, but the wording is aimed at
software companies and the buttons move around.

**Set aside 30–40 minutes and follow `docs/meta-setup.md` exactly.** Don't skim it. It is
written step by step and is kept current against Meta's actual screens.

Things worth knowing before you begin:

- **Instagram must be a Professional account** (Business or Creator). Free to switch, in the
  Instagram app: Settings → Account type and tools. Personal accounts cannot post this way,
  and there's no workaround.
- **Facebook needs a Page** — not your personal profile. Facebook removed personal-profile
  posting entirely. A Page is free at facebook.com/pages/create; a category like
  *Digital Creator* is fine.
- **You need your own Meta app.** You can't reuse someone else's, even a family member's.
  Each install is completely separate by design.
- **Access tokens expire, quietly.** This is the thing that catches everyone. The first token
  Meta hands you lasts about an hour, and nothing tells you — it works, then it doesn't. The
  setup guide has you run one command that swaps it for a lasting one. **Don't skip it**, and
  don't copy a token straight out of Meta's tools.

**Just posting to Discord or Telegram?** None of the above applies — see
`docs/other-platforms-setup.md`, which takes about five minutes.

Once a channel is added, check it from the Social-Scheduler folder:

```
.venv/bin/python -m worker.preflight
```

*(Windows: `.venv\Scripts\python -m worker.preflight`)*

A `✓` means the connection works. This posts nothing.

---

## Part 5 — A pretend post first

Before anything real: schedule a post for a few minutes from now and let dry-run mode catch
it. In the dashboard, compose a post, pick your channel, schedule it, and wait.

Then open `data/logs/worker.log` inside the Social-Scheduler folder. You should see the
worker describing exactly what it would have published. **Nothing was sent.**

This proves the whole chain works — schedule, image, account, timing — while a mistake still
costs nothing.

---

## Part 6 — Go live

In the Social-Scheduler folder, open the file called **`.env`** in TextEdit (Mac) or Notepad
(Windows). Find this line:

```
DRY_RUN=1
```

Change it to:

```
DRY_RUN=0
```

Save the file. **That's it — no restart.** SocialScheduler re-reads this setting every
30 seconds while running, so the change takes effect on its own. The same is true of the
kill switch below, which is the point: an emergency stop you have to restart for isn't one.

**It now posts for real.** Schedule one post, watch it publish, and check it on the actual
account before trusting it with a week of content.

---

## Day to day

| To do this | Double-click |
|---|---|
| Start it | `Start-SocialScheduler-Mac.command` / `-Windows.bat` |
| Stop it | `Stop-SocialScheduler-Mac.command` / `-Windows.bat` |
| Get the latest version | `Update-Mac.command` / `Update-Windows.bat` |
| Back everything up | `Export-Mac.command` / `Export-Windows.bat` |

The dashboard lives at **http://localhost:3939** whenever it's running. Bookmark it.

SocialScheduler also starts itself each time you log in, so it survives a restart — otherwise
a reboot would silently stop everything with nobody there to click Start.

**The emergency stop:** open `.env`, set `KILL_SWITCH=1`, save. Everything goes quiet
immediately — no restart needed, nothing publishes, and scheduled posts simply wait. Set it
back to `0` to resume. Use this whenever you're unsure; nothing is lost.

**Back up now and then.** Export writes everything into a dated folder in your Documents that
you can drag into Google Drive or Dropbox. It deliberately leaves your passwords out, so the
folder is safe to keep in the cloud — but it also means reconnecting your accounts if you ever
restore onto a new computer.

---

## When something goes wrong

**A post says "Blocked" or "Failed" in the queue.** Read the red text under it, then run:

```
.venv/bin/python -m worker.exchange_token --check
```

Most failures are the access token — expired, or missing a permission. That command says
exactly which, and changes nothing. See *"When a token misbehaves"* in `docs/meta-setup.md`.

**Posts publish late, or not until you open the laptop.** Expected — see the top of this page.
Your computer has to be awake. If that doesn't suit how you work, say so; scheduling that runs
with the machine off is a known wish, not a bug.

**Metrics all show zero.** Metrics only update while SocialScheduler is running, and refresh
every few hours rather than instantly. Leave it running a day before worrying.

**Nothing happens at all when you double-click Start.** Open `data/logs/worker.log` and read
the last 20 lines. If that file doesn't exist, the two programs in Part 1 probably didn't
install correctly — the most common cause on Windows is the missed **"Add Python to PATH"**
tickbox.

**Something else.** `data/logs/worker.log` is the file to look at, and the last lines are the
useful ones. It's plain English more often than you'd expect.
