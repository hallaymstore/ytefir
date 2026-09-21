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
  return jwt.sign({ sub: ADMIN_USER, role: 'admin', via: 'youtube-oauth' }, JWT_SECRET, { expiresIn: '7d' });
}
function isAdmin(req) {
  const token = cookies(req).ytshield;
  if (!token) return false;
  try { jwt.verify(token, JWT_SECRET); return true; } catch { return false; }
}
function guard(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'YouTube bilan qayta kiring' });
  next();
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
async function clearOAuthDoc() {
  await db().collection('youtubeoauth').deleteOne({ _id: 'main' });
  accessCache = { token: '', expiresAt: 0 };
}
async function getSettingDoc() {
  return (await db().collection('settings').findOne({ singleton: 'main' })) || {};
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
    signal: AbortSignal.timeout(15000)
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
  const r = await nativeFetch(url, { ...options, headers, signal: options.signal || AbortSignal.timeout(15000) });
  const raw = await r.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!r.ok) {
    const msg = data?.error?.message || data?.error_description || `YouTube API ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.payload = data;
    throw err;
  }
  return data;
}

async function readChannel(token) {
  const data = await youtube('channels?part=id,snippet,statistics,status&mine=true&maxResults=50', token);
  const channel = data.items?.[0];
  if (!channel) throw new Error('Bu Google akkauntda YouTube kanal topilmadi');
  return {
    id: channel.id,
    title: channel.snippet?.title || 'YouTube channel',
    customUrl: channel.snippet?.customUrl || '',
    thumbnail: channel.snippet?.thumbnails?.medium?.url || channel.snippet?.thumbnails?.default?.url || '',
    subscribers: Number(channel.statistics?.subscriberCount || 0),
    videos: Number(channel.statistics?.videoCount || 0)
  };
}

async function listBroadcasts(token, status = 'active') {
  // YouTube treats mine / broadcastStatus / id as mutually-exclusive primary filters.
  // Fetch this authenticated channel's broadcasts with mine=true, then filter locally.
  const data = await youtube('liveBroadcasts?part=id,snippet,contentDetails,status&mine=true&broadcastType=all&maxResults=50', token);
  const items = data.items || [];
  const activeStates = new Set(['live', 'liveStarting', 'testing', 'testStarting']);
  const upcomingStates = new Set(['created', 'ready']);
  if (status === 'active') return items.filter(x => activeStates.has(x.status?.lifeCycleStatus));
  if (status === 'upcoming') return items.filter(x => upcomingStates.has(x.status?.lifeCycleStatus));
  if (status === 'completed') return items.filter(x => x.status?.lifeCycleStatus === 'complete');
  return items;
}
async function getBroadcast(token, id) {
  if (!id) return null;
  // id is the sole primary filter for this request.
  const data = await youtube(`liveBroadcasts?part=id,snippet,contentDetails,status&id=${encodeURIComponent(id)}`, token);
  return data.items?.[0] || null;
}
async function getStream(token, id) {
  if (!id) return null;
  // id is the sole primary filter for this request.
  const data = await youtube(`liveStreams?part=id,snippet,cdn,status,contentDetails&id=${encodeURIComponent(id)}`, token);
  return data.items?.[0] || null;
}
async function getBoundStream(token, broadcast) {
  return broadcast?.contentDetails?.boundStreamId ? getStream(token, broadcast.contentDetails.boundStreamId) : null;
}
function resolutionForQuality(quality) {
  if (String(quality).startsWith('1080')) return '1080p';
  return '720p';
}
function clampText(v, max) {
  return String(v || '').trim().slice(0, max);
}

function isInstantBroadcast(broadcast) {
  const raw = broadcast?.snippet?.scheduledStartTime;
  if (!raw) return true;
  const ms = Date.parse(raw);
  // Creator Studio's unscheduled / Stream-now broadcast is represented by Unix epoch zero.
  return Number.isFinite(ms) && ms <= 1000;
}
function isRunnableBroadcast(broadcast) {
  return ['created','ready','testing','testStarting','live','liveStarting'].includes(broadcast?.status?.lifeCycleStatus);
}
function isActiveBroadcast(broadcast) {
  return ['testing','testStarting','live','liveStarting'].includes(broadcast?.status?.lifeCycleStatus);
}
function studioLiveUrl(channelId) {
  return channelId
    ? `https://studio.youtube.com/channel/${encodeURIComponent(channelId)}/livestreaming/stream`
    : 'https://studio.youtube.com/';
}
async function updateVideoMetadata(token, videoId, opts = {}) {
  const title = clampText(opts.title, 100);
  const description = clampText(opts.description, 5000);
  if (!title && !description) return;
  const current = await youtube(`videos?part=snippet&id=${encodeURIComponent(videoId)}`, token);
  const item = current.items?.[0];
  if (!item?.snippet) return;
  const old = item.snippet;
  const snippet = {
    title: title || old.title || 'LIVE',
    description: description || old.description || '',
    categoryId: old.categoryId || '22'
  };
  if (Array.isArray(old.tags)) snippet.tags = old.tags;
  if (old.defaultLanguage) snippet.defaultLanguage = old.defaultLanguage;
  if (old.defaultAudioLanguage) snippet.defaultAudioLanguage = old.defaultAudioLanguage;
  await youtube('videos?part=snippet', token, {
    method: 'PUT',
    body: JSON.stringify({ id: videoId, snippet })
  });
}

