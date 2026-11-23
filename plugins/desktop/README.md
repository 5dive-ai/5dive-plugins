# desktop

`5dive desktop` lets the agents on your 5dive server see and use the apps on your Windows PC. It works through the 5dive desktop app, which runs [agent-desktop](https://github.com/vercel-labs/agent-desktop) (Windows UI Automation) on the PC.

```
sudo 5dive plugin add desktop@5dive-plugins

5dive desktop status                         # is your PC connected?
5dive desktop snapshot --app=Notepad -i      # the app's controls, each with a ref
5dive desktop act --steps='[{"do":"click","ref":"@s1:e3"}]'
5dive desktop log                            # what agents did on your PC
```

- **Off until you turn it on.** You turn it on in the 5dive app on your PC: "Let my agent use this computer". Your PC opens no port: the app checks the server for work.
- **Stop is one click.** While an agent works, the PC shows "Agent is using your computer" with a Stop button. Stop interrupts the job at once.
- **Paying waits for you.** Steps that pay, post, send or delete follow the same approvals policy as the browser (`5dive browser approvals policy`). By default only paying waits for your yes. On `careful`, all four wait.
- **Your screen is not logged.** What the agent read on your screen is kept only until it reads it once, then deleted. The log records which app and which buttons were used, never the screen content. For typed text it records only the length.
- `sudo 5dive desktop off` turns desktop control off from the server side. `sudo 5dive desktop on` turns it back on.

The agent's manual is [`skills/use-desktop/SKILL.md`](./skills/use-desktop/SKILL.md). The test is `tests/desktop_spool_unit.sh`.
