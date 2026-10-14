# Chorus

Chorus is a local-first workspace for coordinating OpenCode tasks across boards.

## Run locally

Install Bun, then from the repository root run:

    bun install
    bun dev

Open [http://localhost:3000](http://localhost:3000). The first local Serve boot
creates an access token in ~/.chorus/chorus.token; the startup output shows the
file path. Later boots reuse the same file and show its path again.

To read the default token on Windows PowerShell:

    Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.chorus\chorus.token')

On macOS or Linux:

    cat ~/.chorus/chorus.token

Paste the value into Chorus’s sign-in page. If you set DATA_DIR, use the
chorus.token file inside that directory instead. If CHORUS_TOKEN is set, enter
its configured value; Serve does not write environment-provided values to disk.
For a Chorus instance running on another computer, request access from that
instance’s operator. Keep the token private.

The root .env.example is a production/container configuration example. It sets
NODE_ENV=production, uses /data, and requires an explicit CHORUS_TOKEN; do not
copy it unchanged for local development. Without overrides, local Serve stores
state under ~/.chorus.
