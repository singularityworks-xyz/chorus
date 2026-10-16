# Chorus

Chorus is a local-first workspace for coordinating OpenCode tasks across boards.

## Run locally

Install Bun, then from the repository root run:

    bun install
    bun dev

Open [http://localhost:3000](http://localhost:3000). The first local Serve boot
opens the workspace without asking for an access token. To connect another
device, open **Settings → Devices** on the signed-in device and generate a
one-time code. Open the same Chorus instance on the other device and enter that
code on its sign-in screen. The code expires after five minutes and works once.

The root .env.example is a production/container configuration example. It sets
NODE_ENV=production, uses /data, and requires an explicit CHORUS_TOKEN; do not
copy it unchanged for local development. Without overrides, local Serve stores
state under ~/.chorus. The local session-signing secret is managed by Serve and
is not needed to open the local workspace or pair a device.
