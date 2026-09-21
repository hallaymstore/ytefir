import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import webpush from 'web-push';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || '';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const APP_SECRET = process.env.APP_SECRET || 'change-me-too';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const YT_API_KEY_ENV = process.env.YOUTUBE_API_KEY || '';
const MONITOR_INTERVAL_MS = Math.max(5000, Number(process.env.MONITOR_INTERVAL_MS || 10000));
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUPPORT_URL = 'https://support.google.com/youtube/gethelp';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:admin@localhost', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://i.ytimg.com'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      mediaSrc: ["'self'", 'blob:'],
      frameSrc: ['https://www.youtube.com', 'https://www.youtube-nocookie.com']
    }
  }
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const settingSchema = new mongoose.Schema({
  singleton: { type: String, default: 'main', unique: true },
  videoId: { type: String, default: '' },
  channelId: { type: String, default: '' },
  streamKeyEnc: { type: String, default: '' },
  youtubeApiKeyEnc: { type: String, default: '' },
  quality: { type: String, default: '720x1280' },
  autoProtect: { type: Boolean, default: false },
  riskThreshold: { type: Number, default: 75 }
}, { timestamps: true });

const sampleSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now, index: true },
  videoId: String,
  concurrent: Number,
  views: Number,
  likes: Number,
  risk: Number,
  reasons: [String]
}, { versionKey: false });

const incidentSchema = new mongoose.Schema({
  ts: { type: Date, default: Date.now, index: true },
  videoId: String,
  severity: { type: String, enum: ['warning', 'high', 'critical'], default: 'warning' },
  risk: Number,
  concurrent: Number,
  baseline: Number,
  delta: Number,
  reasons: [String],
  reportText: String,
  acknowledged: { type: Boolean, default: false }
}, { timestamps: true });

const pushSchema = new mongoose.Schema({
  endpoint: { type: String, unique: true },
  subscription: mongoose.Schema.Types.Mixed
}, { timestamps: true });

const Setting = mongoose.model('Setting', settingSchema);
const Sample = mongoose.model('Sample', sampleSchema);
const Incident = mongoose.model('Incident', incidentSchema);
const PushSub = mongoose.model('PushSub', pushSchema);

