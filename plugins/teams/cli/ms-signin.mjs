// DIVE-7831: one Microsoft sign-in for `5dive agent teams connect <agent> --microsoft`.
//
//   node ms-signin.mjs <teams-cli dist dir> <url file>
//
// Runs Microsoft's own `teams` CLI sign-in (its client id, its token cache) but
// writes the sign-in page's address to <url file> instead of opening a desktop
// browser. bin/teams opens that address in the box's own Chrome, which the owner
// sees through a one-time `5dive browser viewer` link.
//
// Why on the box: the CLI's app only returns to http://localhost:<port> (a form
// post to the process waiting here), and code sign-in is refused by Microsoft's
// security defaults (error 530035) on most new tenants. Measured in DIVE-7828.
//
// Exit 0 once signed in (the CLI's token cache now holds the account), 1 on
// failure. The tokens never pass through this script's output.
import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dist, urlFile] = process.argv.slice(2);
if (!dist || !urlFile) {
  console.error("usage: node ms-signin.mjs <teams-cli dist dir> <url file>");
  process.exit(2);
}

const { getMsalClient } = await import(pathToFileURL(join(dist, "auth", "client.js")).href);
const client = await getMsalClient();

try {
  const result = await client.acquireTokenInteractive({
    scopes: [], // the CLI's own login scopes: each command asks for its own later
    responseMode: "form_post", // Entra refuses query mode for this public client (AADSTS70007)
    openBrowser: async (url) => {
      const tmp = `${urlFile}.tmp`;
      writeFileSync(tmp, `${url}\n`, { mode: 0o600 });
      renameSync(tmp, urlFile);
    },
    successTemplate:
      "<html><body style=\"font-family:sans-serif;padding:2em\"><h2>Signed in to Microsoft</h2><p>Go back to the 5dive app. Your agent is being added to Teams.</p></body></html>",
    errorTemplate:
      "<html><body style=\"font-family:sans-serif;padding:2em\"><h2>Microsoft sign-in did not finish</h2><p>Go back to the 5dive app and try again.</p></body></html>",
  });
  if (!result?.account) throw new Error("no account came back");
  console.log(`signed in as ${result.account.username}`);
  process.exit(0);
} catch (e) {
  console.error(`sign-in failed: ${e?.errorCode || e?.message || e}`);
  process.exit(1);
}
