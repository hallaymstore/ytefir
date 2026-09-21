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
let monitorHistory = [];
let currentBroadcast = null;
let chatTimer = null;
let chatPageToken = '';
let chatSeen = new Set();
let chatPollMs = 5000;
let latestSupportUrl = 'https://support.google.com/youtube/gethelp';
let latestReport = '';
let shortsStudioUrl = 'https://studio.youtube.com/';

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
}
async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, { credentials:'same-origin', ...options, headers });
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
    await pollYoutubeStatus();
    setInterval(pollYoutubeStatus, 6000);
  } catch {
    showAuth();
  }
}
bootstrap();

async function loadChannel() {
  try {
    const st = await api('/api/youtube/oauth-status');
    if (!st.connected) {
      showAuth();
      return;
    }
    const ch = st.channel || {};
    $('#channelTitle').textContent = ch.title || 'YouTube channel';
    $('#channelMeta').textContent = [ch.customUrl, ch.subscribers ? `${fmt(ch.subscribers)} subscribers` : 'OAuth connected'].filter(Boolean).join(' • ');
    $('#channelAvatar').src = ch.thumbnail || '/icon.svg';
    $('#ytState').textContent = 'CONNECTED';
    $('#ytState').className = 'status ok';
  } catch (e) {
    if (e.status === 401) showAuth();
  }
}
$('#disconnectBtn').addEventListener('click', async () => {
  if (!confirm('YouTube kanalni uzasizmi?')) return;
  try {
    await api('/api/youtube/disconnect', { method:'POST' });
  } catch {}
  location.href = '/';
});

async function loadConfig() {
  config = await api('/api/config');
  config.quality = '720x1280';
  $('#riskThreshold').value = config.riskThreshold || 75;
  $('#autoProtect').checked = Boolean(config.autoProtect);
  applyCanvasQuality();
}
async function saveAppSettings(silent = false) {
  const riskThreshold = Number($('#riskThreshold').value || config?.riskThreshold || 75);
  const autoProtect = Boolean($('#autoProtect').checked);
  await api('/api/config', {
    method:'PUT',
    body:{ quality:'720x1280', riskThreshold, autoProtect }
  });
  config = { ...(config || {}), quality:'720x1280', riskThreshold, autoProtect };
  applyCanvasQuality();
  if (!silent) toast('Sozlamalar saqlandi');
}
$('#settingsBtn').addEventListener('click', () => $('#settingsDialog').showModal());
$('#bottomSettings').addEventListener('click', () => $('#settingsDialog').showModal());
$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await saveAppSettings();
    $('#settingsDialog').close();
  } catch (err) { toast(err.message); }
});
$('#autoProtect').addEventListener('change', () => saveAppSettings(true).catch(() => {}));

function applyCanvasQuality() {
  canvas.width = 720;
  canvas.height = 1280;
  $('#qualityChip').textContent = '720×1280';
}