function key32() {
  return crypto.createHash('sha256').update(APP_SECRET).digest();
}
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key32(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decrypt(payload) {
  if (!payload) return '';
  try {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key32(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function signToken() {
  return jwt.sign({ sub: ADMIN_USER, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
}
function authFromCookieHeader(cookieHeader = '') {
  const tokenPair = cookieHeader.split(';').map(v => v.trim()).find(v => v.startsWith('ytshield='));
  if (!tokenPair) return null;
  try { return jwt.verify(decodeURIComponent(tokenPair.slice('ytshield='.length)), JWT_SECRET); } catch { return null; }
}
function auth(req, res, next) {
  const token = req.cookies?.ytshield;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const okUser = crypto.timingSafeEqual(Buffer.from(String(username || '').padEnd(ADMIN_USER.length, '\0').slice(0, ADMIN_USER.length)), Buffer.from(ADMIN_USER));
  const passA = crypto.createHash('sha256').update(String(password || '')).digest();
  const passB = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!okUser || !crypto.timingSafeEqual(passA, passB)) return res.status(401).json({ error: 'Login yoki parol xato' });
  res.cookie('ytshield', signToken(), { httpOnly: true, secure: true, sameSite: 'strict', maxAge: 12 * 60 * 60 * 1000 });
  res.json({ ok: true, user: ADMIN_USER });
});
app.post('/api/auth/logout', auth, (req, res) => {
  res.clearCookie('ytshield', { httpOnly: true, secure: true, sameSite: 'strict' });
  res.json({ ok: true });
});
app.get('/api/auth/me', auth, (req, res) => res.json({ ok: true, user: req.user.sub }));

async function getSettings() {
  let s = await Setting.findOne({ singleton: 'main' });
  if (!s) s = await Setting.create({ singleton: 'main' });
  return s;
}

app.get('/api/config', auth, async (req, res) => {
  const s = await getSettings();
  res.json({
    videoId: s.videoId,
    channelId: s.channelId,
    quality: s.quality,
    autoProtect: s.autoProtect,
    riskThreshold: s.riskThreshold,
    hasStreamKey: Boolean(s.streamKeyEnc),
    hasApiKey: Boolean(s.youtubeApiKeyEnc || YT_API_KEY_ENV),
    monitorIntervalMs: MONITOR_INTERVAL_MS,
    vapidPublicKey: VAPID_PUBLIC_KEY
  });
});

app.put('/api/config', auth, async (req, res) => {
  const s = await getSettings();
  const { videoId, channelId, streamKey, youtubeApiKey, quality, autoProtect, riskThreshold, clearStreamKey, clearApiKey } = req.body || {};
  if (typeof videoId === 'string') s.videoId = videoId.trim();
  if (typeof channelId === 'string') s.channelId = channelId.trim();
  if (typeof quality === 'string' && ['540x960','720x1280','1080x1920'].includes(quality)) s.quality = quality;
  if (typeof autoProtect === 'boolean') s.autoProtect = autoProtect;
  if (Number.isFinite(Number(riskThreshold))) s.riskThreshold = Math.max(50, Math.min(99, Number(riskThreshold)));
  if (typeof streamKey === 'string' && streamKey.trim()) s.streamKeyEnc = encrypt(streamKey.trim());
  if (clearStreamKey) s.streamKeyEnc = '';
  if (typeof youtubeApiKey === 'string' && youtubeApiKey.trim()) s.youtubeApiKeyEnc = encrypt(youtubeApiKey.trim());
  if (clearApiKey) s.youtubeApiKeyEnc = '';
  await s.save();
  res.json({ ok: true });
});

const liveState = {
  ingestActive: false,
  ffmpegPid: null,
  startedAt: null,
  lastError: '',
  monitor: { connected: false, videoId: '', concurrent: 0, views: 0, likes: 0, risk: 0, reasons: [], updatedAt: null }
};

app.get('/api/live/status', auth, (req, res) => res.json(liveState));
app.get('/api/incidents', auth, async (req, res) => {
  const items = await Incident.find().sort({ ts: -1 }).limit(50).lean();
  res.json(items);
});
app.post('/api/incidents/:id/ack', auth, async (req, res) => {
  await Incident.findByIdAndUpdate(req.params.id, { acknowledged: true });
  res.json({ ok: true });
});
app.get('/api/incidents/:id/report', auth, async (req, res) => {
  const incident = await Incident.findById(req.params.id).lean();
  if (!incident) return res.status(404).json({ error: 'Topilmadi' });
  res.json({ reportText: incident.reportText, supportUrl: SUPPORT_URL, incident });
});
app.post('/api/incidents/manual', auth, async (req, res) => {
  const s = await getSettings();
  const m = liveState.monitor;
  const now = new Date();
  const reportText = buildReport({ ts: now, videoId: s.videoId, risk: m.risk, concurrent: m.concurrent, baseline: m.concurrent, delta: 0, reasons: ['Manual evidence capture'] });
  const incident = await Incident.create({ ts: now, videoId: s.videoId, severity: 'warning', risk: m.risk, concurrent: m.concurrent, baseline: m.concurrent, delta: 0, reasons: ['Manual evidence capture'], reportText });
  res.json({ ok: true, incident, supportUrl: SUPPORT_URL });
});

app.post('/api/push/subscribe', auth, async (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  await PushSub.findOneAndUpdate({ endpoint: sub.endpoint }, { subscription: sub }, { upsert: true, new: true });
  res.json({ ok: true });
});

function buildReport({ ts, videoId, risk, concurrent, baseline, delta, reasons }) {
  return [
    'YouTube LIVE suspicious / potentially invalid traffic evidence',
    `UTC time: ${new Date(ts).toISOString()}`,
    `Video ID: ${videoId || 'unknown'}`,
    `Concurrent viewers: ${concurrent ?? 'n/a'}`,
    `Recent baseline: ${baseline ?? 'n/a'}`,
    `Sudden delta: ${delta ?? 'n/a'}`,
    `Risk score (local heuristic): ${risk ?? 'n/a'}%`,
    `Signals: ${(reasons || []).join('; ') || 'none'}`,
    '',
    'This report was generated by a local monitoring tool. It does not claim YouTube has confirmed invalid traffic. Please review server-side traffic quality and the stream analytics around the timestamp above.'
  ].join('\n');
}

async function sendPush(title, body, data = {}) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  const subs = await PushSub.find().lean();
  await Promise.allSettled(subs.map(async ({ _id, subscription }) => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify({ title, body, data }));
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await PushSub.deleteOne({ _id });
    }
  }));
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
const sockets = new Set();
let activeIngest = null;

function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const ws of sockets) {
    if (ws.readyState === 1) {
      try { ws.send(text); } catch {}
    }
  }
}