async function syncCurrentLive(token, channel) {
  const all = await listBroadcasts(token, 'all');
  const instant = all.filter(isRunnableBroadcast).filter(isInstantBroadcast);
  const broadcast = instant.find(isActiveBroadcast) || instant.find(x => x.status?.lifeCycleStatus === 'ready') || instant[0] || null;
  const stream = broadcast ? await getBoundStream(token, broadcast) : null;
  const streamName = stream?.cdn?.ingestionInfo?.streamName || '';

  const patch = {
    channelId: channel.id,
    youtubeApiKeyEnc: encrypt(OAUTH_MAGIC_KEY),
    quality: '720x1280'
  };
  // Never keep a stale scheduled broadcast in Shorts-only mode.
  patch.videoId = broadcast?.id || '';
  patch.streamKeyEnc = streamName ? encrypt(streamName) : '';
  await updateSettingDoc(patch);

  await saveOAuthDoc({
    channelId: channel.id,
    channelTitle: channel.title,
    channelThumbnail: channel.thumbnail,
    activeBroadcastId: broadcast?.id || '',
    activeStreamId: stream?.id || '',
    liveChatId: broadcast?.snippet?.liveChatId || '',
    shortsReady: Boolean(broadcast),
    shortsUpdatedAt: new Date()
  });

  return {
    broadcast,
    stream,
    streamName,
    shortsReady: Boolean(broadcast),
    studioUrl: studioLiveUrl(channel.id)
  };
}

