#!/bin/bash
# Give both background programs the SocialScheduler app icon.
#
# System Settings → Login Items draws the icon of the exact file a LaunchAgent runs — the
# script inside each .app, not the .app — and a script shows as a generic "exec". A custom
# file icon fixes that, but it lives in extended attributes, which git does not keep: a
# clone, or a `git pull` that touches the script, drops it. Start and Update both run this;
# it is quick and harmless when the icon is already set. Failure is never fatal.
cd "$(dirname "$0")" || exit 0
here="$(pwd -P)"
for b in "SocialScheduler" "SocialScheduler Dashboard"; do
  osascript -l JavaScript - "$here/$b.app/Contents/Resources/AppIcon.icns" \
    "$here/$b.app/Contents/MacOS/$b" >/dev/null 2>&1 <<'JXA_EOF'
ObjC.import('AppKit');
function run(argv) {
  const img = $.NSImage.alloc.initWithContentsOfFile(argv[0]);
  return $.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, argv[1], 0);
}
JXA_EOF
done
exit 0