server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) return socket.destroy();
  const user = authFromCookieHeader(req.headers.cookie || '');
  if (!user) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    ws.user = user;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  sockets.add(ws);
  let proc = null;
  let ingest = false;

  ws.send(JSON.stringify({ type: 'hello', liveState }));

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      if (ingest && proc?.stdin?.writable) {
        if (!proc.stdin.write(data)) ws.pause?.();
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'start-ingest') {
      if (activeIngest && activeIngest !== ws) {
        ws.send(JSON.stringify({ type: 'ingest-error', error: 'Boshqa LIVE sessiya faol' }));
        return;
      }
      const s = await getSettings();
      const streamKey = decrypt(s.streamKeyEnc);
      if (!streamKey) {
        ws.send(JSON.stringify({ type: 'ingest-error', error: 'YouTube stream key kiritilmagan' }));
        return;
      }
      // Shorts Live mode is fixed to vertical 9:16. Ignore client-provided dimensions.
      const w = 720;
      const h = 1280;
      const fps = 30;
      const bitrate = '3200k';
      const outUrl = `rtmps://a.rtmps.youtube.com/live2/${streamKey}`;
      const args = [
        '-hide_banner', '-loglevel', 'warning',
        '-fflags', '+genpts', '-f', 'webm', '-i', 'pipe:0',
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
        '-r', String(fps), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', '6400k',
        '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-f', 'flv', outUrl
      ];
      proc = spawn(ffmpeg.path, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      activeIngest = ws;
      ingest = true;
      liveState.ingestActive = true;
      liveState.ffmpegPid = proc.pid;
      liveState.startedAt = new Date().toISOString();
      liveState.lastError = '';
      proc.stderr.on('data', chunk => {
        const line = chunk.toString().trim();
        if (line) liveState.lastError = line.slice(-500);
      });
      proc.on('close', code => {
        liveState.ingestActive = false;
        liveState.ffmpegPid = null;
        activeIngest = null;
        ingest = false;
        broadcast({ type: 'ingest-stopped', code, lastError: liveState.lastError });
      });
      ws.send(JSON.stringify({ type: 'ingest-ready', quality: `${w}x${h}`, fps }));
      broadcast({ type: 'live-state', liveState });
      return;
    }

    if (msg.type === 'stop-ingest') {
      try { proc?.stdin?.end(); } catch {}
      setTimeout(() => { try { proc?.kill('SIGTERM'); } catch {} }, 500);
    }
  });

  ws.on('close', () => {
    sockets.delete(ws);
    if (ingest) {
      try { proc?.stdin?.end(); } catch {}
      try { proc?.kill('SIGTERM'); } catch {}
      activeIngest = null;
      liveState.ingestActive = false;
      liveState.ffmpegPid = null;
    }
  });
});

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function calculateRisk(current) {
  const recent = await Sample.find({ videoId: current.videoId }).sort({ ts: -1 }).limit(12).lean();
  if (!recent.length) return { risk: 0, reasons: [], baseline: current.concurrent, delta: 0 };
  const baseline = Math.max(1, Math.round(median(recent.slice(0, 8).map(x => Number(x.concurrent || 0)))));
  const prev = Number(recent[0]?.concurrent || 0);
  const delta = current.concurrent - prev;
  const ratio = current.concurrent / baseline;
  const pctJump = prev > 0 ? (delta / prev) * 100 : 0;
  let risk = 0;
  const reasons = [];

  if (delta >= 100 && pctJump >= 80) { risk += 30; reasons.push(`keskin sakrash +${delta} (${Math.round(pctJump)}%)`); }
  if (delta >= 500) { risk += 20; reasons.push(`10s ichida +${delta} viewer`); }
  if (ratio >= 3) { risk += 25; reasons.push(`baseline'dan ${ratio.toFixed(1)}x yuqori`); }
  if (ratio >= 7) { risk += 15; reasons.push('juda noodatiy ko‘payish'); }
  const likeDelta = current.likes - Number(recent[0]?.likes || 0);
  if (delta >= 300 && likeDelta <= Math.max(2, delta * 0.002)) { risk += 10; reasons.push('viewer sakrashiga nisbatan like o‘sishi juda past'); }
  const prevRisk = Number(recent[0]?.risk || 0);
  if (prevRisk >= 65 && risk >= 60) { risk += 10; reasons.push('anomaliya ketma-ket davom etmoqda'); }
  risk = Math.min(100, Math.max(0, Math.round(risk)));
  return { risk, reasons, baseline, delta };
}

