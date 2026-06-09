# `codex-auth gui`

## Usage

```shell
codex-auth gui
codex-auth gui --no-open
codex-auth gui --host 127.0.0.1 --port 8787
```

## Behavior

- Starts a local web interface bound to `127.0.0.1` by default.
- Opens the browser automatically unless `--no-open` is passed.
- Lists stored accounts from `registry.json`.
- Refreshes account state through `codex-auth list` before reading the registry.
- Shows foreground usage refresh overlays such as `401 token_expired` and `401 token_invalidated`.
- Switches accounts through the existing `codex-auth switch <display-number>` command.

Opening the GUI performs the same default remote usage refresh as `codex-auth list`, so invalid or expired tokens are visible in the account table. The command runs on localhost and does not expose the web interface outside the bound host.

## Options

| Option | Description |
|--------|-------------|
| `--host <host>` | Host to bind. Defaults to `127.0.0.1`. |
| `--port <port>` | Port to bind. Defaults to an available random port. |
| `--no-open` | Print the URL without opening a browser. |
| `-h`, `--help` | Show GUI command help. |

## Switch Effects

Switching from the GUI has the same effects as `codex-auth switch <display-number>`:

1. `auth.json` is backed up when its contents would change.
2. The selected account snapshot is copied to `~/.codex/auth.json`.
3. `active_account_key` and `previous_active_account_key` are updated in `registry.json`.

Codex CLI and Codex App users may still need to restart the client before the new account takes effect.
