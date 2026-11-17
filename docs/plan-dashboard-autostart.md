# Plan: keep the dashboard running (macOS autostart for the dashboard)

## Why
On 2026-11-17 `localhost:3939` refused connections while System Settings showed
"SocialScheduler — Running in background". That login item is **only the worker**. The
worker had been fine the whole time (running since the Nov 11 boot, publishing normally).

The dashboard is started once by `Start-SocialScheduler-Mac.command` (`nohup npm run dev`)
and nothing watches it afterwards. Its log ended 2026-11-16 ~19:56 with a clean shutdown
(not a crash, and no reboot), and it stayed down until someone pressed Start again. This has
happened repeatedly.

Publishing never depends on the dashboard: the worker serves media to the tunnel from its
own `worker/asset_server.py`. So a down dashboard is an inconvenience, not a missed post.
But it looks broken, and it is the part you actually interact with.

## Decision: a second LaunchAgent, not one combined item
One launchd job can only watch one process. Folding both into a shared supervisor would
mean that whenever either stopped, both restarted. A dashboard hiccup would then restart
the worker, possibly mid-publish, which is exactly what Stop/Update work hard to avoid.
Two agents keep them independent. Start/Stop/Disable still treat them as one unit.

System Settings → Login Items will list two entries:
- **SocialScheduler**: the worker (unchanged)
- **SocialScheduler Dashboard**: new

## Design

### New: `dashboard/SocialScheduler Dashboard` (launcher wrapper)
Like `worker/SocialScheduler`, it exists so Login Items shows a readable name instead of
"node". It runs `cd dashboard && exec node_modules/.bin/next dev -p 3939`.
- `exec` launches Next directly (no `npm` middle process), so launchd's stop signal reaches
  the real server and no orphan keeps holding the port.
- It stays on **dev mode**, same as today. `Update-Mac.command` relies on the dashboard
  reloading new code by itself. Moving to `next build` + `next start` would be faster, but it
  is a separate change with its own update story, so it is out of scope here.

### New agent `com.socialscheduler.dashboard`
- `RunAtLoad` true, **`KeepAlive` true** (restart on *any* exit). This differs from the
  worker on purpose. Last night's outage was a *clean* exit, which the worker's
  restart-only-on-crash rule would not have caught.
- `ThrottleInterval` 30, so a broken dashboard retries every 30s instead of spinning.
- `PATH` includes `/opt/homebrew/bin:/usr/local/bin`, because launchd's default PATH has no `node`.
- Its own log, `data/logs/dashboard-launchd.out`, deleted before the plist is written. This
  avoids the same `com.apple.provenance` xattr trap the worker agent hit (exit 78 EX_CONFIG).

### `Start-SocialScheduler-Mac.command`
- Shared helpers so the dashboard agent is installed and checked the same way as the worker.
- **Migration for existing installs:** if 3939 is held by a hand-started (nohup) dashboard,
  stop it first, then bootstrap the agent. Otherwise launchd's copy fails with "port in use"
  and retries every 30s forever.
- Agent installed but not loaded (after Stop): `bootstrap` it again.
- Keep the existing "wait up to 90s for an answer, then open the browser" step.
- Fallback: if the agent cannot be registered, use today's `nohup` path so the install still
  works, and say so.

### `Stop-SocialScheduler-Mac.command`
- `launchctl bootout gui/$UID/com.socialscheduler.dashboard` **before** the port sweep.
  With `KeepAlive` true, killing the process alone would just make launchd bring it back.
  `bootout` unloads it for this session. The plist stays in `~/Library/LaunchAgents`, so it
  comes back at the next login, the same "Stop until next login" meaning the worker has.
- The existing port sweep and honest "still running" report stay as they are.

### `Disable-Worker-Autostart-Mac.command`
- Also boots out and deletes the dashboard agent. Messages updated to say "SocialScheduler
  autostart" instead of "worker autostart". The file name stays the same so nothing that
  points to it breaks.

### `Update-Mac.command`
- After `npm install`, run `launchctl kickstart -k` on the dashboard agent so new
  dependencies load. New lines go **after** the `git pull` only (see the byte-offset note in
  that file).

### Out of scope
- Windows launchers (they have their own startup mechanism; no change there).
- Production build of the dashboard (see above).

## Risks
| Risk | Mitigation |
|---|---|
| Port 3939 already taken (nohup copy, or a Claude preview from `.claude/launch.json`) → restart loop | Start frees a nohup copy before bootstrapping. Throttle caps retries at one every 30s. The loop shows up in `dashboard-launchd.out`. |
| launchd can't find `node` | Explicit `PATH` in the plist. Start verifies the agent reaches a live pid *and* port 3939 answers before saying so. |
| Stop "succeeds" but launchd revives the dashboard | `bootout`, not `kill`. The existing final check reports any survivor. |

## Verification (manual, on this Mac)
1. Run Start: both items appear in Login Items; `launchctl print gui/$UID/com.socialscheduler.dashboard` shows a pid; `localhost:3939` loads.
2. `kill` the dashboard's pid: it comes back within ~30s on its own (this is the actual bug).
3. Run Stop: port 3939 stays dead for 60s+; the worker is stopped too.
4. Run Start again: both come back.
5. Run Disable: both agents gone from `launchctl` and Login Items; both plists deleted.
6. Run Start one more time to restore normal state, and confirm the worker log still shows normal cycles.
