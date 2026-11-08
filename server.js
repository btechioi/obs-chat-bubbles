#!/usr/bin/env node
/**
 * obs-chat-bubbles — local YouTube live-chat -> OBS browser-source overlay.
 *
 * No API key required: reads the public live chat via YouTube's Innertube API.
 * Serves:
 *   /              control panel (set channel/video, style, copy OBS URL)
 *   /overlay       transparent overlay page for OBS
 *   /events        SSE stream of chat events
 *   /api/status    JSON status for the control panel
 *
 * Env: PORT (default 4919), HOST (default 127.0.0.1)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { Innertube, Log } from 'youtubei.js';
import { createTts, nameForSpeech } from './tts.js';

// YouTube.js prints parser warnings for every unknown renderer; silence them.
Log.setLevel(0);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4919);
const HOST = process.env.HOST || '127.0.0.1';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const MAX_BUFFER = 60;

/* ------------------------------------------------------------------ utils */

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortErr = (e) =>
  String(e?.message ?? e ?? 'unknown error')
    .split('\n')[0]
    .slice(0, 300);

const tts = createTts(__dirname, log);

/* --------------------------------------------------------------- mic level */

class MicHub {
  constructor() {
    this.clients = new Set();
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.lastSent = 0;
    this.failLogged = false;
    this.idleTimer = null;
    this.retryTimer = null;
    this.device = process.env.MIC_DEVICE || '';
    this.level = 0;
  }

  add(res) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.clients.add(res);
    this.start();
    res.write(`event: level\ndata: ${JSON.stringify({ level: 0 })}\n\n`);
  }

  remove(res) {
    this.clients.delete(res);
    if (this.clients.size === 0) {
      this.idleTimer = setTimeout(() => this.stop(), 5000);
    }
  }

  send(level) {
    const payload = `event: level\ndata: ${JSON.stringify({ level })}\n\n`;
    for (const r of this.clients) {
      try {
        r.write(payload);
      } catch {
        /* gone */
      }
    }
  }

  setDevice(name) {
    if (name === this.device) return;
    this.device = name || '';
    this.stop();
    if (this.clients.size > 0) setTimeout(() => this.start(), 200);
  }

  devices() {
    try {
      const r = spawnSync('pactl', ['list', 'short', 'sources'], { encoding: 'utf8', timeout: 2000 });
      const names = (r.stdout || '')
        .split('\n')
        .map((l) => l.split('\t')[1])
        .filter(Boolean);
      return names.map((name) => ({
        name,
        label: name.replace('alsa_', '').replace(/\.analog-stereo$/, '').replace(/[._]/g, ' '),
        monitor: name.endsWith('.monitor'),
      }));
    } catch {
      return [];
    }
  }

  start() {
    if (this.proc) return;
    let device = this.device;
    if (!device) try {
      // Prefer a real input; some desktops leave the default source on a
      // monitor (system audio), which would lip-sync to the wrong thing.
      const list = spawnSync('pactl', ['list', 'short', 'sources'], { encoding: 'utf8', timeout: 2000 });
      const names = (list.stdout || '')
        .split('\n')
        .map((l) => l.split('\t')[1])
        .filter(Boolean);
      const def = spawnSync('pactl', ['get-default-source'], { encoding: 'utf8', timeout: 2000 });
      const defName = (def.stdout || '').trim();
      device =
        process.env.MIC_DEVICE ||
        (defName && names.includes(defName) && !defName.endsWith('.monitor') ? defName : '') ||
        names.find((n) => !n.endsWith('.monitor')) ||
        defName ||
        '';
    } catch {
      /* fall back to default */
    }
    const args = ['--format=s16le', '--rate=16000', '--channels=1', '--latency-msec=30'];
    if (device) args.unshift(`--device=${device}`);
    try {
      this.proc = spawn('parec', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      this.proc = null;
      return;
    }
    this.proc.on('error', (e) => {
      if (!this.failLogged) log('[mic] capture unavailable:', shortErr(e));
      this.failLogged = true;
      this.proc = null;
    });
    this.proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg && !this.failLogged) log('[mic] parec:', msg.slice(0, 160));
    });
    this.proc.on('close', () => {
      this.proc = null;
      // Keep trying while someone is watching the avatar.
      if (this.clients.size > 0) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.start(), 3000);
      }
    });
    this.proc.stdout.on('data', (data) => {
      this.buf = Buffer.concat([this.buf, data]);
      while (this.buf.length >= 640) {
        const chunk = this.buf.subarray(0, 640);
        this.buf = this.buf.subarray(640);
        let sum = 0;
        for (let i = 0; i < chunk.length; i += 2) {
          const v = chunk.readInt16LE(i) / 32768;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / (chunk.length / 2));
        const now = Date.now();
        if (now - this.lastSent >= 50) {
          this.lastSent = now;
          this.level = Math.min(1, Math.round(rms * 1000) / 1000);
          this.send(this.level);
        }
      }
    });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}

