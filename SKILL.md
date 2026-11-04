---
name: whatsapp-skill
description: "Read and send messages on the user's personal WhatsApp through a WhatsApp Web linked device (Baileys). Link once by scanning a QR code (written as a PNG). A long-running daemon stores chats, contacts and messages, including the initial history sync, in a local SQLite store and appends every new inbound message to inbox.jsonl so the agent can poll for new messages and react. Commands: link, daemon, status, chats, read, search, new, and send, which only shows a preview until run again with --yes. No read receipts, presence stays offline. State lives owner-only in ~/.wa-bridge (or WA_BRIDGE_DIR). Every read command can print JSON (--json). Unofficial client: WhatsApp may ban accounts that automate sending. Use when the user asks to read their WhatsApp chats, check for new WhatsApp messages, react to messages from friends, or send a WhatsApp message on their behalf."
summary: "Personal WhatsApp via a linked device: QR link, daemon with SQLite store, inbox polling, and sending with a preview first."
version: 1.0.0
homepage: https://github.com/odrobnik/whatsapp-skill
compatibility: "Node.js 22.13+ (built-in node:sqlite) and npm to install Baileys once. Linux or macOS. Works in OpenClaw, Claude Code, Codex and other agents that read SKILL.md."
permissions:
  - "network: WhatsApp Web (web.whatsapp.com, *.whatsapp.net, mmg.whatsapp.net), plus registry.npmjs.org for the one-time npm install"
  - "file_read/file_write: the state folder (~/.wa-bridge by default, or WA_BRIDGE_DIR): auth/ (linked-device credentials, owner-only), store.db, inbox.jsonl, outbox/, status.json, daemon.pid, new.cursor, and the QR PNG (wa-qr.png there, or WA_QR_PNG)"
  - "env: WA_BRIDGE_DIR, WA_QR_PNG, WA_LOG"
metadata:
  openclaw:
    emoji: "💬"
    homepage: https://github.com/odrobnik/whatsapp-skill
    requires:
      bins: ["node", "npm"]
    envVars:
      - name: WA_BRIDGE_DIR
        required: false
        description: "State folder (default ~/.wa-bridge): credentials, message store, inbox and outbox."
      - name: WA_QR_PNG
        required: false
        description: "Where `link` writes the QR code PNG (default <state folder>/wa-qr.png)."
      - name: WA_LOG
        required: false
        description: "Baileys log level (default silent)."
---

# WhatsApp (personal account, linked device)

One-time install: `cd {baseDir}/scripts && npm ci`. Below, `wa` means `node {baseDir}/scripts/wa.mjs`.

## Rules

- **Sending needs the user's explicit approval of the recipient and the exact text.** Run `wa send <who> <text>` without `--yes` first, show the preview, and only then run it again with `--yes`. Never auto-reply.
- Never print, copy or upload anything from the `auth/` folder: it is full access to the account.
- The skill sends no read receipts and never shows the user online. Keep it that way.
- This is an unofficial WhatsApp Web client. Keep sending rare and human; bulk or automated sending can get the number banned.

## Link (once)

1. Start linking in the background: `nohup wa link >> ~/.wa-bridge/daemon.log 2>&1 &`
2. The QR code is written to `~/.wa-bridge/wa-qr.png` (or `WA_QR_PNG`) and rotates about every 20 seconds. Show the current PNG to the user right away.
3. The user scans it on the phone: WhatsApp → Settings → Linked devices → Link a device.
4. The log shows `connected as …`, then `history sync: …`. The same process keeps running as the daemon.

After a restart: `nohup wa daemon >> ~/.wa-bridge/daemon.log 2>&1 &`. Exit code 2 means the device was unlinked; link again.

## Commands

| Command | What it does |
|---|---|
| `wa status` | linked or not, daemon pid, connection, store counts |
| `wa chats [--limit N]` | recent chats, newest first |
| `wa read <name\|jid\|+number> [-n N]` | the last N messages of a chat (default 20) |
| `wa search <text> [-n N]` | search stored messages |
| `wa new [--since <unix\|ISO>]` | inbound messages since the last `new` call, or since a time |
| `wa send <who> <text> [--yes]` | preview; with `--yes` the daemon sends it and the command waits for the result |

Read commands accept `--json`. Names match chat and contact names; when several match, the command lists them with their JIDs, so pick one and pass the JID.

## Reacting to new messages

Poll `wa new --json`, for example from a scheduled routine, or tail `~/.wa-bridge/inbox.jsonl`. Each line is one inbound message: `id`, `jid`, `sender`, `push_name`, `chat_name`, `group`, `ts`, `type`, `text`. Tell the user what arrived and suggest replies; send only after approval.

## Unlink

Remove the device on the phone (Linked devices), stop the daemon, and delete the state folder.
