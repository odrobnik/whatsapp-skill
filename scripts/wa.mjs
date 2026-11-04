#!/usr/bin/env node
// WhatsApp bridge (Baileys / WhatsApp Web linked device). Never prints credentials.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.WA_BRIDGE_DIR
  ? path.resolve(process.env.WA_BRIDGE_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), '.wa-bridge');
const AUTH = path.join(HOME, 'auth'), DB = path.join(HOME, 'store.db');
const INBOX = path.join(HOME, 'inbox.jsonl'), OUTBOX = path.join(HOME, 'outbox');
const QR = process.env.WA_QR_PNG || path.join(HOME, 'wa-qr.png');
const PIDF = path.join(HOME, 'daemon.pid');
fs.mkdirSync(AUTH, { recursive: true, mode: 0o700 }); fs.chmodSync(HOME, 0o700); fs.chmodSync(AUTH, 0o700);

const argv = process.argv.slice(2); const cmd = argv[0];
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const pos = argv.slice(1).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && ['-n','--since','--limit'].includes(arr[i-1])) && a !== '-n');
const JSONOUT = flag('--json');

function db() {
  const d = new DatabaseSync(DB);
  d.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS chats(jid TEXT PRIMARY KEY, name TEXT, last_ts INTEGER, unread INTEGER);
  CREATE TABLE IF NOT EXISTS contacts(jid TEXT PRIMARY KEY, name TEXT, notify TEXT, lid TEXT, pn TEXT);
  CREATE TABLE IF NOT EXISTS messages(id TEXT, jid TEXT, from_me INTEGER, sender TEXT, push_name TEXT, ts INTEGER, type TEXT, text TEXT, PRIMARY KEY(jid,id));
  CREATE INDEX IF NOT EXISTS m_ts ON messages(jid, ts);`);
  try { fs.chmodSync(DB, 0o600); } catch {}
  return d;
}

function textOf(m) {
  const x = m?.message || {}; const inner = x.ephemeralMessage?.message || x.viewOnceMessage?.message || x.documentWithCaptionMessage?.message || x;
  const type = Object.keys(inner).find(k => !['messageContextInfo','senderKeyDistributionMessage'].includes(k)) || 'unknown';
  const t = inner.conversation || inner.extendedTextMessage?.text || inner.imageMessage?.caption || inner.videoMessage?.caption
    || inner.documentMessage?.caption || inner.documentMessage?.fileName || inner.reactionMessage?.text && `[reaction ${inner.reactionMessage.text}]`
    || inner.pollCreationMessage?.name || inner.pollCreationMessageV3?.name || inner.locationMessage && '[location]' || '';
  const media = { imageMessage: '[image]', videoMessage: '[video]', audioMessage: '[voice/audio]', stickerMessage: '[sticker]', documentMessage: '[document]' }[type];
  return { type, text: media && !t ? media : (media ? `${media} ${t}` : t) };
}
const tsNum = (t) => typeof t === 'number' ? t : t?.toNumber ? t.toNumber() : Number(t || 0);

// ---------- daemon / link ----------
async function runSocket({ linkMode }) {
  const B = await import('baileys'); const makeWASocket = B.default; const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = B;
  const pino = (await import('pino')).default; const QRCode = (await import('qrcode')).default;
  const d = db(); fs.mkdirSync(OUTBOX, { recursive: true, mode: 0o700 });
  const upChat = d.prepare(`INSERT INTO chats(jid,name,last_ts,unread) VALUES(?,?,?,?) ON CONFLICT(jid) DO UPDATE SET name=COALESCE(excluded.name,chats.name), last_ts=MAX(COALESCE(excluded.last_ts,0),COALESCE(chats.last_ts,0)), unread=COALESCE(excluded.unread,chats.unread)`);
  const upContact = d.prepare(`INSERT INTO contacts(jid,name,notify,lid,pn) VALUES(?,?,?,?,?) ON CONFLICT(jid) DO UPDATE SET name=COALESCE(excluded.name,contacts.name), notify=COALESCE(excluded.notify,contacts.notify), lid=COALESCE(excluded.lid,contacts.lid), pn=COALESCE(excluded.pn,contacts.pn)`);
  const insMsg = d.prepare(`INSERT OR IGNORE INTO messages(id,jid,from_me,sender,push_name,ts,type,text) VALUES(?,?,?,?,?,?,?,?)`);
  const saveMsg = (m) => {
    const jid = m.key?.remoteJid; if (!jid || jid === 'status@broadcast' || !m.message) return null;
    const { type, text } = textOf(m); if (type === 'protocolMessage') return null; const ts = tsNum(m.messageTimestamp);
    const sender = m.key.fromMe ? 'me' : (m.key.participant || jid);
    const r = insMsg.run(m.key.id, jid, m.key.fromMe ? 1 : 0, sender, m.pushName || null, ts, type, text);
    upChat.run(jid, null, ts, null);
    if (m.pushName && !m.key.fromMe) upContact.run(sender, null, m.pushName, null, null);
    return r.changes ? { id: m.key.id, jid, sender, push_name: m.pushName || null, ts, type, text } : null;
  };
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
  const sock = makeWASocket({ auth: state, version, logger: pino({ level: process.env.WA_LOG || 'silent' }), printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'), syncFullHistory: true, markOnlineOnConnect: false, shouldSyncHistoryMessage: () => true });
  sock.ev.on('creds.update', async () => { await saveCreds(); try { for (const f of fs.readdirSync(AUTH)) fs.chmodSync(path.join(AUTH, f), 0o600); } catch {} });
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) { await QRCode.toFile(QR, u.qr, { width: 512 }); console.log(`[${new Date().toISOString()}] QR updated -> ${QR} (scan in WhatsApp > Linked devices)`); }
    if (u.connection === 'open') { console.log(`[${new Date().toISOString()}] connected as ${sock.user?.id?.split(':')[0] || '?'}`); try { fs.unlinkSync(QR); } catch {}
      fs.writeFileSync(path.join(HOME, 'status.json'), JSON.stringify({ connected: true, since: Date.now(), me: sock.user?.id || null, name: sock.user?.name || null })); }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      fs.writeFileSync(path.join(HOME, 'status.json'), JSON.stringify({ connected: false, at: Date.now(), code }));
      if (code === DisconnectReason.loggedOut) { console.error('Logged out (device unlinked). Run `wa link` again.'); process.exit(2); }
      console.log(`connection closed (code ${code}), reconnecting in 3s`); setTimeout(() => runSocket({ linkMode }).catch(e => { console.error(e); process.exit(1); }), 3000);
      clearInterval(timer);
    }
  });
  sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
    d.exec('BEGIN'); for (const c of chats) upChat.run(c.id, c.name || null, tsNum(c.conversationTimestamp) || null, c.unreadCount ?? null);
    for (const c of contacts) upContact.run(c.id, c.name || null, c.notify || null, c.lid || null, c.phoneNumber || null);
    for (const m of messages) saveMsg(m); d.exec('COMMIT');
    console.log(`history sync: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs`);
  });
  for (const ev of ['chats.upsert', 'chats.update']) sock.ev.on(ev, (cs) => { for (const c of cs) upChat.run(c.id, c.name || null, tsNum(c.conversationTimestamp) || null, c.unreadCount ?? null); });
  for (const ev of ['contacts.upsert', 'contacts.update']) sock.ev.on(ev, (cs) => { for (const c of cs) upContact.run(c.id, c.name || null, c.notify || null, c.lid || null, c.phoneNumber || null); });
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const m of messages) { const r = saveMsg(m);
      if (r && type === 'notify' && !m.key.fromMe) { const name = d.prepare('SELECT COALESCE(name,notify) n FROM contacts WHERE jid=?').get(r.jid)?.n || d.prepare('SELECT name FROM chats WHERE jid=?').get(r.jid)?.name;
        fs.appendFileSync(INBOX, JSON.stringify({ ...r, chat_name: name || null, group: r.jid.endsWith('@g.us') }) + '\n', { mode: 0o600 }); } }
  });
  // Outbox: `wa send --yes` drops a JSON file here; the daemon (owner of the socket) sends it.
  const timer = setInterval(async () => {
    if (!sock.user) return;
    for (const f of fs.readdirSync(OUTBOX).filter(f => f.endsWith('.json'))) {
      const p = path.join(OUTBOX, f); let job; try { job = JSON.parse(fs.readFileSync(p, 'utf8')); fs.renameSync(p, p + '.sending'); } catch { continue; }
      try { const res = await sock.sendMessage(job.jid, { text: job.text }); saveMsg(res);
        fs.writeFileSync(p.replace(/\.json$/, '.done'), JSON.stringify({ ok: true, id: res?.key?.id, at: Date.now() })); }
      catch (e) { fs.writeFileSync(p.replace(/\.json$/, '.done'), JSON.stringify({ ok: false, error: String(e) })); }
      fs.unlinkSync(p + '.sending');
    }
  }, 1000);
  if (linkMode !== false) fs.writeFileSync(PIDF, String(process.pid));
}

// ---------- read-side helpers ----------
function resolveJid(d, q) {
  if (/@(s\.whatsapp\.net|g\.us|lid)$/.test(q)) return q;
  if (/^\+?\d{6,}$/.test(q)) return q.replace('+', '') + '@s.whatsapp.net';
  const like = `%${q}%`;
  const rows = d.prepare(`SELECT c.jid, COALESCE(c.name, k.name, k.notify) name, c.last_ts FROM chats c LEFT JOIN contacts k ON k.jid=c.jid
    WHERE c.name LIKE ? OR k.name LIKE ? OR k.notify LIKE ? ORDER BY c.last_ts DESC LIMIT 10`).all(like, like, like);
  if (!rows.length) { const k = d.prepare('SELECT jid, COALESCE(name,notify) name FROM contacts WHERE name LIKE ? OR notify LIKE ? LIMIT 10').all(like, like); rows.push(...k); }
  if (!rows.length) throw new Error(`no chat/contact matches "${q}"`);
  const exact = rows.filter(r => (r.name || '').toLowerCase() === q.toLowerCase());
  if (exact.length === 1) return exact[0].jid;
  if (rows.length > 1) throw new Error(`ambiguous "${q}":\n` + rows.map(r => `  ${r.name}  ${r.jid}`).join('\n'));
  return rows[0].jid;
}
const nameOf = (d, jid) => d.prepare(`SELECT COALESCE(c.name,k.name,k.notify) n FROM chats c LEFT JOIN contacts k ON k.jid=c.jid WHERE c.jid=?`).get(jid)?.n
  || d.prepare('SELECT COALESCE(name,notify) n FROM contacts WHERE jid=?').get(jid)?.n || jid;
const fmt = (ts) => new Date(ts * 1000).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' });
const out = (rows, line) => JSONOUT ? console.log(JSON.stringify(rows, null, 1)) : rows.forEach(r => console.log(line(r)));
const msgLine = (d) => (m) => `${fmt(m.ts)}  ${m.from_me ? 'me' : (m.push_name || nameOf(d, m.sender))}: ${m.text || '[' + m.type + ']'}`;

const HELP = `wa — WhatsApp skill (Baileys linked device)
  wa link                     link via QR (PNG at ${QR}, refreshes); keeps running as daemon after connect
  wa daemon                   run the socket: stores history/messages/chats/contacts, appends inbound to inbox.jsonl, sends outbox
  wa status                   link/daemon status and store counts
  wa chats [--limit N]        recent chats
  wa read <name|jid> [-n N]   last N messages of a chat (default 20)
  wa search <text> [-n N]     full-text-ish search over stored messages
  wa new [--since <ts>]       inbound messages since unix ts / ISO time (default: last 'new' call)
  wa send <name|jid> <text>   preview only; add --yes to actually send (daemon must be running)
  Common: --json. State dir: ${HOME} (WA_BRIDGE_DIR); QR: ${QR} (WA_QR_PNG)`;

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return console.log(HELP);
  if (cmd === 'link' || cmd === 'daemon') {
    if (cmd === 'daemon' && !fs.existsSync(path.join(AUTH, 'creds.json'))) { console.error('Not linked yet. Run `wa link` first.'); process.exit(1); }
    return runSocket({});
  }
  const d = db();
  if (cmd === 'status') {
    const linked = fs.existsSync(path.join(AUTH, 'creds.json')); let st = {}; try { st = JSON.parse(fs.readFileSync(path.join(HOME, 'status.json'), 'utf8')); } catch {}
    let pid = null; try { pid = Number(fs.readFileSync(PIDF, 'utf8')); process.kill(pid, 0); } catch { pid = null; }
    const c = (t) => d.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const s = { linked, daemon_pid: pid, connected: pid ? !!st.connected : false, me: st.me ? st.me.split(':')[0] : null, chats: c('chats'), contacts: c('contacts'), messages: c('messages') };
    return console.log(JSONOUT ? JSON.stringify(s) : Object.entries(s).map(([k, v]) => `${k}: ${v}`).join('\n'));
  }
  if (cmd === 'chats') return out(d.prepare('SELECT jid, last_ts, unread FROM chats ORDER BY last_ts DESC LIMIT ?').all(Number(opt('--limit', 30))).map(r => ({ ...r, name: nameOf(d, r.jid) })),
    r => `${r.last_ts ? fmt(r.last_ts) : '-'}  ${r.unread ? `(${r.unread}) ` : ''}${r.name}  ${r.jid}`);
  if (cmd === 'read') { const jid = resolveJid(d, pos[0] || ''); const n = Number(opt('-n', 20));
    if (!JSONOUT) console.log(`# ${nameOf(d, jid)} (${jid})`);
    return out(d.prepare('SELECT * FROM (SELECT * FROM messages WHERE jid=? ORDER BY ts DESC LIMIT ?) ORDER BY ts').all(jid, n), msgLine(d)); }
  if (cmd === 'search') return out(d.prepare('SELECT * FROM messages WHERE text LIKE ? ORDER BY ts DESC LIMIT ?').all(`%${pos.join(' ')}%`, Number(opt('-n', 30))),
    m => `[${nameOf(d, m.jid)}] ` + msgLine(d)(m));
  if (cmd === 'new') {
    const cur = path.join(HOME, 'new.cursor'); let since = opt('--since');
    since = since ? (/^\d+$/.test(since) ? Number(since) : Math.floor(Date.parse(since) / 1000)) : Number(fs.existsSync(cur) ? fs.readFileSync(cur, 'utf8') : 0);
    const rows = fs.existsSync(INBOX) ? fs.readFileSync(INBOX, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.ts > since) : [];
    if (rows.length) fs.writeFileSync(cur, String(Math.max(...rows.map(r => r.ts))));
    return out(rows, m => `${fmt(m.ts)}  [${m.chat_name || m.jid}${m.group ? ' (group)' : ''}] ${m.push_name || ''}: ${m.text}`);
  }
  if (cmd === 'send') {
    const jid = resolveJid(d, pos[0] || ''); const text = pos.slice(1).join(' ');
    if (!text) throw new Error('usage: wa send <name|jid> <text> [--yes]');
    console.log(`To:   ${nameOf(d, jid)} (${jid})\nText: ${text}`);
    if (!flag('--yes')) return console.log('\nPREVIEW ONLY — nothing sent. Re-run with --yes to send.');
    fs.mkdirSync(OUTBOX, { recursive: true, mode: 0o700 }); const f = path.join(OUTBOX, `${Date.now()}.json`);
    fs.writeFileSync(f + '.tmp', JSON.stringify({ jid, text })); fs.renameSync(f + '.tmp', f);
    const done = f.replace(/\.json$/, '.done');
    for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 1000)); if (fs.existsSync(done)) { const r = JSON.parse(fs.readFileSync(done, 'utf8')); fs.unlinkSync(done);
      if (r.ok) return console.log(`sent (id ${r.id})`); throw new Error('send failed: ' + r.error); } }
    throw new Error('daemon did not pick up the message within 30s (is `wa daemon` running?). Job left in outbox: ' + f);
  }
  console.error(HELP); process.exit(1);
}
main().catch(e => { console.error('error:', e.message); process.exit(1); });
