import express from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const APP_URL = String(process.env.APP_URL || 'https://ytefir.onrender.com').replace(/\/+$/, '');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const APP_SECRET = process.env.APP_SECRET || 'change-me-too';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const OAUTH_REDIRECT_URI = `${APP_URL}/auth/youtube/callback`;
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const OAUTH_MAGIC_KEY = '__OAUTH__';
const nativeFetch = globalThis.fetch.bind(globalThis);

let accessCache = { token: '', expiresAt: 0 };

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
    const [ivB64, tagB64, dataB64] = String(payload).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key32(), Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
function cookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i < 1) continue;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}
function adminToken() {
  return jwt.sign({ sub: ADMIN_USER, role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
}
function isAdmin(req) {
  const token = cookies(req).ytshield;
  if (!token) return false;
  try { jwt.verify(token, JWT_SECRET); return true; } catch { return false; }
}
function oauthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}
function db() {
  if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) throw new Error('MongoDB hali tayyor emas');
  return mongoose.connection.db;
}
async function getOAuthDoc() {
  return db().collection('youtubeoauth').findOne({ _id: 'main' });
}
async function saveOAuthDoc(patch) {
  await db().collection('youtubeoauth').updateOne(
    { _id: 'main' },
    { $set: { ...patch, updatedAt: new Date() } },
    { upsert: true }
  );
}
async function getSettingDoc() {
  return db().collection('settings').findOne({ singleton: 'main' }) || {};
}
async function updateSettingDoc(patch) {
  await db().collection('settings').updateOne(
    { singleton: 'main' },
    { $set: { ...patch, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function tokenRequest(params) {
  const r = await nativeFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(12000)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error || `OAuth token HTTP ${r.status}`);
  return data;
}

async function getAccessToken() {
  if (accessCache.token && accessCache.expiresAt > Date.now() + 60_000) return accessCache.token;
  const doc = await getOAuthDoc();
  const storedAccess = decrypt(doc?.accessTokenEnc);
  const storedExpiresAt = Number(doc?.expiresAt || 0);
  if (storedAccess && storedExpiresAt > Date.now() + 60_000) {
    accessCache = { token: storedAccess, expiresAt: storedExpiresAt };
    return storedAccess;
  }
  const refreshToken = decrypt(doc?.refreshTokenEnc);
  if (!refreshToken || !oauthConfigured()) return '';
  const data = await tokenRequest({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  const expiresAt = Date.now() + Math.max(300, Number(data.expires_in || 3600)) * 1000;
  accessCache = { token: data.access_token, expiresAt };
  await saveOAuthDoc({ accessTokenEnc: encrypt(data.access_token), expiresAt });
  return data.access_token;
}

async function youtube(pathname, token, options = {}) {
  const url = new URL(pathname, 'https://www.googleapis.com/youtube/v3/');
  const headers = new Headers(options.headers || {});
  headers.set('authorization', `Bearer ${token}`);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const r = await nativeFetch(url, { ...options, headers, signal: options.signal || AbortSignal.timeout(12000) });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.error_description || `YouTube API ${r.status}`;
    throw new Error(msg);
  }
  return data;
}

async function readChannel(token) {
  const data = await youtube('channels?part=id,snippet&mine=true&maxResults=50', token);
  const channel = data.items?.[0];
  if (!channel) throw new Error('Bu Google akkauntda YouTube kanal topilmadi');
  return {
    id: channel.id,
    title: channel.snippet?.title || 'YouTube channel',
    thumbnail: channel.snippet?.thumbnails?.default?.url || ''
  };
}

async function listBroadcasts(token, status) {
  const data = await youtube(`liveBroadcasts?part=id,snippet,contentDetails,status&broadcastStatus=${encodeURIComponent(status)}&mine=true&maxResults=25`, token);
  return data.items || [];
}

async function getBoundStream(token, broadcast) {
  const streamId = broadcast?.contentDetails?.boundStreamId;
  if (!streamId) return null;
  const data = await youtube(`liveStreams?part=id,snippet,cdn,status,contentDetails&id=${encodeURIComponent(streamId)}&mine=true`, token);
  return data.items?.[0] || null;
}

async function syncCurrentLive(token, channel) {
  const active = await listBroadcasts(token, 'active');
  const upcoming = active.length ? [] : await listBroadcasts(token, 'upcoming');
  const broadcast = [...active, ...upcoming].find(x => x.contentDetails?.boundStreamId) || [...active, ...upcoming][0] || null;
  const stream = broadcast ? await getBoundStream(token, broadcast) : null;
  const streamName = stream?.cdn?.ingestionInfo?.streamName || '';
  const patch = {
    channelId: channel.id,
    youtubeApiKeyEnc: encrypt(OAUTH_MAGIC_KEY)
  };
  if (broadcast?.id) patch.videoId = broadcast.id;
  if (streamName) patch.streamKeyEnc = encrypt(streamName);
  await updateSettingDoc(patch);
  await saveOAuthDoc({
    channelId: channel.id,
    channelTitle: channel.title,
    channelThumbnail: channel.thumbnail,
    activeBroadcastId: broadcast?.id || '',
    activeStreamId: stream?.id || ''
  });
  return { broadcast, stream, streamName };
}

function resolutionForQuality(quality) {
  if (String(quality).startsWith('1080')) return '1080p';
  return '720p';
}

async function prepareLive(token) {
  const channel = await readChannel(token);
  const existing = await syncCurrentLive(token, channel);
  if (existing.streamName && existing.broadcast?.id) {
    return { channel, broadcast: existing.broadcast, stream: existing.stream, reused: true };
  }

  const setting = await getSettingDoc();
  const quality = setting.quality || '720x1280';
  const stream = await youtube('liveStreams?part=id,snippet,cdn,status,contentDetails', token, {
    method: 'POST',
    body: JSON.stringify({
      snippet: { title: `YT Shield Vertical • ${channel.title}` },
      cdn: {
        frameRate: '30fps',
        ingestionType: 'rtmp',
        resolution: resolutionForQuality(quality)
      },
      contentDetails: { isReusable: true }
    })
  });

  const scheduledStartTime = new Date(Date.now() + 60_000).toISOString();
  const broadcast = await youtube('liveBroadcasts?part=id,snippet,status,contentDetails', token, {
    method: 'POST',
    body: JSON.stringify({
      snippet: {
        title: `${channel.title} • LIVE`,
        description: 'Vertical LIVE via YT Shield',
        scheduledStartTime
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false
      },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        enableDvr: true,
        enableEmbed: true,
        recordFromStart: true
      }
    })
  });

  const bound = await youtube(`liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(stream.id)}&part=id,snippet,contentDetails,status`, token, {
    method: 'POST'
  });

  const fullStreamData = await youtube(`liveStreams?part=id,snippet,cdn,status,contentDetails&id=${encodeURIComponent(stream.id)}&mine=true`, token);
  const fullStream = fullStreamData.items?.[0] || stream;
  const streamName = fullStream?.cdn?.ingestionInfo?.streamName;
  if (!streamName) throw new Error('YouTube stream key qaytarmadi');

  await updateSettingDoc({
    channelId: channel.id,
    videoId: broadcast.id,
    streamKeyEnc: encrypt(streamName),
    youtubeApiKeyEnc: encrypt(OAUTH_MAGIC_KEY)
  });
  await saveOAuthDoc({
    channelId: channel.id,
    channelTitle: channel.title,
    channelThumbnail: channel.thumbnail,
    activeBroadcastId: broadcast.id,
    activeStreamId: stream.id
  });
  return { channel, broadcast: bound || broadcast, stream: fullStream, reused: false };
}

function htmlError(res, title, message, status = 500) {
  res.status(status).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;background:#070b14;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}.c{max-width:520px;padding:28px;border:1px solid #263248;border-radius:22px;background:#0d1422}a{color:#7aa2ff}</style><div class="c"><h2>${title}</h2><p>${message}</p><a href="/">← YT Shield</a></div>`);
}

function mountOAuthRoutes(app) {
  app.get('/auth/youtube', (req, res) => {
    if (!oauthConfigured()) {
      return htmlError(res, 'YouTube OAuth sozlanmagan', 'Render environment ichiga GOOGLE_CLIENT_ID va GOOGLE_CLIENT_SECRET qo‘shilishi kerak.', 503);
    }
    const state = crypto.randomBytes(24).toString('base64url');
    res.cookie('yt_oauth_state', state, {
      httpOnly: true,
      secure: APP_URL.startsWith('https://'),
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', YOUTUBE_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.get('/auth/youtube/callback', async (req, res) => {
    try {
      if (!oauthConfigured()) throw new Error('OAuth credentials yo‘q');
      if (req.query.error) throw new Error(String(req.query.error));
      const jar = cookies(req);
      if (!req.query.state || !jar.yt_oauth_state || String(req.query.state) !== jar.yt_oauth_state) throw new Error('OAuth state tekshiruvi muvaffaqiyatsiz');
      if (!req.query.code) throw new Error('Google authorization code kelmadi');

      const tokens = await tokenRequest({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code: String(req.query.code),
        grant_type: 'authorization_code',
        redirect_uri: OAUTH_REDIRECT_URI
      });
      const expiresAt = Date.now() + Math.max(300, Number(tokens.expires_in || 3600)) * 1000;
      const old = await getOAuthDoc().catch(() => null);
      const refreshToken = tokens.refresh_token || decrypt(old?.refreshTokenEnc);
      accessCache = { token: tokens.access_token, expiresAt };
      await saveOAuthDoc({
        accessTokenEnc: encrypt(tokens.access_token),
        refreshTokenEnc: encrypt(refreshToken),
        expiresAt,
        scope: tokens.scope || YOUTUBE_SCOPE
      });

      const channel = await readChannel(tokens.access_token);
      await syncCurrentLive(tokens.access_token, channel);

      res.clearCookie('yt_oauth_state');
      res.cookie('ytshield', adminToken(), {
        httpOnly: true,
        secure: APP_URL.startsWith('https://'),
        sameSite: 'strict',
        maxAge: 12 * 60 * 60 * 1000
      });
      res.redirect('/?youtube=connected');
    } catch (err) {
      htmlError(res, 'YouTube ulanmadi', String(err.message || err), 400);
    }
  });

  app.get('/auth/youtube/prepare', async (req, res) => {
    if (!isAdmin(req)) return res.redirect('/');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Avval YouTube bilan kiring');
      await prepareLive(token);
      res.redirect('/?youtube=prepared');
    } catch (err) {
      htmlError(res, 'LIVE tayyorlanmadi', String(err.message || err), 400);
    }
  });

  app.get('/api/youtube/oauth-status', async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const doc = await getOAuthDoc();
      res.json({
        connected: Boolean(decrypt(doc?.refreshTokenEnc) || decrypt(doc?.accessTokenEnc)),
        channelId: doc?.channelId || '',
        channelTitle: doc?.channelTitle || '',
        channelThumbnail: doc?.channelThumbnail || '',
        activeBroadcastId: doc?.activeBroadcastId || '',
        activeStreamId: doc?.activeStreamId || '',
        oauthConfigured: oauthConfigured(),
        redirectUri: OAUTH_REDIRECT_URI
      });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
}

// Mount OAuth routes before server.js registers its wildcard/static handlers.
const originalSet = express.application.set;
express.application.set = function patchedSet(...args) {
  if (!this.__ytOauthMounted) {
    this.__ytOauthMounted = true;
    mountOAuthRoutes(this);
  }
  return originalSet.apply(this, args);
};

// server.js already understands API-key monitoring. The marker below transparently
// converts those YouTube requests to OAuth Bearer requests, so no Data API key is needed.
globalThis.fetch = async function oauthAwareFetch(input, init = {}) {
  try {
    const raw = input instanceof URL ? input.toString() : typeof input === 'string' ? input : input?.url;
    if (raw) {
      const url = new URL(raw);
      if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/youtube/v3/') && url.searchParams.get('key') === OAUTH_MAGIC_KEY) {
        const token = await getAccessToken();
        if (token) {
          url.searchParams.delete('key');
          const headers = new Headers(init.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
          headers.set('authorization', `Bearer ${token}`);
          return nativeFetch(url, { ...init, headers });
        }
      }
    }
  } catch (err) {
    console.warn('[oauth fetch]', err.message || err);
  }
  return nativeFetch(input, init);
};

console.log(`[YT OAuth] bootstrap loaded • redirect ${OAUTH_REDIRECT_URI}`);