async function createLive(token, opts = {}) {
  const channel = await readChannel(token);
  const all = await listBroadcasts(token, 'all');
  const instant = all.filter(isRunnableBroadcast).filter(isInstantBroadcast);
  let broadcast = instant.find(isActiveBroadcast) || instant.find(x => x.status?.lifeCycleStatus === 'ready') || instant[0] || null;

  if (!broadcast) {
    const err = new Error('SHORTS LIVE uchun unscheduled / instant broadcast topilmadi. YouTube Studio’da Stream now rejimini bir marta tayyorlang.');
    err.code = 'SHORTS_SETUP_REQUIRED';
    err.status = 409;
    err.studioUrl = studioLiveUrl(channel.id);
    throw err;
  }

  await updateVideoMetadata(token, broadcast.id, opts).catch(err => {
    console.warn('[metadata update]', err.message || err);
  });

  if (opts.privacyStatus && ['public','unlisted','private'].includes(opts.privacyStatus) && broadcast.status?.privacyStatus !== opts.privacyStatus) {
    try {
      broadcast = await youtube('liveBroadcasts?part=status', token, {
        method: 'PUT',
        body: JSON.stringify({
          id: broadcast.id,
          status: {
            privacyStatus: opts.privacyStatus,
            selfDeclaredMadeForKids: Boolean(broadcast.status?.selfDeclaredMadeForKids)
          }
        })
      });
    } catch (err) {
      console.warn('[privacy update]', err.message || err);
    }
  }

  let stream = await getBoundStream(token, broadcast);
  if (!stream) {
    stream = await youtube('liveStreams?part=id,snippet,cdn,status,contentDetails', token, {
      method: 'POST',
      body: JSON.stringify({
        snippet: { title: `YT Shield Shorts 9:16 • ${Date.now()}` },
        cdn: { frameRate: '30fps', ingestionType: 'rtmp', resolution: '720p' },
        contentDetails: { isReusable: false }
      })
    });
    await youtube(`liveBroadcasts/bind?id=${encodeURIComponent(broadcast.id)}&streamId=${encodeURIComponent(stream.id)}&part=id,snippet,contentDetails,status`, token, { method: 'POST' });
    broadcast = await getBroadcast(token, broadcast.id) || broadcast;
    stream = await getStream(token, stream.id) || stream;
  }

  const streamName = stream?.cdn?.ingestionInfo?.streamName;
  if (!streamName) throw new Error('YouTube instant stream key qaytarmadi');

  await updateSettingDoc({
    channelId: channel.id,
    videoId: broadcast.id,
    streamKeyEnc: encrypt(streamName),
    youtubeApiKeyEnc: encrypt(OAUTH_MAGIC_KEY),
    quality: '720x1280'
  });
  await saveOAuthDoc({
    channelId: channel.id,
    channelTitle: channel.title,
    channelThumbnail: channel.thumbnail,
    activeBroadcastId: broadcast.id,
    activeStreamId: stream.id,
    liveChatId: broadcast.snippet?.liveChatId || '',
    shortsReady: true,
    shortsUpdatedAt: new Date()
  });

  return { channel, broadcast, stream, reused: true, shorts: true, studioUrl: studioLiveUrl(channel.id) };
}

async function currentContext(token) {
  const channel = await readChannel(token);
  const synced = await syncCurrentLive(token, channel);
  const broadcast = synced.broadcast;
  const stream = broadcast ? (synced.stream || await getBoundStream(token, broadcast)) : null;
  return {
    broadcast,
    stream,
    chatId: broadcast?.snippet?.liveChatId || '',
    channel,
    shortsReady: Boolean(broadcast),
    studioUrl: synced.studioUrl
  };
}

async function completeCurrent(token) {
  const { broadcast } = await currentContext(token);
  if (!broadcast) return { ok: true, alreadyStopped: true };
  const life = broadcast.status?.lifeCycleStatus;
  if (life === 'complete') return { ok: true, alreadyStopped: true, broadcast };
  try {
    const out = await youtube(`liveBroadcasts/transition?broadcastStatus=complete&id=${encodeURIComponent(broadcast.id)}&part=id,status,snippet`, token, { method: 'POST' });
    await saveOAuthDoc({ activeBroadcastId: '', activeStreamId: '', liveChatId: '' });
    return { ok: true, broadcast: out };
  } catch (err) {
    if (/redundantTransition|already/i.test(err.message)) return { ok: true, alreadyStopped: true };
    throw err;
  }
}

async function updatePrivacy(token, privacyStatus) {
  if (!['public', 'unlisted', 'private'].includes(privacyStatus)) throw new Error('Privacy noto‘g‘ri');
  const { broadcast } = await currentContext(token);
  if (!broadcast) throw new Error('Aktiv LIVE topilmadi');
  return youtube('liveBroadcasts?part=status', token, {
    method: 'PUT',
    body: JSON.stringify({
      id: broadcast.id,
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: Boolean(broadcast.status?.selfDeclaredMadeForKids)
      }
    })
  });
}


