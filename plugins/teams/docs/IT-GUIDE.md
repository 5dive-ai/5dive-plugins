# Add an AI agent to Microsoft Teams: a guide for your IT team

Each agent becomes its own contact in your Teams, like a colleague. Your IT team sets it up, in your own Microsoft 365, with your own admin rights. 5dive never gets access to your Microsoft 365. About 10 minutes per agent.

**You need**

- Microsoft 365 with Teams. Teams runs in Microsoft's cloud, so it needs internet.
- Admin rights in your Microsoft 365 to register a bot and upload a custom app.
- Root on your 5dive server.
- One HTTPS address Microsoft can reach, published through your VPN gateway, DMZ or firewall to a reverse proxy on the 5dive server itself. A 5dive cloud server already has one.

**Where messages go:** only between Microsoft Teams and your 5dive server. Nothing passes through 5dive's servers.

## 1. Fully offline server? Open Teams alone

Skip this if your server is not in local-only mode. On a local-only server, Teams is shut until you open it:

```
sudo 5dive config local-only allow teams
```

Only Teams messages go out, to Microsoft. Everything else stays offline, and `sudo 5dive config local-only check` still flags any other outside connection. Shut it again with `sudo 5dive config local-only deny teams`.

## 2. Register the bot (once per agent)

Either way works. Pick **single tenant**, so only your organisation can reach it.

- **Teams Developer Portal** (no Azure subscription): dev.teams.microsoft.com > **Tools** > **Bot management** > New bot. Then **Client secrets** > Add.
- **Azure portal**: **Azure Bot** > Create, type **Single Tenant**. Then **Channels** > add **Microsoft Teams**, and in the bot's app registration, **Certificates & secrets** > New client secret.

Note the bot's **App (client) ID**, your **Directory (tenant) ID**, and keep the secret's page open.

## 3. Connect the agent on your server

First save the bot's client secret on the server. It asks for it with hidden input, so it never lands in a chat, a log or the command line:

```
sudo 5dive secret write TEAMS_APP_PASSWORD --connector=teams-<agent>
```

Then connect:

```
sudo 5dive agent teams connect <agent> --app-id=<App ID> --tenant-id=<Directory ID> --endpoint=https://<your address>
```

It prints:

- **Endpoint**: where Microsoft will post messages.
- **Forward to**: your reverse proxy on the server sends your address's `/api/messages` here (`http://127.0.0.1:<port>`). The agent listens on the server itself only.
- **App package**: a small zip with the agent's name, role and face.

On a 5dive cloud server, leave out `--endpoint`: the address is made for you.

## 4. Point the bot at your server

Set the bot's **Messaging endpoint** to the **Endpoint** from step 3 (Developer Portal: **Bot management** > the bot > **Configure**; Azure: **Configuration**).

Every request is checked: Microsoft's signature, your bot's ID and your tenant. Anything else is refused.

## 5. Add the app to Teams

Teams admin center > **Teams apps** > **Manage apps** > **Upload new app** > the App package. Then make it available (setup or permission policies) to the people who should talk to the agent.

**Upload new app greyed out?** A new Microsoft 365 often shows "setting up your new app management experience" for a while. Do this instead:

1. Teams admin center > **Teams apps** > **Setup policies** > **Global** > turn **Upload custom apps** on > Save.
2. dev.teams.microsoft.com > **Apps** > **Import app** > the App package.
3. Open the app > **Preview in Teams** > **Add**.

## What people can do

- Message the agent 1:1, like a colleague.
- Tap buttons when it asks a question with set answers.
- Send it files and get files back (Teams asks them to accept a file first).

Group chats and channels are not supported yet.

## Name your admins

Everyone you let in is a **member**: they can chat, ask and have the agent do its normal work. Running commands as root, paying, deleting, sending anything outside your company, and changing settings, keys or anyone's access need an **admin's** yes; the agent asks the admins in Teams with an Approve button, never the person who asked. Until you name one, nobody can approve. Name each admin by their Entra object ID (Teams admin center > **Users** > the person > **Object ID**), once per server, for all its agents:

```
sudo 5dive agent teams admins add <Object ID>
```

`5dive agent teams admins` lists them; `admins remove <Object ID>` takes one away. To let members do one kind without asking, for example delete files: `sudo 5dive agent teams admins members-may delete`. To make everyone equal again: `sudo 5dive agent teams admins check off`.

## Check, and turn off

- `5dive agent teams status <agent>`: connected, listening, reachable, last message time.
- `sudo 5dive agent teams disconnect <agent>`: turns it off and deletes the secret from your server. Then remove the app in the Teams admin center and delete the bot's client secret.

**If your company uses Claude Team or Enterprise:** an admin must allow channels for the Claude organisation, or the agent will not receive Teams messages.