const mic = new MicHub();

/* ------------------------------------------------------------ avatar config */

const AVATAR_DEFAULTS = {
  x: 0.99,
  y: 0.99,
  size: 0.94,
  flip: false,
  tts: true,
  mic: true,
  gain: 1.6,
  micDevice: '',
  colors: {
    hair: '#2b3049',
    hoodie: '#2f3d5c',
    eye: '#ffb347',
    skin: '#ffe6d5',
    ears: '#f7a8b8',
  },
};

const AVATAR_CFG_FILE = path.join(__dirname, 'avatar-config.json');
const avatarClients = new Set();
let avatarConfig = loadAvatarConfig();
mic.setDevice(avatarConfig.micDevice || '');

function cloneDefaults() {
  return JSON.parse(JSON.stringify(AVATAR_DEFAULTS));
}

function loadAvatarConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(AVATAR_CFG_FILE, 'utf8'));
    return sanitizeAvatar({ ...cloneDefaults(), ...raw, colors: { ...AVATAR_DEFAULTS.colors, ...(raw.colors || {}) } });
  } catch {
    return cloneDefaults();
  }
}

function sanitizeAvatar(cfg) {
  const num = (v, min, max, d) => (Number.isFinite(+v) ? Math.min(max, Math.max(min, +v)) : d);
  const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);
  const out = {
    x: num(cfg.x, 0, 1, AVATAR_DEFAULTS.x),
    y: num(cfg.y, 0, 1, AVATAR_DEFAULTS.y),
    size: num(cfg.size, 0.25, 1.6, AVATAR_DEFAULTS.size),
    flip: !!cfg.flip,
    tts: cfg.tts !== false,
    mic: cfg.mic !== false,
    gain: num(cfg.gain, 0.2, 6, AVATAR_DEFAULTS.gain),
    micDevice: typeof cfg.micDevice === 'string' ? cfg.micDevice.slice(0, 200) : '',
    colors: {},
  };
  for (const k of Object.keys(AVATAR_DEFAULTS.colors)) {
    out.colors[k] = hex(cfg.colors?.[k], AVATAR_DEFAULTS.colors[k]);
  }
  return out;
}

function saveAvatarConfig() {
  try {
    fs.writeFileSync(AVATAR_CFG_FILE, JSON.stringify(avatarConfig, null, 2));
  } catch (e) {
    log('[avatar] could not save config:', shortErr(e));
  }
}