function connectSocket() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/ws`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    $('#networkChip').textContent = 'SERVER';
    $('#networkChip').style.color = '#3dd598';
  });
  socket.addEventListener('message', e => {
    if (typeof e.data !== 'string') return;
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'hello') {
      renderIngestState(Boolean(msg.liveState?.ingestActive));
      if (msg.liveState?.monitor) renderMonitor(msg.liveState.monitor);
    }
    if (msg.type === 'monitor') renderMonitor(msg.monitor);
    if (msg.type === 'monitor-error') {
      $('#monitorStatus').textContent = 'API ERROR';
      $('#monitorStatus').className = 'status';
    }
    if (msg.type === 'incident') {
      loadIncidents();
      toast(`Shubhali trafik: risk ${msg.incident?.risk || 0}%`);
      if ($('#autoProtect').checked && Number(msg.incident?.risk || 0) >= 95) {
        emergencyUnlisted(true).catch(() => {});
      }
    }
    if (msg.type === 'ingest-ready') {
      ingestReadyResolver?.({ok:true,msg});
      ingestReadyResolver = null;
    }
    if (msg.type === 'ingest-error') {
      ingestReadyResolver?.({ok:false,error:msg.error});
      ingestReadyResolver = null;
      toast(msg.error || 'Encoder xatosi');
    }
    if (msg.type === 'ingest-stopped') {
      if (streaming) stopLocalOnly();
      if (msg.lastError) console.warn(msg.lastError);
    }
    if (msg.type === 'live-state') renderIngestState(Boolean(msg.liveState?.ingestActive));
  });
  socket.addEventListener('close', () => {
    $('#networkChip').textContent = 'OFFLINE';
    $('#networkChip').style.color = '';
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 2200);
  });
}

async function startPreview() {
  if (sourceStream) return true;
  try {
    sourceStream = await navigator.mediaDevices.getUserMedia({
      video:{
        facingMode:'user',
        width:{ideal:1920},
        height:{ideal:1080},
        frameRate:{ideal:30,max:30}
      },
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
    cameraVideo.srcObject = sourceStream;
    await cameraVideo.play();
    $('#stageEmpty').classList.add('hidden');
    drawing = true;
    drawPortrait();
    $('#previewBtn').classList.add('active');
    toast('Kamera va mikrofon tayyor');
    return true;
  } catch (err) {
    toast(`Kamera: ${err.message}`);
    return false;
  }
}
function stopPreview() {
  if (streaming) return;
  drawing = false;
  sourceStream?.getTracks().forEach(t => t.stop());
  sourceStream = null;
  cameraVideo.srcObject = null;
  ctx.fillStyle = '#060910';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  $('#stageEmpty').classList.remove('hidden');
}
$('#previewBtn').addEventListener('click', () => sourceStream ? stopPreview() : startPreview());

function drawPortrait() {
  if (!drawing || !sourceStream) return;
  const vw = cameraVideo.videoWidth || 1280;
  const vh = cameraVideo.videoHeight || 720;
  const dw = canvas.width, dh = canvas.height;
  const srcAspect = vw / vh, dstAspect = dw / dh;
  let sx=0,sy=0,sw=vw,sh=vh;
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
function portraitCapture() {
  const s = canvas.captureStream(30);
  for (const t of sourceStream?.getAudioTracks() || []) s.addTrack(t);
  return s;
}
function waitForIngestReady(timeout=15000) {
  return new Promise(resolve => {
    const t = setTimeout(() => {
      ingestReadyResolver = null;
      resolve({ok:false,error:'LIVE server javobi kechikdi'});
    }, timeout);
    ingestReadyResolver = v => { clearTimeout(t); resolve(v); };
  });
}

async function startLive() {
  if (streaming) return;
  $('#goLiveBtn').disabled = true;
  try {
    if (!sourceStream && !(await startPreview())) return;
    await saveAppSettings(true);

    $('#liveStateBadge').textContent = 'CHECKING SHORTS';
    const live = await api('/api/youtube/live/ensure', {
      method:'POST',
      body:{
        title: $('#liveTitle').value.trim(),
        description: $('#liveDescription').value.trim(),
        privacyStatus:'public',
        quality:'720x1280'
      }
    });
    currentBroadcast = live.broadcast || null;
    if (currentBroadcast?.title && !$('#liveTitle').value.trim()) $('#liveTitle').value = currentBroadcast.title;
    await loadConfig();

    connectSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) await new Promise(r => setTimeout(r,1200));
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Server websocket ulanmagan');

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
      if (socket.bufferedAmount > 7 * 1024 * 1024) return;
      socket.send(await e.data.arrayBuffer());
    });
    recorder.addEventListener('stop', () => portraitStream?.getTracks().forEach(t => t.stop()));
    recorder.start(750);
    streaming = true;
    renderIngestState(true);
    $('#liveStateBadge').textContent = 'STARTING';
    $('#liveStateBadge').className = 'status live';
    toast('Shorts LIVE oqimi YouTube’ga yuborilmoqda');

    // YouTube transition only after its ingest reports ACTIVE.
    api('/api/youtube/live/transition',{method:'POST'})
      .then(() => {
        toast('SHORTS LIVE boshlandi');
        pollYoutubeStatus();
        startChatPolling();
      })
      .catch(err => {
        console.warn('transition', err);
        toast(err.message || 'YouTube LIVE transition xatosi');
      });
  } catch (err) {
    try { socket?.send(JSON.stringify({type:'stop-ingest'})); } catch {}
    stopLocalOnly();
    if (err.status === 409 && err.data?.code === 'SHORTS_SETUP_REQUIRED') {
      shortsStudioUrl = err.data?.studioUrl || shortsStudioUrl;
      showShortsSetup();
    } else {
      toast(err.message || 'SHORTS LIVE boshlanmadi');
    }
    $('#liveStateBadge').textContent = 'READY';
    $('#liveStateBadge').className = 'status';
  } finally {
    if (!streaming) $('#goLiveBtn').disabled = false;
  }
}
$('#goLiveBtn').addEventListener('click', startLive);

async function stopLive() {
  if (!streaming && !currentBroadcast) return;
  $('#stopBtn').disabled = true;
  try {
    await api('/api/youtube/live/complete',{method:'POST'}).catch(() => null);
  } finally {
    try { socket?.send(JSON.stringify({type:'stop-ingest'})); } catch {}
    stopLocalOnly();
    stopChatPolling();
    currentBroadcast = null;
    toast('LIVE yakunlandi');
    setTimeout(pollYoutubeStatus,1500);
  }
}
$('#stopBtn').addEventListener('click', stopLive);
function stopLocalOnly() {
  try { if (recorder?.state !== 'inactive') recorder?.stop(); } catch {}
  recorder = null;
  portraitStream?.getTracks().forEach(t => t.stop());
  portraitStream = null;
  streaming = false;
  renderIngestState(false);
}
function renderIngestState(active) {
  $('#livePill').textContent = active ? '● LIVE' : 'OFF AIR';
  $('#livePill').classList.toggle('off',!active);
  $('#goLiveBtn').classList.toggle('streaming',active);
  $('#goLiveBtn').textContent = active ? 'ON AIR' : 'GO LIVE';
  $('#goLiveBtn').disabled = active;
  $('#stopBtn').disabled = !active;
  $('#previewBtn').disabled = active;
}

async function pollYoutubeStatus() {
  try {
    const s = await api('/api/youtube/live/status');
    shortsStudioUrl = s.studioUrl || shortsStudioUrl;
    const b = s.broadcast;
    const st = s.stream;
    currentBroadcast = b || null;

    const readyBadge = $('#shortsReadyBadge');
    if (s.shortsReady && b?.instant) {
      readyBadge.textContent = 'SHORTS READY';
      readyBadge.className = 'status ok';
    } else {
      readyBadge.textContent = 'SETUP NEEDED';
      readyBadge.className = 'status';
    }

    if (b) {
      $('#liveStateBadge').textContent = (b.lifeCycleStatus || 'READY').toUpperCase();
      $('#liveStateBadge').className = `status ${b.lifeCycleStatus === 'live' ? 'live' : ''}`;
      $('#streamHealth').textContent = st?.healthStatus ? `${st.streamStatus} • ${st.healthStatus}` : (st?.streamStatus || b.lifeCycleStatus || 'Ready');
      if (b.title && !$('#liveTitle').value) $('#liveTitle').value = b.title;
      if (b.lifeCycleStatus === 'live') startChatPolling();
      if (b.lifeCycleStatus === 'complete') stopChatPolling();
      $('#emergencyBtn').textContent = b.privacyStatus === 'unlisted' ? 'Restore Public' : 'Emergency Unlisted';
    } else {
      $('#liveStateBadge').textContent = 'SHORTS SETUP';
      $('#liveStateBadge').className = 'status';
      $('#streamHealth').textContent = 'Instant LIVE kerak';
    }
    return s;
  } catch {
    return null;
  }
}

async function emergencyUnlisted(silent=false) {
  const current = currentBroadcast?.privacyStatus || 'public';
  const next = current === 'unlisted' ? 'public' : 'unlisted';
  if (!silent && next === 'unlisted' && !confirm('LIVE public tavsiyalardan yashiriladi. Davom etilsinmi?')) return;
  try {
    await api('/api/youtube/live/privacy',{method:'POST',body:{privacyStatus:next}});
    if (currentBroadcast) currentBroadcast.privacyStatus = next;
    $('#emergencyBtn').textContent = next === 'unlisted' ? 'Restore Public' : 'Emergency Unlisted';
    toast(next === 'unlisted' ? 'LIVE Unlisted himoya rejimiga o‘tdi' : 'LIVE yana Public');
  } catch (err) { toast(err.message); }
}
$('#emergencyBtn').addEventListener('click', () => emergencyUnlisted(false));

function fmt(n) {
  n = Number(n || 0);
  return new Intl.NumberFormat('en-US',{notation:n>=1000000?'compact':'standard',maximumFractionDigits:1}).format(n);
}
function renderMonitor(m={}) {
  const concurrent = Number(m.concurrent || 0), views=Number(m.views || 0), likes=Number(m.likes || 0), risk=Number(m.risk || 0);
  $('#statConcurrent').textContent = fmt(concurrent);
  $('#overlayViewers').textContent = fmt(concurrent);
  $('#statViews').textContent = fmt(views);
  $('#statLikes').textContent = fmt(likes);
  $('#statRisk').textContent = `${risk}%`;
  $('#riskMini').textContent = `Risk ${risk}%`;
  $('#riskReason').textContent = (m.reasons || []).slice(0,2).join(' • ') || 'normal';
  $('#monitorStatus').textContent = m.connected ? 'API LIVE' : 'API OFF';
  $('#monitorStatus').className = `status ${m.connected?'ok':''}`;
  if (m.updatedAt) {
    monitorHistory.push({t:new Date(m.updatedAt).getTime(),viewers:concurrent,risk});
    if (monitorHistory.length > 80) monitorHistory = monitorHistory.slice(-80);
    drawChart();
  }
}
function drawChart() {
  const c = $('#chartCanvas');
  const box = c.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1,2);
  c.width = Math.max(500,Math.round(box.width*dpr));
  c.height = Math.max(230,Math.round(box.height*dpr));
  const g = c.getContext('2d');
  g.clearRect(0,0,c.width,c.height);
  const pad = 34*dpr, W=c.width-pad*2, H=c.height-pad*1.6;
  g.strokeStyle='rgba(255,255,255,.06)';g.lineWidth=1;
  for(let i=0;i<5;i++){const y=pad+(H/4)*i;g.beginPath();g.moveTo(pad,y);g.lineTo(pad+W,y);g.stroke()}
  if (monitorHistory.length<2) return;
  const maxV=Math.max(10,...monitorHistory.map(x=>x.viewers));
  const pts=monitorHistory.map((x,i)=>({
    x:pad+(i/(monitorHistory.length-1))*W,
    y:pad+H-(x.viewers/maxV)*H,
    ry:pad+H-(x.risk/100)*H
  }));
  g.strokeStyle='#6d8cff';g.lineWidth=2.2*dpr;g.beginPath();pts.forEach((p,i)=>i?g.lineTo(p.x,p.y):g.moveTo(p.x,p.y));g.stroke();
  g.strokeStyle='rgba(255,73,108,.8)';g.lineWidth=1.6*dpr;g.beginPath();pts.forEach((p,i)=>i?g.lineTo(p.x,p.ry):g.moveTo(p.x,p.ry));g.stroke();
}
addEventListener('resize',()=>requestAnimationFrame(drawChart));

function startChatPolling() {
  if (chatTimer) return;
  chatPageToken='';
  chatSeen.clear();
  $('#chatState').textContent='LIVE';
  $('#chatState').className='status ok';
  pollChat();
}
function stopChatPolling() {
  clearTimeout(chatTimer);
  chatTimer=null;
  chatPageToken='';
  $('#chatState').textContent='WAITING';
  $('#chatState').className='status';
}
async function pollChat() {
  clearTimeout(chatTimer);
  try {
    const q = chatPageToken ? `?pageToken=${encodeURIComponent(chatPageToken)}` : '';
    const data = await api(`/api/youtube/chat/messages${q}`);
    chatPageToken = data.nextPageToken || chatPageToken;
    chatPollMs = Math.max(2000,Number(data.pollingIntervalMillis || 5000));
    appendChat(data.items || []);
  } catch (err) {
    if (!/ended|disabled|topilmadi/i.test(err.message)) console.warn('chat',err.message);
  }
  chatTimer=setTimeout(pollChat,chatPollMs);
}
function appendChat(items) {
  const list=$('#chatList');
  if (!items.length && !chatSeen.size) return;
  if (!chatSeen.size) list.innerHTML='';
  for(const m of items){
    if(chatSeen.has(m.id)) continue;
    chatSeen.add(m.id);
    const row=document.createElement('div');row.className='chat-msg';row.dataset.id=m.id;row.dataset.channel=m.author?.channelId||'';
    const img=document.createElement('img');img.src=m.author?.avatar||'/icon.svg';img.alt='';
    const body=document.createElement('div');
    const name=document.createElement('div');name.className='name';name.textContent=m.author?.name||'User';
    if(m.author?.owner||m.author?.moderator||m.author?.member){const em=document.createElement('em');em.textContent=m.author.owner?'OWNER':m.author.moderator?'MOD':'MEMBER';name.appendChild(em)}
    const p=document.createElement('p');p.textContent=m.text||'';
    body.append(name,p);
    const tools=document.createElement('div');tools.className='chat-tools';
    if(!m.author?.owner){
      const del=document.createElement('button');del.type='button';del.textContent='Delete';del.dataset.action='delete';
      const ban=document.createElement('button');ban.type='button';ban.textContent='5m';ban.dataset.action='ban';
      tools.append(del,ban);
    }
    row.append(img,body,tools);list.appendChild(row);
  }
  while(list.children.length>160) list.firstElementChild?.remove();
  list.scrollTop=list.scrollHeight;
}
$('#chatList').addEventListener('click',async e=>{
  const btn=e.target.closest('button[data-action]');if(!btn)return;
  const row=btn.closest('.chat-msg');if(!row)return;
  try{
    if(btn.dataset.action==='delete'){
      await api(`/api/youtube/chat/messages/${encodeURIComponent(row.dataset.id)}`,{method:'DELETE'});
      row.remove();
    }else{
      await api('/api/youtube/chat/ban',{method:'POST',body:{channelId:row.dataset.channel,seconds:300}});
      row.remove();toast('User 5 daqiqaga bloklandi');
    }
  }catch(err){toast(err.message)}
});
$('#chatForm').addEventListener('submit',async e=>{
  e.preventDefault();const input=$('#chatInput');const text=input.value.trim();if(!text)return;
  try{await api('/api/youtube/chat/send',{method:'POST',body:{text}});input.value='';setTimeout(pollChat,500)}catch(err){toast(err.message)}
});

async function loadIncidents() {
  try {
    const items=await api('/api/incidents');
    const list=$('#incidentList');
    list.innerHTML='';
    if(!items.length){list.innerHTML='<div class="empty">Incident yo‘q.</div>';return}
    for(const x of items){
      const row=document.createElement('div');row.className=`incident ${x.severity||''}`;
      const dot=document.createElement('span');dot.className='dot';
      const body=document.createElement('div');
      const b=document.createElement('b');b.textContent=`Risk ${x.risk||0}% • ${fmt(x.concurrent)} viewer`;
      const sm=document.createElement('small');sm.textContent=`${new Date(x.ts).toLocaleString()} • ${(x.reasons||[]).slice(0,2).join(' • ')}`;
      body.append(b,sm);
      const btn=document.createElement('button');btn.textContent='Report';btn.addEventListener('click',()=>openIncidentReport(x._id));
      row.append(dot,body,btn);list.appendChild(row);
    }
  } catch {}
}
async function openIncidentReport(id) {
  try {
    const d=await api(`/api/incidents/${id}/report`);
    latestReport=d.reportText||'';latestSupportUrl=d.supportUrl||latestSupportUrl;
    $('#reportText').value=latestReport;$('#reportDialog').showModal();
  }catch(err){toast(err.message)}
}
$('#evidenceBtn').addEventListener('click',async()=>{
  try{
    const d=await api('/api/incidents/manual',{method:'POST'});
    latestReport=d.incident?.reportText||'';latestSupportUrl=d.supportUrl||latestSupportUrl;
    await loadIncidents();toast('Dalil saqlandi');
  }catch(err){toast(err.message)}
});
$('#closeReport').addEventListener('click',()=>$('#reportDialog').close());
$('#copyReport').addEventListener('click',async()=>{await navigator.clipboard.writeText($('#reportText').value||'');toast('Report nusxalandi')});
$('#openSupport').addEventListener('click',()=>window.open(latestSupportUrl,'_blank','noopener'));


function showShortsSetup() {
  const d = $('#shortsSetupDialog');
  if (d && !d.open) d.showModal();
}
$('#closeShortsSetup')?.addEventListener('click', () => $('#shortsSetupDialog').close());
$('#openStudioLive')?.addEventListener('click', () => {
  window.open(shortsStudioUrl, '_blank', 'noopener');
});
$('#checkShortsReady')?.addEventListener('click', async () => {
  const st = await pollYoutubeStatus();
  if (st?.shortsReady && st?.broadcast?.instant) {
    $('#shortsSetupDialog').close();
    toast('Instant SHORTS LIVE topildi — GO LIVE bosing');
  } else {
    toast('Hali instant LIVE topilmadi');
  }
});
window.addEventListener('focus', () => {
  setTimeout(async () => {
    const st = await pollYoutubeStatus();
    if (st?.shortsReady && st?.broadcast?.instant && $('#shortsSetupDialog')?.open) {
      $('#shortsSetupDialog').close();
      toast('Shorts LIVE tayyor');
    }
  }, 900);
});

async function registerPwa() {
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
}
$('#notifyBtn').addEventListener('click',async()=>{
  try{
    if(!('Notification' in window)) throw new Error('Notification qo‘llanmaydi');
    const p=await Notification.requestPermission();
    if(p!=='granted') throw new Error('Notification ruxsati berilmadi');
    await subscribePush();
    toast('Bildirishnomalar yoqildi');
  }catch(err){toast(err.message)}
});
async function subscribePush() {
  const cfg=config||await api('/api/config');
  if(!cfg.vapidPublicKey) return;
  const reg=await navigator.serviceWorker.ready;
  let sub=await reg.pushManager.getSubscription();
  if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(cfg.vapidPublicKey)});
  await api('/api/push/subscribe',{method:'POST',body:sub.toJSON()});
}
function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

document.querySelectorAll('.bottom-nav button[data-target]').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.bottom-nav button').forEach(x=>x.classList.remove('active'));btn.classList.add('active');
  const t=btn.dataset.target;
  if(t==='live') document.querySelector('.composer')?.scrollIntoView({behavior:'smooth',block:'start'});
  if(t==='chat') document.querySelector('.chat-panel')?.scrollIntoView({behavior:'smooth',block:'start'});
  if(t==='shield') document.querySelector('.right-col')?.scrollIntoView({behavior:'smooth',block:'start'});
}));

const params=new URLSearchParams(location.search);
if(params.get('youtube')){
  history.replaceState({},'',location.pathname);
}
