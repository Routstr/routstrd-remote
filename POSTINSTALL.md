Routstrd Auth is now installed.

The app exposes an OpenAI-compatible Routstr endpoint protected by bearer-token auth. Persistent wallet/config/database data is stored under Cloudron's app data directory and included in backups.

If you need admin-only client management endpoints, set `routstrd remote <url>` and run `routstrd npubs register --name "Your Name"` to register the first admin npub. A display name is required, and the CLI prompts for one if you leave the flag out.