function broadcastAvatar(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of avatarClients) {
    try {
      r.write(payload);
    } catch {
      /* gone */
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}





function parseTarget(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;

  // Direct video id anywhere in a watch/youtu.be URL.
  let m = s.match(/(?:youtu\.be\/|[?&]v=)([A-Za-z0-9_-]{11})/);
  if (m) return { kind: 'video', value: m[1] };
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return { kind: 'video', value: s };

  // Channel handle.
  m = s.match(/youtube\.com\/@([^/?#]+)/i);
  if (m) return { kind: 'channel', value: '@' + m[1] };
  if (s.startsWith('@')) return { kind: 'channel', value: s };

  // Channel id.
  m = s.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/i);
  if (m) return { kind: 'channel_id', value: m[1] };
  if (/^UC[A-Za-z0-9_-]{22}$/.test(s)) return { kind: 'channel_id', value: s };

  // A bare word is treated as a handle.
  if (/^[A-Za-z0-9_.-]+$/.test(s)) return { kind: 'channel', value: '@' + s };
  return null;
}

function argb(n) {
  if (!Number.isFinite(n)) return null;
  const a = ((n >>> 24) & 255) / 255;
  const r = (n >>> 16) & 255;
  const g = (n >>> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

function emojiUrl(run) {
  const u = run?.emoji?.image?.[0]?.url;
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('https://')) return u;
  return null;
}

function plainText(parts) {
  return (parts || [])
    .filter((p) => p.t === 'x')
    .map((p) => p.v)
    .join(' ')
    .trim();
}

function textParts(text) {
  const parts = [];
  for (const run of text?.runs ?? []) {
    const u = emojiUrl(run);
    if (u) parts.push({ t: 'e', u });
    else if (run?.text) parts.push({ t: 'x', v: run.text });
  }
  if (!parts.length) {
    const s = text?.toString?.() ?? '';
    if (s) parts.push({ t: 'x', v: s });
  }
  return parts;
}

const BADGE_ORDER = { owner: 0, mod: 1, member: 2, verified: 3 };

/* ------------------------------------------------------------------- chat */

let innertubePromise = null;
function innertube() {
  if (!innertubePromise) {
    innertubePromise = Innertube.create({
      retrieve_player: false,
      lang: 'en',
      location: 'US',
      generate_session_locally: true,
    }).catch((e) => {
      innertubePromise = null;
      throw e;
    });
  }
  return innertubePromise;
}

async function resolveLiveVideo(target, signal) {
  if (target.kind === 'video') return target.value;

  const base =
    target.kind === 'channel_id'
      ? `https://www.youtube.com/channel/${target.value}/live`
      : `https://www.youtube.com/${target.value}/live`;

  const res = await fetch(base, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal,
  });
  if (!res.ok) return null;
  const html = await res.text();
  if (!/"isLive"\s*:\s*true/.test(html)) return null;
  const m = html.match(
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/
  );
  return m ? m[1] : null;
}

function normalizeItem(item) {
  if (!item || !item.type) return null;

  const author = item.author;
  const name = author?.name || 'viewer';
  const avatar = author?.thumbnails?.[0]?.url || '';
  const badges = [];
  if (author?.is_creator || author?.is_owner) badges.push({ k: 'owner', label: 'OWNER' });
  if (author?.is_moderator) badges.push({ k: 'mod', label: 'MOD' });
  const member = (author?.badges ?? []).some((b) => (b?.custom_thumbnail ?? []).length);
  if (member) badges.push({ k: 'member', label: 'MEMBER' });
  if (author?.is_verified) badges.push({ k: 'verified', label: '✓' });
  badges.sort((a, b) => (BADGE_ORDER[a.k] ?? 9) - (BADGE_ORDER[b.k] ?? 9));

  const base = {
    id: item.id || `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    name,
    avatar,
    badges,
  };

  switch (item.type) {
    case 'LiveChatTextMessage':
      return { ...base, kind: 'text', parts: textParts(item.message) };

    case 'LiveChatPaidMessage': {
      const bg = argb(item.body_background_color) || argb(item.header_background_color);
      const fg = argb(item.body_text_color);
      const parts = textParts(item.message);
      const amount = item.purchase_amount || '';
      return {
        ...base,
        kind: 'paid',
        amount,
        parts,
        colors: { bg, fg },
        speak: `${nameForSpeech(name)} sent ${amount || 'a donation'}. ${plainText(parts)}`.trim(),
      };
    }

    case 'LiveChatPaidSticker':
      return {
        ...base,
        kind: 'paid',
        amount: item.purchase_amount || '',
        parts: [{ t: 'x', v: '🩷 sent a sticker' }],
        colors: { bg: argb(item.background_color), fg: argb(item.money_chip_text_color) },
        speak: `${nameForSpeech(name)} sent a sticker.`,
      };

    case 'LiveChatMembershipItem': {
      const head = item.header_primary_text?.toString?.() || 'New member';
      const sub = item.header_subtext?.toString?.() || '';
      const msg = item.message?.toString?.() || '';
      return {
        ...base,
        kind: 'member',
        parts: [{ t: 'x', v: [head, sub, msg].filter(Boolean).join(' — ') }],
        speak: `${nameForSpeech(name)} just became a member. ${msg}`.trim(),
      };
    }

    case 'LiveChatViewerEngagementMessage':
      return { ...base, name: 'YouTube', kind: 'system', parts: textParts(item.message) };

    default:
      return null;
  }
}

/* ------------------------------------------------------------------- room */

class ChatRoom {
  constructor(target) {
    this.target = target;
    this.key = `${target.kind}:${target.value}`;
    this.clients = new Set();
    this.messages = [];
    this.state = 'connecting';
    this.videoId = null;
    this.title = '';
    this.lastError = '';
    this.started = false;
    this.stopped = false;
    this.ttsClients = 0;
    this.chat = null;
    this.currentFinish = null;
    this.lastClientAt = Date.now();
    this.idleTimer = null;
  }

  broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        /* client gone */
      }
    }
  }

  setState(state, extra = {}) {
    this.state = state;
    if (extra.title !== undefined) this.title = extra.title;
    if (extra.videoId !== undefined) this.videoId = extra.videoId;
    if (extra.lastError !== undefined) this.lastError = extra.lastError;
    this.broadcast('state', {
      state: this.state,
      videoId: this.videoId,
      title: this.title,
      lastError: this.lastError,
    });
  }

  snapshot() {
    return {
      key: this.key,
      state: this.state,
      videoId: this.videoId,
      title: this.title,
      lastError: this.lastError,
      messages: this.messages.length,
      clients: this.clients.size,
    };
  }

  addClient(res, wantsTts = false) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.clients.add(res);
    if (wantsTts) this.ttsClients++;
    this.lastClientAt = Date.now();
    this.ensureRunning();
  }

  removeClient(res) {
    this.clients.delete(res);
    if (res._wantsTts) this.ttsClients = Math.max(0, this.ttsClients - 1);
    if (this.clients.size > 0) return;
    this.lastClientAt = Date.now();
    this.idleTimer = setTimeout(() => {
      if (this.clients.size === 0) this.stop();
    }, 60_000);
  }

  ensureRunning() {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.loop().catch((e) => log(`[${this.key}] loop crashed:`, shortErr(e)));
  }

  stop() {
    this.stopped = true;
    try {
      this.currentFinish?.('stop');
    } catch {
      /* noop */
    }
    try {
      this.chat?.stop();
    } catch {
      /* noop */
    }
    this.chat = null;
    this.started = false;
    this.state = 'idle';
  }

  async loop() {
    while (!this.stopped) {
      try {
        const vid = await resolveLiveVideo(this.target, AbortSignal.timeout(15_000));
        if (this.stopped) break;

        if (!vid) {
          if (this.state !== 'offline') {
            this.setState('offline', { title: '', videoId: null });
            log(`[${this.key}] no live stream right now`);
          }
          await sleep(12_000);
          continue;
        }

        if (vid !== this.videoId) {
          this.videoId = vid;
          this.messages = [];
        }

        const yt = await innertube();
        const info = await yt.getInfo(vid);

        if (!info?.basic_info?.is_live) {
          if (this.state !== 'offline') this.setState('offline', { title: '' });
          await sleep(12_000);
          continue;
        }

        this.title = info.basic_info.title || '';
        this.setState('connecting', { videoId: vid, title: this.title });
        log(`[${this.key}] connected to "${this.title}" (${vid})`);

        const why = await this.runChat(info);
        if (this.stopped) break;

        if (why === 'error') {
          this.setState('error');
          await sleep(8_000);
        } else {
          this.setState('connecting');
          await sleep(4_000);
        }
      } catch (e) {
        if (this.stopped) break;
        this.setState('error', { lastError: shortErr(e) });
        log(`[${this.key}] error:`, shortErr(e));
        await sleep(8_000);
      }
    }
    this.started = false;
    this.state = 'idle';
  }

  runChat(info) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (why) => {
        if (done) return;
        done = true;
        this.currentFinish = null;
        try {
          chat.stop();
        } catch {
          /* noop */
        }
        this.chat = null;
        resolve(why);
      };

      let chat;
      try {
        chat = info.getLiveChat();
      } catch (e) {
        resolve('error');
        return;
      }
      this.chat = chat;
      this.currentFinish = finish;

      chat.on('start', (data) => {
        this.setState('live');
        const initial = data?.actions ?? [];
        for (const action of initial.slice(-30)) this.onAction(action, { initial: true });
      });
      chat.on('chat-update', (action) => this.onAction(action));
      chat.on('error', (e) => {
        this.lastError = shortErr(e);
        log(`[${this.key}] chat error:`, this.lastError);
        finish('error');
      });
      chat.on('end', () => finish('end'));

      try {
        chat.start();
      } catch (e) {
        this.lastError = shortErr(e);
        finish('error');
      }
    });
  }

  speak(msg) {
    if (!tts.ok || this.ttsClients <= 0 || !msg.speak) return;
    tts
      .synthesize(msg.speak)
      .then((r) => {
        if (r && !this.stopped) this.broadcast('tts', { id: msg.id, url: r.url, duration: r.durationMs || 0 });
      })
      .catch((e) => log(`[${this.key}] tts error:`, shortErr(e)));
  }

  onAction(action, opts = {}) {
    if (!action) return;
    const type = action.type;

    if (type === 'AddChatItemAction') {
      this.ingest(action.item, opts);
      return;
    }

    if (type === 'ReplayChatItemAction') {
      for (const sub of action.actions ?? []) {
        if (sub?.type === 'AddChatItemAction') this.ingest(sub.item, { initial: true });
      }
      return;
    }

    if (type === 'MarkChatItemAsDeletedAction') {
      const id = action.target_item_id;
      if (!id) return;
      this.messages = this.messages.filter((m) => m.id !== id);
      this.broadcast('delete', { id });
      return;
    }

    if (type === 'ReplaceChatItemAction') {
      const msg = normalizeItem(action.replacement_item);
      if (msg) {
        this.messages = this.messages.filter((m) => m.id !== msg.id);
        this.push(msg, { silent: true });
      }
    }
  }

  ingest(item, opts = {}) {
    const msg = normalizeItem(item);
    if (!msg) return;
    this.push(msg, opts);
  }

  push(msg, { initial = false, silent = false, ephemeral = false } = {}) {
    if (!ephemeral) {
      this.messages.push(msg);
      if (this.messages.length > MAX_BUFFER) {
        this.messages.splice(0, this.messages.length - MAX_BUFFER);
      }
    }
    if (!initial || this.clients.size) {
      this.broadcast('chat', { ...msg, initial: !!initial, silent: !!silent });
    }
    if (!initial) this.speak(msg);
  }
}

/* ----------------------------------------------------------------- server */

const rooms = new Map();

function getRoom(target) {
  const key = `${target.kind}:${target.value}`;
  let room = rooms.get(key);
  if (!room) {
    room = new ChatRoom(target);
    rooms.set(key, room);
  }
  return room;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveFile(res, file, status = 200) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(status, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  res.setHeader('access-control-allow-origin', '*');

  try {
    if (p === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: [...rooms.values()].map((r) => r.snapshot()) }));
      return;
    }

    if (p === '/avatar/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': avatar\n\n');
      avatarClients.add(res);
      res.write(`event: config\ndata: ${JSON.stringify(avatarConfig)}\n\n`);
      req.on('close', () => avatarClients.delete(res));
      return;
    }

    if (p === '/api/avatar/config') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(avatarConfig));
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        avatarConfig = sanitizeAvatar({
          ...avatarConfig,
          ...body,
          colors: { ...avatarConfig.colors, ...(body.colors || {}) },
        });
        saveAvatarConfig();
        mic.setDevice(avatarConfig.micDevice || '');
        broadcastAvatar('config', avatarConfig);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(avatarConfig));
        return;
      }
      res.writeHead(405).end();
      return;
    }

    if (p === '/api/avatar/action' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const action = String(body.action || '').slice(0, 20);
      if (!['happy', 'blink', 'talk'].includes(action)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      broadcastAvatar('action', { action });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (p === '/api/mic/devices') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ devices: mic.devices(), active: mic.device || '' }));
      return;
    }

    if (p === '/api/mic/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ level: mic.level, running: !!mic.proc, device: mic.device || '', clients: mic.clients.size }));
      return;
    }

    if (p === '/mic') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': mic-level\n\n');
      mic.add(res);
      req.on('close', () => mic.remove(res));
      return;
    }

    if (p === '/api/test/donation') {
      const target = parseTarget(url.searchParams.get('target') || '');
      if (!target) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid target' }));
        return;
      }
      const name = url.searchParams.get('name') || '@test_donor';
      const amount = url.searchParams.get('amount') || '₹250';
      const text = (url.searchParams.get('text') || 'Testing the cat boy avatar!').slice(0, 180);
      const msg = {
        id: 'test-' + Date.now(),
        at: Date.now(),
        name,
        avatar: '',
        badges: [{ k: 'owner', label: 'TEST' }],
        kind: 'paid',
        amount,
        parts: [{ t: 'x', v: text }],
        speak: `${nameForSpeech(name)} sent ${amount}. ${text}`,
      };
      const room = getRoom(target);
      room.push(msg, { ephemeral: true });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, room: room.key }));
      return;
    }

    if (p === '/events') {
      const target = parseTarget(url.searchParams.get('target') || url.searchParams.get('channel') || url.searchParams.get('v'));
      if (!target) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('missing or invalid target (?target=@handle or ?target=VIDEO_ID)');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');

      const room = getRoom(target);
      const wantsTts = url.searchParams.get('tts') === '1';
      res._wantsTts = wantsTts;
      room.addClient(res, wantsTts);
      res.write(
        `event: hello\ndata: ${JSON.stringify({
          state: room.state,
          videoId: room.videoId,
          title: room.title,
          messages: room.messages.slice(-40),
        })}\n\n`
      );

      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* noop */
        }
      }, 15_000);

      req.on('close', () => {
        clearInterval(ping);
        room.removeClient(res);
      });
      return;
    }

    if (p.startsWith('/tts/')) {
      const name = p.slice('/tts/'.length);
      if (!/^[a-f0-9]{40}\.wav$/.test(name)) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const file = path.join(tts.cacheDir, name);
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
          return;
        }
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': buf.length,
          'cache-control': 'public, max-age=31536000, immutable',
        });
        res.end(buf);
      });
      return;
    }

    if (p === '/api/tts/ack') {
      const ok = url.searchParams.get('ok') === '1';
      log(`[tts] playback ${ok ? 'started' : 'blocked: ' + (url.searchParams.get('e') || 'unknown')}`);
      res.writeHead(204).end();
      return;
    }

    if (p === '/api/tts/test') {
      const text = (url.searchParams.get('text') || 'Someone sent 250 rupees. Great stream!').slice(0, 300);
      if (!tts.ok) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no tts engine' }));
        return;
      }
      const r = await tts.synthesize(text);
      if (!r) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'synthesis failed' }));
        return;
      }
      fs.readFile(r.file, (err, buf) => {
        if (err) {
          res.writeHead(500).end('error');
          return;
        }
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length, 'cache-control': 'no-store' });
        res.end(buf);
      });
      return;
    }

    if (p === '/api/status') {
      const target = parseTarget(url.searchParams.get('target') || '');
      const room = target ? rooms.get(`${target.kind}:${target.value}`) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          target: target ? room?.snapshot() ?? { state: 'idle', messages: 0 } : null,
          rooms: [...rooms.values()].map((r) => r.snapshot()),
          tts: { ok: tts.ok, engine: tts.engine, voice: tts.voice },
        })
      );
      return;
    }

    if (p === '/api/preview') {
      // A few sample bubbles so the control panel can show the design offline.
      const target = parseTarget(url.searchParams.get('target') || '');
      const room = target ? rooms.get(`${target.kind}:${target.value}`) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messages: room?.messages.slice(-20) ?? [] }));
      return;
    }

    if (p === '/overlay' || p === '/overlay/') {
      serveFile(res, path.join(PUBLIC_DIR, 'overlay.html'));
      return;
    }

    if (p === '/avatar' || p === '/avatar/') {
      serveFile(res, path.join(PUBLIC_DIR, 'avatar.html'));
      return;
    }

    if (p === '/model' || p === '/model/') {
      serveFile(res, path.join(PUBLIC_DIR, 'model.html'));
      return;
    }

    if (p === '/' || p === '/index.html') {
      serveFile(res, path.join(PUBLIC_DIR, 'control.html'));
      return;
    }

    if (p.startsWith('/assets/')) {
      const rel = p.slice('/assets/'.length);
      const file = path.join(PUBLIC_DIR, path.normalize(rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      serveFile(res, file);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    log('request error:', shortErr(e));
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  }
});

server.listen(PORT, HOST, () => {
  log(`obs-chat-bubbles listening on http://${HOST}:${PORT}`);
  log(`control panel: http://${HOST}:${PORT}/   overlay: http://${HOST}:${PORT}/overlay?target=@yourhandle`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down`);
    for (const room of rooms.values()) room.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
