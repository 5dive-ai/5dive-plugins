# Add an AI agent to Microsoft Teams (for your IT)

Each agent becomes its own contact in your Teams, like a colleague. One bot per agent. About 10 minutes per agent.

**Where messages go:** between Microsoft Teams and your own 5dive server. Nothing passes through 5dive's servers. Teams is a Microsoft cloud service, so this does not work on a fully offline server.

**You need:** a Microsoft 365 tenant where custom apps may be uploaded, and rights to create an app registration in Azure.

## 1. Create the bot in Azure (once per agent)

1. Azure portal > **Azure Bot** > Create. Type of app: **Single Tenant**. Let it create a new app registration.
2. Open the new app registration. Copy the **Application (client) ID** and the **Directory (tenant) ID**.
3. **Certificates & secrets** > New client secret. Keep this page open: the secret goes to your server in step 2, through a one-time link.
4. Back on the Azure Bot: **Channels** > add **Microsoft Teams**.

## 2. Connect the agent on your 5dive server

Give your agent (or your 5dive admin) the two IDs. It runs:

```
sudo 5dive agent teams connect <agent> --app-id=<Application ID> --tenant-id=<Directory ID> --task=<task>
```

You get a one-time link. Open it and paste the client secret. It goes to your server only, never into a chat.

The agent runs connect again. It prints two things:

- **Endpoint**: the address Microsoft will post messages to.
- **App package**: a small zip with the agent's name, role and face.

## 3. Point the bot at your server

Azure Bot > **Configuration** > Messaging endpoint = the **Endpoint** from step 2.

- **5dive cloud server**: the endpoint is already public (`https://teams-<agent>.<your server>/api/messages`).
- **Your own server**: publish one HTTPS address (reverse proxy or DMZ) that forwards `/api/messages` to the server on the port connect printed. Then the agent runs connect once more with `--endpoint=https://<that address>`.

Only Microsoft needs to reach that address. Every request is checked against Microsoft's signature, your bot's ID and your tenant; anything else is refused.

## 4. Add the app to Teams

Teams admin center > **Teams apps** > **Manage apps** > **Upload new app** > the App package.

Then make it available (app setup or permission policies) to the people who should talk to the agent. They find it under **Apps**, or pinned if you pin it.

## What people can do

- Message the agent 1:1, like a colleague.
- Tap buttons when it asks a question with set answers.
- Send it files and get files back (Teams asks them to accept a file first).

Group chats and channels are not supported yet.

## Check, and turn off

- `5dive agent teams status <agent>`: connected, listening, reachable, last message time.
- `sudo 5dive agent teams disconnect <agent>`: turns it off and deletes the secret from your server. Then remove the app in the Teams admin center and delete the client secret in Azure.

**If your company uses Claude Team or Enterprise:** an admin must allow channels for the Claude organisation, or the agent will not receive Teams messages.