async function transitionCurrentLive(token) {
  let { broadcast, stream, studioUrl: setupUrl } = await currentContext(token);
  if (!broadcast || !stream) {
    const err = new Error('SHORTS LIVE tayyor emas');
    err.code = 'SHORTS_SETUP_REQUIRED';
    err.status = 409;
    err.studioUrl = setupUrl;
    throw err;
  }
  if (['live','liveStarting'].includes(broadcast.status?.lifeCycleStatus)) return { ok: true, broadcast, alreadyLive: true };

  // Wait until YouTube is actually receiving RTMP packets.
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    stream = await getStream(token, stream.id) || stream;
    if (stream.status?.streamStatus === 'active') break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  if (stream.status?.streamStatus !== 'active') {
    const err = new Error('YouTube hali video oqimini qabul qilgani yo‘q. Internet/encoder holatini tekshiring.');
    err.status = 409;
    throw err;
  }

  broadcast = await getBroadcast(token, broadcast.id) || broadcast;
  if (['live','liveStarting'].includes(broadcast.status?.lifeCycleStatus)) return { ok: true, broadcast, alreadyLive: true };

  const out = await youtube(`liveBroadcasts/transition?broadcastStatus=live&id=${encodeURIComponent(broadcast.id)}&part=id,snippet,status,contentDetails`, token, {
    method: 'POST'
  });
  await saveOAuthDoc({ activeBroadcastId: broadcast.id, activeStreamId: stream.id, liveChatId: out?.snippet?.liveChatId || '' });
  return { ok: true, broadcast: out, stream };
}

async function liveStatus(token) {
  const channel = await readChannel(token);
  const { broadcast, stream, chatId, shortsReady, studioUrl: setupUrl } = await currentContext(token);
  return {
    channel,
    connected: true,
    shortsMode: true,
    shortsReady,
    studioUrl: setupUrl,
    broadcast: broadcast ? {
      id: broadcast.id,
      title: broadcast.snippet?.title || '',
      lifeCycleStatus: broadcast.status?.lifeCycleStatus || '',
      privacyStatus: broadcast.status?.privacyStatus || '',
      actualStartTime: broadcast.snippet?.actualStartTime || '',
      scheduledStartTime: broadcast.snippet?.scheduledStartTime || '',
      instant: isInstantBroadcast(broadcast),
      liveChatId: chatId
    } : null,
    stream: stream ? {
      id: stream.id,
      streamStatus: stream.status?.streamStatus || '',
      healthStatus: stream.status?.healthStatus?.status || ''
    } : null
  };
}

async function getChatMessages(token, pageToken = '') {
  const { chatId } = await currentContext(token);
  if (!chatId) return { items: [], nextPageToken: '', pollingIntervalMillis: 5000 };
  const q = new URLSearchParams({
    part: 'id,snippet,authorDetails',
    liveChatId: chatId,
    maxResults: '100',
    profileImageSize: '48'
  });
  if (pageToken) q.set('pageToken', pageToken);
  const data = await youtube(`liveChat/messages?${q.toString()}`, token);
  return {
    items: (data.items || []).map(x => ({
      id: x.id,
      type: x.snippet?.type || '',
      text: x.snippet?.displayMessage || '',
      publishedAt: x.snippet?.publishedAt || '',
      author: {
        channelId: x.authorDetails?.channelId || '',
        name: x.authorDetails?.displayName || '',
        avatar: x.authorDetails?.profileImageUrl || '',
        owner: Boolean(x.authorDetails?.isChatOwner),
        moderator: Boolean(x.authorDetails?.isChatModerator),
        member: Boolean(x.authorDetails?.isChatSponsor)
      }
    })),
    nextPageToken: data.nextPageToken || '',
    pollingIntervalMillis: Number(data.pollingIntervalMillis || 5000)
  };
}

