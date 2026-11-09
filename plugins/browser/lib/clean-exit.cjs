'use strict';
// DIVE-7204 — no "Restore pages?" bubble on a kept profile.
//
// WHY THIS EXISTS. A served browser is never closed the way a person closes one:
// a serve restart, a box reboot or a drive-mode switch stops Chrome with a
// signal, so the profile's Preferences still say the last session crashed and
// the next start draws Chrome's "Restore pages? Chrome didn't shut down
// correctly" bubble at the top right of the window. The owner sees it in every
// viewer link, and in input mode (drive=input: CJ, Meta uploads) a real-mouse
// click aimed at the page's top right can land on it instead. It is browser
// chrome, not page DOM, so nothing on the page can dismiss it for us.
//
// TWO LEVERS, both used: --hide-crash-restore-bubble at every kept-profile
// launch (written literally in each launcher's args), and the
// profile marked as cleanly exited before each launch, because a switch is the
// kind of thing a Chrome version renames or drops. Old tabs are NOT restored:
// the bubble is the only thing that would have offered to, and a served browser
// opens on the page it is told to.
//
// Used by bin/session-daemon, bin/driver-playwright and (through the CLI form at
// the bottom) bin/browser's plain-Chrome launches.
const fs = require('fs');
const path = require('path');

// Returns what it found, for the harness: 'absent' (a new profile, nothing to
// mark), 'unreadable' (left exactly as it was — Chrome rewrites its own file,
// and a launch is never failed over this), 'clean' or 'marked'.
function markCleanExit(profile) {
  const file = path.join(profile, 'Default', 'Preferences');
  let st, prefs;
  try { st = fs.statSync(file); prefs = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return e.code === 'ENOENT' ? 'absent' : 'unreadable'; }
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return 'unreadable';
  if (!prefs.profile || typeof prefs.profile !== 'object') prefs.profile = {};
  if (prefs.profile.exit_type === 'Normal' && prefs.profile.exited_cleanly === true) return 'clean';
  prefs.profile.exit_type = 'Normal';
  prefs.profile.exited_cleanly = true;
  // Written beside and renamed over, with the file's own mode: a half-written
  // Preferences is a profile Chrome resets, which is a lost login.
  const tmp = `${file}.5dive-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(prefs), { mode: st.mode & 0o777 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* never written */ }
    return 'unreadable';
  }
  return 'marked';
}

module.exports = { markCleanExit };

// CLI: `node clean-exit.cjs <profile>` prints what markCleanExit returned.
if (require.main === module) {
  if (!process.argv[2]) { process.stderr.write('usage: clean-exit.cjs <profile dir>\n'); process.exit(2); }
  process.stdout.write(markCleanExit(process.argv[2]) + '\n');
}
