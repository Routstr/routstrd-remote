Routstrd Auth is now installed.

The app exposes an OpenAI-compatible Routstr endpoint protected by bearer-token auth. Persistent wallet/config/database data is stored under Cloudron's app data directory and included in backups.

The app's own Nostr identity is already its first admin, so there is nothing to claim and no token to copy. To add yourself, open this app's Web Terminal (Terminal button in the Cloudron dashboard) and run:

    routstrd npubs add <your npub> --role admin --name "Your Name"

Your npub is printed by `routstrd remote <this app's URL>` on your own machine. Once you are an admin, `routstrd npubs list`, `add` and `update` work from there too. `routstrd status` and `routstrd balance` in the Web Terminal show the wallet and daemon state.

The container's own identity stays an admin as a break-glass account (it is what signs your terminal commands), so it cannot be locked out. Name it if you want the startup warning to stop:

    routstrd npubs update <container npub> --name "Routstr Box"

`routstrd npubs list` marks the container's identity with "→ you".