async function sendChatMessage(token, text) {
  const { chatId } = await currentContext(token);
  if (!chatId) throw new Error('Live chat topilmadi');
  const messageText = clampText(text, 200);
  if (!messageText) throw new Error('Xabar bo‘sh');
  return youtube('liveChat/messages?part=snippet', token, {
    method: 'POST',
    body: JSON.stringify({
      snippet: {
        liveChatId: chatId,
        type: 'textMessageEvent',
        textMessageDetails: { messageText }
      }
    })
  });
}

async function deleteChatMessage(token, id) {
  if (!id) throw new Error('Message ID yo‘q');
  await youtube(`liveChat/messages?id=${encodeURIComponent(id)}`, token, { method: 'DELETE' });
  return { ok: true };
}

async function banChatUser(token, channelId, seconds = 300) {
  const { chatId } = await currentContext(token);
  if (!chatId) throw new Error('Live chat topilmadi');
  if (!channelId) throw new Error('User channel ID yo‘q');
  const duration = Math.max(30, Math.min(86400, Number(seconds || 300)));
  return youtube('liveChat/bans?part=snippet', token, {
    method: 'POST',
    body: JSON.stringify({
      snippet: {
        liveChatId: chatId,
        type: 'temporary',
        banDurationSeconds: duration,
        bannedUserDetails: { channelId }
      }
    })
  });
}

function htmlError(res, title, message, status = 500) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  res.status(status).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;background:#070b14;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}.c{max-width:560px;padding:28px;border:1px solid #263248;border-radius:22px;background:#0d1422}a{color:#7aa2ff}</style><div class="c"><h2>${esc(title)}</h2><p>${esc(message)}</p><a href="/">← YT Shield</a></div>`);
}

