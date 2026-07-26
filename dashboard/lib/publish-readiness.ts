import "server-only";
import { isDryRun } from "./config";
import { getWorkerStatus } from "./queries";

/**
 * What the composer needs to know before offering "Post now": is the install still in
 * dry-run (so "posting" logs instead of actually publishing), and is the worker daemon
 * actually alive to pick the send up on its next poll. Deliberately just these two
 * booleans — never leak anything else out of .env (paths, tokens, etc.) through this.
 */
export interface PublishReadiness {
  dryRun: boolean;
  workerOnline: boolean;
}

export function getPublishReadiness(): PublishReadiness {
  return {
    dryRun: isDryRun(),
    workerOnline: getWorkerStatus().online,
  };
}
