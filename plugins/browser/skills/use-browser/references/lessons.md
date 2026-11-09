# Lessons from real browser jobs

Part of the use-browser skill. Read it before a form, a sign-up, a post or an upload, and whenever a step did something you did not expect.

## Downloads and popups

- **A click that downloads a file** (an Export or Download button) hands you the file: `act`
   prints `downloaded: <path> (<name>, <bytes> bytes)`, and the file is in the act's artifact
   directory under `downloads/`, readable by your seat (`--json`: `downloads`). A file over
   100 MB, or still downloading after 2 minutes, is named on stderr and not saved.
- **To save a PDF or any file at a URL, use `5dive browser download <url>`**: it prints
   `downloaded: <path> (<name>, <bytes> bytes, <type>)` with the site's login. Never click a PDF
   viewer's buttons (they time out). A sign-in page instead of the file is refused (exit 75).
- **A click that opens a popup** (most "Continue with Google" buttons) is followed: `act` prints
   `a popup opened: <host>, now in view`, the steps after it act in the popup, and `page.png`
   and the refs are of it. When the popup closes, the page that opened it is back. In a served
   browser the popup stays open: act on its URL, or with no URL, to continue in it. A cold act's popup closes
   with the act.
- **A popup that opens late, or from inside an embedded app** (a Shopify app's "Connect Facebook")
   is followed too. If the act's report still shows the page under it, `snapshot` with no URL reads the
   popup and says `a popup opened after the last act`. In input mode the popup window gets the keys,
   and the act says `a popup window opened`.

## On real sites (DIVE-5390)

- **Read the saved record back when no `--expect` covered it.** After a submit with no `--expect`, or one that did not match, open what the site saved and check every field landed where you meant: a URL can land in the name field while the page says "success". A matched `--expect` naming the saved value already is that check.
- **Look at the screenshot after a submit with no `--expect`**, not only the exit code. A success line can show for a moment and the form reset under it.
- **One run per form, every field in it.** Tabs keep page state between runs, so clear a pre-filled form and re-check it before you type.
- **Never press a site's autofill or AI-assist button.** It writes text you were not given.
- **A bot check can appear mid-flow**, after a sign-in or submit button, not only on page load. Try it like any other (tick, wait, retry); ask the owner only if it stays.
- **Only a real browser render proves a page has no bot check.** A plain fetch of the page cannot see one.
- **Patterns:** `--expect` already ignores case, so never put `(?i)` in it (grep -E rejects it). `--wait-for='text=<words>'` matches plain words in any case. A regex works only in a `wait_for` step's selector, as `text=/word/i`.
- **A form that only says "thanks"** (Tally and the like) leaves no record to read back: report "submitted, not live".
- **Served is not signed in.** Before you hand off work that needs the login, check `5dive browser status <site>` reads authenticated.
- **An `act` that opens a URL starts the page fresh.** A filled form, an open dialog or a code box from one act is gone in the next, so fill and submit in one act. When a later step needs the same page (a code that arrives after "Send code"), keep the browser served and act without a URL, and test that before you spend a press you only get once.
- **A blank, unlabelled text box in a form is usually a honeypot.** Leave it empty.
- **A file goes in with one `upload` step.** On a normal page: `{"op":"upload","selector":"ref=button/Upload","path":"/absolute/path/picture.png"}` (the file input's ref, or the Upload button's). The file must be one this seat can read, by absolute path; it is written to the audit log. In input mode use one `upload{x,y,path}` step on the upload control: the file must be one this seat can read, by absolute path. If the chooser does not take the path, the step closes it and drops the file on the same point, and fails by name only when that does not take either. If it says the chooser would not close, click its Cancel at the point it names, then `drop` the file. A page with a "drag files here" area takes `drop{x,y,path}` on that area directly. A drop on a spot that is neither makes the browser open the file in the tab: the step says so, go back with `alt+Left`. Check the file name shows on the form before you submit. If the form also takes an image URL, use that instead. Neither works for you? Stop and tell the owner.
- **A certificate warning is a hard stop.** Never click through it. The same site with or without `www.` can have a valid certificate; try that once.
- **A check that appears after you send means it was not delivered.** A chat or relay bot can let the first command through and hold the first real message behind a captcha. Report "not delivered".
- **A site that fills the form by reading your URL writes text you were not given.** Clear every field you have no value for. If the form has no place for text you were given, stop and ask; never rewrite it to fit.
- **An invite refused for a new account is usually an unverified email.** Verify the account's email, then retry the invite once.
- **A tick box or dropdown can miss on the first click.** Before the final press, check in a screenshot that every box shows ticked, every dropdown shows its value and the submit button is enabled. A native dropdown that will not open takes a second click or the Down key.
- **"Captcha verification failed" after a submit is an invisible bot check.** There was no widget to see. Wait a few seconds and submit once more; if it fails again, ask the owner rather than pressing again.
- **A money form can open on the wrong direction or with an old amount.** Read the add/withdraw switch, the amount and the button label in a screenshot before you press.
- **A site that flags the account as automated means stop there for the day.** After a captcha, a 403 or an "unusual activity" page on a site where you post, tell the owner and do nothing more on that site that day. Space later posts hours apart.
- **A click can land on a different page than you meant**, like a notification that opens the feed instead of the post. Check the URL bar or title before you record a link or id from it; never guess one.
- **An upsell or "verify your identity" prompt after an action is not the job.** Decline it ("Not now"); never start it.
- **A mis-click can open a look-alike domain** (one letter missing, a scam or gambling page). After every click that leaves the page, check the host in the URL bar, not only after a go-to. Type nothing on a host you did not mean; go back. Shoot before you click near a banner or cover photo.
- **A text editor can change what you type.** In many post and comment boxes, Enter after a list line adds a new bullet. Break lines with `shift+Enter`, then read the saved text back before you call it posted.
- **Text saved through a web form can come back with different line endings** (CRLF) and no final newline. Compare the words, or normalise line endings and trailing space, before you call a byte check failed.
- **A click that exits 0 is not a follow, a like or a subscribe.** On a page still loading, the click can fire and change nothing. Wait for the page to finish loading, click once, then read the button back: count it only when it shows the new state ("Following"). If it still shows the old one, report it not done; a second click can undo the first.
- **Check whose account the page shows before you act.** Read the signed-in name or avatar and compare it with the account the job names. If it is someone else's account, stop and ask; never post, follow or read as them.
- **A success message already on the page when you open it is not your submit.** It can be left from an earlier visit or someone else's. Check your own record of past submits before you count it done or submit again; with no record, report it as an unconfirmed earlier submit and ask before submitting again.
- **A follow can read "Following" and then go back to "Follow" after a reload.** Reload after about a minute and read the button again before you count it.
- **A post missing from a list you can see does not prove it was removed.** A site's filters can hide a post from other accounts or signed-out viewers. Say which view and account you checked, and what that view cannot show.
- **A search or quick switcher can open a same-named place somewhere else** (another server, workspace or account). Read the result list before Enter, then check the page header names the place you meant before you type.
