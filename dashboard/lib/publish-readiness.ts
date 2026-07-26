import "server-only";
import { isDryRun, isKillSwitchActive } from "./config";
import { getWorkerStatus } from "./queries";

/**
 * What the composer needs to know before offering "Post now": is the install still in
 * dry-run (so "posting" logs instead of actually publishing), is the kill switch halting
 * publishing outright, and is the worker daemon actually alive to pick the send up on its
 * next poll. Deliberately just these three booleans — never leak anything else out of
 * .env (paths, tokens, etc.) through this.
 *
 * All three are read live (see lib/config.ts) so this reflects the current .env, not a
 * boot-time snapshot — otherwise the composer could tell the owner "nothing will post"
 * while DRY_RUN=0 and the worker actually publishes for real.
 *
 * killSwitch is checked independently of workerOnline: worker/run.py writes its heartbeat
 * *before* checking KILL_SWITCH (alive is not the same as publishing), so the worker can
 * show online while KILL_SWITCH=1 silently blocks every publish. Without surfacing this
 * separately, that combination would look identical to "everything's fine."
 */
export interface PublishReadiness {
  dryRun: boolean;
  killSwitch: boolean;
  workerOnline: boolean;
}

export function getPublishReadiness(): PublishReadiness {
  return {
    dryRun: isDryRun(),
    killSwitch: isKillSwitchActive(),
    workerOnline: getWorkerStatus().online,
  };
}
