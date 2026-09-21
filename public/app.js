const $ = s => document.querySelector(s);

const authView = $('#authView');
const appView = $('#appView');
const cameraVideo = $('#cameraVideo');
const canvas = $('#portraitCanvas');
const ctx = canvas.getContext('2d', { alpha:false, desynchronized:true });

let config = null;
let sourceStream = null;
let portraitStream = null;
let recorder = null;
let socket = null;
let drawing = false;
let streaming = false;
let ingestReadyResolver = null;
let reconnectTimer = null;
let currentBroadcast = null;
let currentFacing = 'user';
let micEnabled = true;
let chatTimer = null;
let chatPageToken = '';
let chatSeen = new Set();
let chatPollMs = 5000;
let latestSupportUrl = 'https://support.google.com/youtube/gethelp';
let vapidPublicKey = '';

function toast(text) {
  const el = $('#toast');
  el.textContent = String(text || '');
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const opts = { credentials:'same-origin', ...options, headers };
  if (opts.body && typeof opts.body !== 'string') {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, opts);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error || data || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data && typeof data === 'object' ? data : {};
    throw err;
  }
  return data;
}

function showAuth() {
  authView.classList.remove('hidden');
  appView.classList.add('hidden');
}
function showApp() {
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
}

async function bootstrap() {
  try {
    await api('/api/auth/me');
    showApp();
    await Promise.all([loadConfig(), loadChannel(), loadIncidents()]);
    connectSocket();
    registerPwa();
    await startCamera(true);
    await pollYoutubeStatus();
    setInterval(pollYoutubeStatus, 6000);
  } catch {
    showAuth();
  }
}
bootstrap();

async function loadConfig() {
  config = await api('/api/config');
  vapidPublicKey = config.vapidPublicKey || '';
  $('#autoProtect').checked = Boolean(config.autoProtect);
}

async function saveAutoProtect() {
  await api('/api/config', {
    method:'PUT',
    body:{ quality:'720x1280', autoProtect:Boolean($('#autoProtect').checked) }
  });
}
$('#autoProtect').addEventListener('change', () => saveAutoProtect().catch(err => toast(err.message)));

async function loadChannel() {
  const st = await api('/api/youtube/oauth-status');
  if (!st.connected) return showAuth();
  const ch = st.channel || {};
  $('#channelTitle').textContent = ch.title || 'YouTube';
  $('#channelAvatar').src = ch.thumbnail || '/icon.svg';
}

function openMenu() {
  $('#sideMenu').classList.add('open');
  $('#menuBackdrop').classList.add('open');
  $('#sideMenu').setAttribute('aria-hidden','false');
}
function closeMenu() {
  $('#sideMenu').classList.remove('open');
  $('#menuBackdrop').classList.remove('open');
  $('#sideMenu').setAttribute('aria-hidden','true');
}
$('#menuBtn').addEventListener('click', openMenu);
$('#closeMenu').addEventListener('click', closeMenu);
$('#menuBackdrop').addEventListener('click', closeMenu);

