Routstrd Auth is now installed.

The app exposes an OpenAI-compatible Routstr endpoint protected by bearer-token auth. Persistent wallet/config/database data is stored under Cloudron's app data directory and included in backups.

Register the first admin now. Until you do, the app has no admin and the first-admin slot can only be claimed with a one-time token:

1. Open this app's Logs tab and copy the bootstrap token printed at startup ("The first admin must be claimed with this one-time token").
2. Claim the first admin with your npub and a display name:

   curl -X POST https://<this-app>/npubs -H 'Content-Type: application/json' -H 'x-routstr-bootstrap-token: <token>' -d '{"npub":"npub1...","name":"Your Name"}'

The token is single-use. After this, `routstrd remote <url>` + `routstrd npubs add` manage further members from the CLI, and admin-only wallet and provider-key routes require that admin npub.
