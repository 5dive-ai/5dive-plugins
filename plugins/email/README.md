# email — each agent gets its own email address

People email the agent like a colleague. The mail shows up as a chat; the agent
answers in the same thread, from its own address. 5dive hosts no mail.

Two ways to give an agent an address:

1. **A mailbox your firm already runs** (Google Workspace or any IMAP + SMTP
   server; Microsoft 365 needs a Microsoft sign-in that is not built yet). IT makes `mike@yourfirm.com`, then:
   `sudo 5dive agent email connect mike --address=mike@yourfirm.com --provider=google --task=<DIVE-N>`
   (the password comes through a one-time link, never on the command line).
2. **Your server's own mail server** (OpenAgent Mail) for a domain or subdomain
   your firm points at it, e.g. `mike@ai.yourfirm.com`:
   `sudo 5dive agent email server setup --domain=ai.yourfirm.com` (prints the DNS
   records for IT), then `sudo 5dive agent email connect mike --self-hosted`.
   Works with the internet off for mail inside the office.

Safety, on by default:

- A first mail to an address that never wrote to the agent waits for the
  owner's tap (Allow / No). Colleagues on the agent's own domain are not asked.
  Switch it off per agent: `sudo 5dive agent email gate mike off`.
- At most 50 mails a day per agent (`sudo 5dive agent email cap mike <n>`).
- Mail is outside text: while the newest message is an email, the agent will
  not run root commands, pay, delete, or change settings or access until the
  owner says yes on their own channel.

Check it: `5dive agent email status mike`. The DNS and network steps for IT:
[docs/IT-GUIDE.md](docs/IT-GUIDE.md).

Tests: `bun test test/dive8315-email.test.ts` (repo root, no dependencies) and
`cd plugins/email && bun install && bun e2e.ts` (the whole path on one machine).
