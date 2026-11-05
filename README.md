# whatsapp-skill

💬 Read and send messages on your personal WhatsApp through a WhatsApp Web linked device: link with a QR code, keep a local SQLite store of chats and messages, poll for new inbound messages, and send with a preview first. Built on [Baileys](https://github.com/WhiskeySockets/Baileys).

An agent skill for [OpenClaw](https://openclaw.ai), Claude Code, Codex and other agents that read `SKILL.md`.

## Install

Name the folder `whatsapp-skill`, the skill's `name`, and install the Node dependencies once:

```bash
git clone https://github.com/odrobnik/whatsapp-skill ~/.claude/skills/whatsapp-skill   # Claude Code
git clone https://github.com/odrobnik/whatsapp-skill ~/.agents/skills/whatsapp-skill   # Codex (OpenClaw reads this folder too)
cd <skill folder>/scripts && npm ci
```

Requires Node.js 22.13 or later (uses the built-in `node:sqlite`).

## Quick Start

```bash
cd scripts
nohup node wa.mjs link >> ~/.wa-bridge/daemon.log 2>&1 &   # writes ~/.wa-bridge/wa-qr.png; scan it in WhatsApp → Linked devices
node wa.mjs status
node wa.mjs chats --limit 10
node wa.mjs read "Alice" -n 30
node wa.mjs search "dinner"
node wa.mjs new --json                                      # inbound since the last call
node wa.mjs send "Alice" "On my way"                        # preview only; add --yes to send
```

After a reboot, start the daemon again: `nohup node wa.mjs daemon >> ~/.wa-bridge/daemon.log 2>&1 &`

See [SKILL.md](SKILL.md) for the rules agents follow and all commands.

## How it works

- `scripts/wa.mjs` is a single-file CLI and daemon. Only the daemon holds the WhatsApp connection; `send --yes` hands the message to it through a file outbox.
- State lives outside the skill folder, owner-only, in `~/.wa-bridge` (`WA_BRIDGE_DIR`): `auth/` (linked-device credentials), `store.db`, `inbox.jsonl`, `outbox/`, `status.json`. The QR PNG goes to `wa-qr.png` there (`WA_QR_PNG`).
- No read receipts, and presence stays offline.

## Warning

This is an unofficial WhatsApp Web client and is not affiliated with WhatsApp or Meta. Using it may violate WhatsApp's Terms of Service, and accounts that automate or bulk-send messages can be banned. The `auth/` folder grants full access to your account: never commit or share it.

## License

MIT

## Reliability (1.0.2)
- Keep-alive ping every 15s, 30s connect timeout; old socket fully closed before reconnect; exponential backoff 2s→60s (reset on open); overlapping reconnects guarded.
- Watchdog: if not `open` for 2 min, tear down and reconnect. `kill -USR2 <pid>` forces a reconnect (test).
- Run under the supervisor: `scripts/wa-supervise.sh --ensure` (idempotent; restarts the daemon on crash with backoff, stops on exit 2 = logged out). The box has no systemd/cron, so call `--ensure` after a reboot or from a periodic check.
- Single instance via `daemon.pid` (second daemon exits 3).
- Offline check: `node scripts/wa.mjs status --json` → `connected`, `offline_minutes`, `last_code`, `reconnects`; raw data in `~/.wa-bridge/status.json` (`connected`, `since`, `disconnected_since`, ms epoch).
