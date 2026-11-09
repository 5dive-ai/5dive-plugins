# crew

Run a [CrewAI](https://www.crewai.com/) crew on your own 5dive server. It was `5dive crew` in the core CLI until DIVE-7950; the commands are the same.

```
sudo 5dive plugin add crew@5dive-plugins

5dive crew install <git-url> --as=<name> [--entry=<module:Crew>] [--branch=<b>]
5dive crew secret set <name> ANTHROPIC_API_KEY=...
5dive crew run <name> [--input='{"k":"v"}'] [--receipt]
5dive crew show <name>  ·  5dive crew list  ·  5dive crew uninstall <name> [--purge]
```

Run it as your own user, not with `sudo`: a crew runs code from its repo, so `crew` refuses root.

- **One run, then it stops.** `crew run` does one `kickoff()`. For "always on", schedule it (a recurring task or heartbeat).
- **Your own AI key.** `crew secret set` writes it to `~/.5dive/crews/<name>/secret.env` (0600). It is loaded only for the run.
- **Memory stays.** CrewAI's memory lives in `~/.5dive/crews/<name>/storage` across runs and reboots.
- **Nothing leaves your server by default.** `crew run --receipt` posts one signed work receipt to the 5dive feed: the crew's name, the time, your server's public ID and hashes of the work, never the work itself. Local-only mode turns it off even with `--receipt`. `ZEROHUMAN_INGEST_URL` points it somewhere else.

Crews installed by the old core command keep working: same folder, same files.
