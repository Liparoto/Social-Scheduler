/**
 * What to tell someone whose upload needs converting when no converter is available.
 *
 * Split out of the upload route so every platform's wording can be asserted from one
 * machine. The bug this fixes was reported from Windows, where the message hardcoded
 * `brew install ffmpeg` — a command that does not exist there, sending the one person who
 * hit it down a dead end.
 *
 * Takes the platform rather than reading process.platform so it stays a pure function.
 */
export function converterAdvice(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return (
      "This install has no video converter yet. Close SocialScheduler and double-click " +
      "Start-SocialScheduler-Windows.bat — it installs one automatically, then upload " +
      "this video again."
    );
  }
  if (platform === "darwin") {
    return (
      "This Mac has no video converter available, which is unusual — macOS normally " +
      "provides one. Installing ffmpeg (`brew install ffmpeg`) would let this app " +
      "convert and publish it automatically."
    );
  }
  return (
    "This install has no video converter. Installing ffmpeg and making sure it is on " +
    "your PATH would let this app convert and publish this automatically."
  );
}