async function startCamera(silent=false) {
  try {
    sourceStream?.getTracks().forEach(t => t.stop());
    sourceStream = await navigator.mediaDevices.getUserMedia({
      video:{
        facingMode:{ ideal:currentFacing },
        width:{ideal:1920},
        height:{ideal:1080},
        frameRate:{ideal:30,max:30}
      },
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
    sourceStream.getAudioTracks().forEach(t => t.enabled = micEnabled);
    cameraVideo.srcObject = sourceStream;
    await cameraVideo.play();
    $('#cameraEmpty').classList.add('hidden');
    drawing = true;
    drawPortrait();
    if (!silent) toast(currentFacing === 'user' ? 'Old kamera' : 'Orqa kamera');
    return true;
  } catch (err) {
    $('#cameraEmpty').classList.remove('hidden');
    toast(`Kamera: ${err.message}`);
    return false;
  }
}

function drawPortrait() {
  if (!drawing || !sourceStream) return;
  const vw = cameraVideo.videoWidth || 1280;
  const vh = cameraVideo.videoHeight || 720;
  const dw = 720, dh = 1280;
  if (canvas.width !== dw) canvas.width = dw;
  if (canvas.height !== dh) canvas.height = dh;
  const srcAspect = vw / vh, dstAspect = dw / dh;
  let sx=0, sy=0, sw=vw, sh=vh;
  if (srcAspect > dstAspect) {
    sw = vh * dstAspect;
    sx = (vw - sw) / 2;
  } else {
    sh = vw / dstAspect;
    sy = (vh - sh) / 2;
  }
  ctx.drawImage(cameraVideo,sx,sy,sw,sh,0,0,dw,dh);
  requestAnimationFrame(drawPortrait);
}

$('#switchCameraBtn').addEventListener('click', async () => {
  if (streaming) return toast('LIVE vaqtida kamerani almashtirish keyingi versiyada');
  currentFacing = currentFacing === 'user' ? 'environment' : 'user';
  await startCamera();
});

$('#micBtn').addEventListener('click', () => {
  micEnabled = !micEnabled;
  sourceStream?.getAudioTracks().forEach(t => t.enabled = micEnabled);
  $('#micBtn').textContent = micEnabled ? 'Mic ON' : 'Mic OFF';
  toast(micEnabled ? 'Mikrofon yoqildi' : 'Mikrofon o‘chirildi');
});

function connectSocket() {
  if (socket && [WebSocket.OPEN,WebSocket.CONNECTING].includes(socket.readyState)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/ws`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', e => {
    if (typeof e.data !== 'string') return;
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'hello') {
      renderIngestState(Boolean(msg.liveState?.ingestActive));
      if (msg.liveState?.monitor) renderMonitor(msg.liveState.monitor);
    }
    if (msg.type === 'monitor') renderMonitor(msg.monitor);
    if (msg.type === 'incident') {
      loadIncidents();
      toast(`Risk ${msg.incident?.risk || 0}% — shubhali trafik`);
    }
    if (msg.type === 'ingest-ready') {
      ingestReadyResolver?.({ok:true});
      ingestReadyResolver = null;
    }
    if (msg.type === 'ingest-error') {
      ingestReadyResolver?.({ok:false,error:msg.error});
      ingestReadyResolver = null;
      toast(msg.error || 'Encoder xatosi');
    }
    if (msg.type === 'ingest-stopped') {
      if (streaming) stopLocalOnly();
    }
    if (msg.type === 'live-state') renderIngestState(Boolean(msg.liveState?.ingestActive));
    if (msg.type === 'auto-protect') toast('Auto Protect: LIVE Unlisted qilindi');
  });
  socket.addEventListener('close', () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket,1800);
  });
}

function waitForIngestReady(timeout=15000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      ingestReadyResolver = null;
      resolve({ok:false,error:'Encoder javobi kechikdi'});
    }, timeout);
    ingestReadyResolver = value => { clearTimeout(timer); resolve(value); };
  });
}

function portraitCapture() {
  const stream = canvas.captureStream(30);
  for (const track of sourceStream?.getAudioTracks() || []) stream.addTrack(track);
  return stream;
}

async function startLive() {
  if (streaming) return;
  const btn = $('#startLiveBtn');
  btn.disabled = true;
  btn.textContent = 'Tayyorlanmoqda...';
  try {
    if (!sourceStream && !(await startCamera())) throw new Error('Kamera ochilmadi');

    const live = await api('/api/youtube/live/ensure', {
      method:'POST',
      body:{
        title:$('#liveTitle').value.trim(),
        description:$('#liveDescription').value.trim(),
        privacyStatus:'public',
        quality:'720x1280'
      }
    });
    currentBroadcast = live.broadcast || null;

    connectSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) await new Promise(r => setTimeout(r,900));
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('LIVE server ulanmagan');

    socket.send(JSON.stringify({type:'start-ingest',quality:'720x1280',fps:30}));
    const ready = await waitForIngestReady();
    if (!ready.ok) throw new Error(ready.error || 'RTMP boshlanmadi');

    portraitStream = portraitCapture();
    const types = ['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm'];
    const mimeType = types.find(x => MediaRecorder.isTypeSupported(x)) || '';
    recorder = new MediaRecorder(
      portraitStream,
      mimeType ? {mimeType,videoBitsPerSecond:3200000,audioBitsPerSecond:128000} : undefined
    );
    recorder.addEventListener('dataavailable', async e => {
      if (!e.data?.size || socket?.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 7*1024*1024) return;
      socket.send(await e.data.arrayBuffer());
    });
    recorder.start(700);
    streaming = true;
    renderIngestState(true);
    closeMenu();
    toast('9:16 oqim YouTube’ga ketmoqda');

    api('/api/youtube/live/transition',{method:'POST'})
      .then(() => {
        toast('LIVE boshlandi');
        startChatPolling();
        pollYoutubeStatus();
      })
      .catch(err => toast(err.message || 'LIVE transition xatosi'));
  } catch (err) {
    try { socket?.send(JSON.stringify({type:'stop-ingest'})); } catch {}
    stopLocalOnly();
    if (err.status === 409 && err.data?.code === 'SHORTS_SETUP_REQUIRED') {
      $('#shortsBadge').textContent = 'SHORTS SETUP YO‘Q';
      $('#shortsBadge').style.color = '#ffbd66';
      toast('YouTube API kanal uchun instant Shorts broadcast bermadi');
    } else {
      toast(err.message || 'LIVE boshlanmadi');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '● LIVE boshlash';
  }
}
$('#startLiveBtn').addEventListener('click', startLive);

async function stopLive() {
  $('#stopLiveBtn').disabled = true;
  try {
    await api('/api/youtube/live/complete',{method:'POST'}).catch(()=>null);
  } finally {
    try { socket?.send(JSON.stringify({type:'stop-ingest'})); } catch {}
    stopLocalOnly();
    stopChatPolling();
    currentBroadcast = null;
    toast('LIVE tugatildi');
    pollYoutubeStatus();
  }
}
$('#stopLiveBtn').addEventListener('click', stopLive);

function stopLocalOnly() {
  try { if (recorder?.state !== 'inactive') recorder?.stop(); } catch {}
  recorder = null;
  portraitStream?.getTracks().forEach(t => t.stop());
  portraitStream = null;
  streaming = false;
  renderIngestState(false);
}

function renderIngestState(active) {
  streaming = Boolean(active || streaming && recorder?.state === 'recording');
  $('#livePill').textContent = active ? '● LIVE' : 'OFF AIR';
  $('#livePill').classList.toggle('live',active);
  $('#startLiveBtn').disabled = active;
  $('#stopLiveBtn').disabled = !active;
}

async function pollYoutubeStatus() {
  try {
    const s = await api('/api/youtube/live/status');
    currentBroadcast = s.broadcast || null;
    const ready = Boolean(s.shortsReady && s.broadcast?.instant);
    $('#shortsBadge').textContent = ready ? 'SHORTS READY' : 'SHORTS CHECK';
    $('#shortsBadge').style.color = ready ? '#4be09a' : 'rgba(255,255,255,.7)';
    $('#liveModeText').textContent = ready ? 'SHORTS • 9:16 • READY' : 'SHORTS • 9:16';
    if (s.broadcast?.title && !$('#liveTitle').value) $('#liveTitle').value = s.broadcast.title;
    if (s.broadcast?.lifeCycleStatus === 'live') {
      $('#livePill').textContent = '● LIVE';
      $('#livePill').classList.add('live');
      startChatPolling();
    }
    if (s.broadcast?.privacyStatus === 'unlisted') $('#emergencyBtn').textContent = 'Public qaytarish';
    else $('#emergencyBtn').textContent = 'Emergency Unlisted';
  } catch {}
}

function renderMonitor(m={}) {
  const concurrent = Number(m.concurrent || 0);
  const views = Number(m.views || 0);
  const likes = Number(m.likes || 0);
  const risk = Number(m.risk || 0);
  $('#statConcurrent').textContent = fmt(concurrent);
  $('#statViews').textContent = fmt(views);
  $('#statLikes').textContent = fmt(likes);
  $('#statRisk').textContent = `${risk}%`;
  $('#riskReason').textContent = (m.reasons || []).slice(0,1).join('') || 'normal';
  $('#monitorStatus').textContent = m.connected ? 'LIVE' : 'OFF';
  $('#streamHealth').textContent = risk >= 90 ? 'RISK' : m.connected ? 'OK' : 'READY';
  $('#streamHealth').style.color = risk >= 90 ? '#ff6b83' : '';
}

function fmt(n) {
  n = Number(n || 0);
  return new Intl.NumberFormat('en-US',{notation:n>=100000?'compact':'standard',maximumFractionDigits:1}).format(n);
}

function startChatPolling() {
  if (chatTimer) return;
  $('#chatState').textContent = 'LIVE';
  chatPageToken = '';
  chatSeen.clear();
  pollChat();
}
function stopChatPolling() {
  clearTimeout(chatTimer);
  chatTimer = null;
  $('#chatState').textContent = 'WAITING';
}
async function pollChat() {
  clearTimeout(chatTimer);
  try {
    const q = chatPageToken ? `?pageToken=${encodeURIComponent(chatPageToken)}` : '';
    const data = await api(`/api/youtube/chat/messages${q}`);
    chatPageToken = data.nextPageToken || chatPageToken;
    chatPollMs = Math.max(2000,Number(data.pollingIntervalMillis || 5000));
    appendChat(data.items || []);
  } catch {}
  chatTimer = setTimeout(pollChat,chatPollMs);
}

function appendChat(items) {
  const list = $('#chatList');
  for (const m of items) {
    if (chatSeen.has(m.id)) continue;
    chatSeen.add(m.id);
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.dataset.id = m.id;
    row.dataset.channel = m.author?.channelId || '';

    const img = document.createElement('img');
    img.src = m.author?.avatar || '/icon.svg';
    img.alt = '';

    const body = document.createElement('div');
    body.className = 'body';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = m.author?.name || 'User';
    const p = document.createElement('p');
    p.textContent = m.text || '';
    body.append(name,p);

    const tools = document.createElement('div');
    tools.className = 'chat-tools';
    if (!m.author?.owner) {
      const del = document.createElement('button');
      del.type='button'; del.dataset.action='delete'; del.textContent='×';
      const ban = document.createElement('button');
      ban.type='button'; ban.dataset.action='ban'; ban.textContent='5m';
      tools.append(del,ban);
    }
    row.append(img,body,tools);
    list.appendChild(row);
  }
  while (list.children.length > 8) list.firstElementChild?.remove();
}

$('#chatList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const row = btn.closest('.chat-msg');
  if (!row) return;
  try {
    if (btn.dataset.action === 'delete') {
      await api(`/api/youtube/chat/messages/${encodeURIComponent(row.dataset.id)}`,{method:'DELETE'});
      row.remove();
    } else {
      await api('/api/youtube/chat/ban',{method:'POST',body:{channelId:row.dataset.channel,seconds:300}});
      row.remove();
      toast('5 daqiqaga bloklandi');
    }
  } catch (err) { toast(err.message); }
});

$('#chatForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api('/api/youtube/chat/send',{method:'POST',body:{text}});
    input.value='';
    setTimeout(pollChat,400);
  } catch (err) { toast(err.message); }
});

async function emergencyUnlisted() {
  const current = currentBroadcast?.privacyStatus || 'public';
  const next = current === 'unlisted' ? 'public' : 'unlisted';
  try {
    await api('/api/youtube/live/privacy',{method:'POST',body:{privacyStatus:next}});
    if (currentBroadcast) currentBroadcast.privacyStatus = next;
    $('#emergencyBtn').textContent = next === 'unlisted' ? 'Public qaytarish' : 'Emergency Unlisted';
    toast(next === 'unlisted' ? 'LIVE Unlisted qilindi' : 'LIVE Public');
  } catch (err) { toast(err.message); }
}
$('#emergencyBtn').addEventListener('click', emergencyUnlisted);

async function loadIncidents() {
  try {
    const items = await api('/api/incidents');
    const list = $('#incidentList');
    list.innerHTML='';
    if (!items.length) {
      list.innerHTML='<span class="muted">Incident yo‘q</span>';
      return;
    }
    for (const x of items.slice(0,8)) {
      const row = document.createElement('div');
      row.className='incident';
      const body=document.createElement('div');
      const b=document.createElement('b');
      b.textContent=`Risk ${x.risk || 0}% • ${fmt(x.concurrent)} viewer`;
      const sm=document.createElement('small');
      sm.textContent=new Date(x.ts).toLocaleString();
      body.append(b,sm);
      const btn=document.createElement('button');
      btn.textContent='Report';
      btn.addEventListener('click',()=>openIncidentReport(x._id));
      row.append(body,btn);
      list.appendChild(row);
    }
  } catch {}
}
$('#refreshIncidents').addEventListener('click',loadIncidents);

async function openIncidentReport(id) {
  try {
    const d=await api(`/api/incidents/${id}/report`);
    $('#reportText').value=d.reportText || '';
    latestSupportUrl=d.supportUrl || latestSupportUrl;
    $('#reportDialog').showModal();
  } catch(err){toast(err.message);}
}
$('#evidenceBtn').addEventListener('click',async()=>{
  try {
    await api('/api/incidents/manual',{method:'POST'});
    await loadIncidents();
    toast('Dalil saqlandi');
  } catch(err){toast(err.message);}
});
$('#closeReport').addEventListener('click',()=>$('#reportDialog').close());
$('#copyReport').addEventListener('click',async()=>{
  await navigator.clipboard.writeText($('#reportText').value || '');
  toast('Nusxalandi');
});
$('#openSupport').addEventListener('click',()=>window.open(latestSupportUrl,'_blank','noopener'));

$('#notifyBtn').addEventListener('click', async () => {
  try {
    if (!('Notification' in window)) throw new Error('Notification ishlamaydi');
    const p=await Notification.requestPermission();
    if (p!=='granted') throw new Error('Ruxsat berilmadi');
    await subscribePush();
    toast('Notification yoqildi');
  } catch(err){toast(err.message);}
});

async function registerPwa() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
async function subscribePush() {
  if (!vapidPublicKey) return;
  const reg=await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if (!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(vapidPublicKey)});
  await api('/api/push/subscribe',{method:'POST',body:sub.toJSON()});
}
function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

$('#disconnectBtn').addEventListener('click', async () => {
  if (!confirm('YouTube kanalni uzasizmi?')) return;
  try { await api('/api/youtube/disconnect',{method:'POST'}); } catch {}
  location.href='/';
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    pollYoutubeStatus();
    if (!sourceStream && !streaming) startCamera(true);
  }
});

const params=new URLSearchParams(location.search);
if(params.get('youtube')) history.replaceState({},'',location.pathname);