function mountRoutes(app) {
  // Routes are mounted before server.js middleware, so parse our JSON bodies here.
  app.use(express.json({ limit: '1mb' }));

  app.get('/auth/youtube', (req, res) => {
    if (!oauthConfigured()) return htmlError(res, 'YouTube OAuth sozlanmagan', 'Google OAuth credentials serverga ulanmagan.', 503);
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
    url.searchParams.set('prompt', 'consent select_account');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.get('/auth/youtube/callback', async (req, res) => {
    try {
      if (!oauthConfigured()) throw new Error('OAuth credentials yo‘q');
      if (req.query.error) throw new Error(String(req.query.error));
      const jar = cookies(req);
      if (!req.query.state || !jar.yt_oauth_state || String(req.query.state) !== jar.yt_oauth_state) throw new Error('OAuth state xato');
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
        maxAge: 7 * 24 * 60 * 60 * 1000
      });
      res.redirect('/?youtube=connected');
    } catch (err) {
      htmlError(res, 'YouTube ulanmadi', String(err.message || err), 400);
    }
  });

  app.post('/api/youtube/disconnect', guard, async (req, res) => {
    await clearOAuthDoc();
    res.clearCookie('ytshield', { httpOnly: true, secure: APP_URL.startsWith('https://'), sameSite: 'strict' });
    res.json({ ok: true });
  });

  app.get('/api/youtube/oauth-status', guard, async (req, res) => {
    try {
      const doc = await getOAuthDoc();
      const token = await getAccessToken();
      let channel = null;
      if (token) channel = await readChannel(token).catch(() => null);
      res.json({
        connected: Boolean(token),
        oauthConfigured: oauthConfigured(),
        redirectUri: OAUTH_REDIRECT_URI,
        channel: channel || (doc?.channelId ? {
          id: doc.channelId,
          title: doc.channelTitle || '',
          thumbnail: doc.channelThumbnail || ''
        } : null),
        activeBroadcastId: doc?.activeBroadcastId || '',
        activeStreamId: doc?.activeStreamId || ''
      });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/youtube/live/ensure', guard, async (req, res) => {
    try {
      const token = await getAccessToken();
      if (!token) return res.status(401).json({ error: 'Avval YouTube bilan kiring' });
      const result = await createLive(token, req.body || {});
      res.json({
        ok: true,
        reused: result.reused,
        channel: result.channel,
        broadcast: {
          id: result.broadcast?.id || '',
          title: result.broadcast?.snippet?.title || '',
          status: result.broadcast?.status?.lifeCycleStatus || '',
          privacyStatus: result.broadcast?.status?.privacyStatus || '',
          liveChatId: result.broadcast?.snippet?.liveChatId || ''
        }
      });
    } catch (err) {
      res.status(err.status || 500).json({
        error: String(err.message || err),
        code: err.code || '',
        studioUrl: err.studioUrl || ''
      });
    }
  });

  app.post('/api/youtube/live/transition', guard, async (req, res) => {
    try {
      const token = await getAccessToken();
      if (!token) return res.status(401).json({ error: 'YouTube ulanmagan' });
      res.json(await transitionCurrentLive(token));
    } catch (err) {
      res.status(err.status || 500).json({
        error: String(err.message || err),
        code: err.code || '',
        studioUrl: err.studioUrl || ''
      });
    }
  });

  app.get('/api/youtube/live/status', guard, async (req, res) => {
    try {
      const token = await getAccessToken();
      if (!token) return res.status(401).json({ error: 'YouTube ulanmagan' });
      res.json(await liveStatus(token));
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/youtube/live/complete', guard, async (req, res) => {
    try {
      const token = await getAccessToken();
      if (!token) return res.status(401).json({ error: 'YouTube ulanmagan' });
      res.json(await completeCurrent(token));
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/youtube/live/privacy', guard, async (req, res) => {
    try {
      const token = await getAccessToken();
      if (!token) return res.status(401).json({ error: 'YouTube ulanmagan' });
      const out = await updatePrivacy(token, String(req.body?.privacyStatus || ''));
      res.json({ ok: true, broadcast: out });
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });

  app.get('/api/youtube/chat/messages', guard, async (req, res) => {
    try {
      const token = await getAccessToken();
      if (!token) return res.status(401).json({ error: 'YouTube ulanmagan' });
      res.json(await getChatMessages(token, String(req.query.pageToken || '')));
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/youtube/chat/send', guard, async (req, res) => {
    try {
      const token = await getAccessToken();
      if (!token) return res.status(401).json({ error: 'YouTube ulanmagan' });
      const out = await sendChatMessage(token, req.body?.text);
      res.json({ ok: true, message: out });
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });

  app.delete('/api/youtube/chat/messages/:id', guard, async (req, res) => {
    try {
      const token = await getAccessToken();
      if (!token) return res.status(401).json({ error: 'YouTube ulanmagan' });
      res.json(await deleteChatMessage(token, req.params.id));
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });

  app.post('/api/youtube/chat/ban', guard, async (req, res) => {
    try {
      const token = await getAccessToken();
      if (!token) return res.status(401).json({ error: 'YouTube ulanmagan' });
      const out = await banChatUser(token, req.body?.channelId, req.body?.seconds);
      res.json({ ok: true, ban: out });
    } catch (err) {
      res.status(err.status || 500).json({ error: String(err.message || err) });
    }
  });
}

const previousSet = express.application.set;
express.application.set = function patchedSet(...args) {
  if (!this.__ytControlMounted) {
    this.__ytControlMounted = true;
    mountRoutes(this);
  }
  return previousSet.apply(this, args);
};

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
    console.warn('[youtube oauth fetch]', err.message || err);
  }
  return nativeFetch(input, init);
};

console.log(`[YT Control] OAuth + LIVE control loaded • redirect ${OAUTH_REDIRECT_URI}`);