let incidentCooldownUntil = 0;
async function pollYouTube() {
  try {
    const s = await getSettings();
    const videoId = s.videoId?.trim();
    const apiKey = decrypt(s.youtubeApiKeyEnc) || YT_API_KEY_ENV;
    if (!videoId || !apiKey) {
      liveState.monitor.connected = false;
      return;
    }
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', 'liveStreamingDetails,statistics,snippet');
    url.searchParams.set('id', videoId);
    url.searchParams.set('key', apiKey);
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`YouTube API ${r.status}`);
    const j = await r.json();
    const item = j.items?.[0];
    if (!item) throw new Error('Video topilmadi');
    const current = {
      videoId,
      concurrent: Number(item.liveStreamingDetails?.concurrentViewers || 0),
      views: Number(item.statistics?.viewCount || 0),
      likes: Number(item.statistics?.likeCount || 0)
    };
    const riskData = await calculateRisk(current);
    const sample = await Sample.create({ ...current, risk: riskData.risk, reasons: riskData.reasons });
    liveState.monitor = {
      connected: true,
      videoId,
      concurrent: current.concurrent,
      views: current.views,
      likes: current.likes,
      risk: riskData.risk,
      reasons: riskData.reasons,
      updatedAt: sample.ts
    };
    broadcast({ type: 'monitor', monitor: liveState.monitor });

    const threshold = Number(s.riskThreshold || 75);
    if (riskData.risk >= threshold && Date.now() > incidentCooldownUntil) {
      incidentCooldownUntil = Date.now() + 3 * 60 * 1000;
      const severity = riskData.risk >= 90 ? 'critical' : 'high';
      const reportText = buildReport({ ts: new Date(), videoId, risk: riskData.risk, concurrent: current.concurrent, baseline: riskData.baseline, delta: riskData.delta, reasons: riskData.reasons });
      const incident = await Incident.create({ videoId, severity, risk: riskData.risk, concurrent: current.concurrent, baseline: riskData.baseline, delta: riskData.delta, reasons: riskData.reasons, reportText });
      broadcast({ type: 'incident', incident });
      await sendPush('YT Shield: shubhali trafik', `${riskData.risk}% risk • ${current.concurrent.toLocaleString()} viewer`, { incidentId: incident.id });

      // Optional server-side emergency automation. OFF by default.
      // When enabled by the user, only a very high local risk score can hide the current LIVE.
      if (s.autoProtect && riskData.risk >= 95 && videoId) {
        try {
          const protectUrl = new URL('https://www.googleapis.com/youtube/v3/liveBroadcasts');
          protectUrl.searchParams.set('part', 'status');
          protectUrl.searchParams.set('key', '__OAUTH__');
          const pr = await fetch(protectUrl, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: videoId,
              status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false }
            }),
            signal: AbortSignal.timeout(10000)
          });
          if (!pr.ok) throw new Error(`YouTube protect HTTP ${pr.status}`);
          await sendPush('YT Shield: Auto Protect', 'Critical risk sabab LIVE vaqtincha Unlisted qilindi.', { incidentId: incident.id });
          broadcast({ type: 'auto-protect', privacyStatus: 'unlisted', incidentId: incident.id });
        } catch (protectErr) {
          console.warn('[auto-protect]', protectErr.message || protectErr);
        }
      }
    }
  } catch (e) {
    liveState.monitor.connected = false;
    liveState.monitor.updatedAt = new Date().toISOString();
    broadcast({ type: 'monitor-error', error: String(e.message || e) });
  }
}

setInterval(pollYouTube, MONITOR_INTERVAL_MS).unref();
setTimeout(pollYouTube, 2500).unref();

app.get('/health', (req, res) => res.json({ ok: true, mongo: mongoose.connection.readyState === 1, ingest: liveState.ingestActive }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function boot() {
  if (!MONGODB_URI) throw new Error('MONGODB_URI required');
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 12000 });
  server.listen(PORT, '0.0.0.0', () => console.log(`YT Shield Live running on :${PORT}`));
}

boot().catch(err => {
  console.error(err);
  process.exit(1);
});
