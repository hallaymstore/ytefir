const $ = (s) => document.querySelector(s);
const loginView = $('#loginView');
const appView = $('#appView');
const loginForm = $('#loginForm');
const loginError = $('#loginError');
const cameraVideo = $('#cameraVideo');
const canvas = $('#portraitCanvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const stageEmpty = $('#stageEmpty');
const previewBtn = $('#previewBtn');
const goLiveBtn = $('#goLiveBtn');
const stopBtn = $('#stopBtn');
const settingsDialog = $('#settingsDialog');
const reportDialog = $('#reportDialog');
const toastEl = $('#toast');

let config = null;
let sourceStream = null;
let portraitStream = null;
let recorder = null;
let socket = null;
let drawing = false;
let streaming = false;
let installPrompt = null;
let latestReport = '';
let latestSupportUrl = 'https://support.google.com/youtube/gethelp';
let monitorHistory = [];
let ingestReadyResolver = null;
let reconnectTimer = null;

function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(url, { credentials: 'same-origin', ...options, headers });
  if (res.status === 401) {
    showLogin();
    throw new Error('Unauthorized');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
  return data;
}

function showLogin() {
  loginView.classList.remove('hidden');
  appView.classList.add('hidden');
}
function showApp() {
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  try {
    await api('/api/auth/login', { method: 'POST', body: { username: $('#loginUser').value, password: $('#loginPass').value } });
    $('#loginPass').value = '';
    showApp();
    await initDashboard();
  } catch (err) {
    loginError.textContent = err.message === 'Unauthorized' ? 'Login yoki parol xato' : err.message;
  }
});

async function checkSession() {
  try {
    await api('/api/auth/me');
    showApp();
    await initDashboard();
  } catch {
    showLogin();
  }
}

async function initDashboard() {
  await loadConfig();
  connectSocket();
  await Promise.allSettled([loadIncidents(), refreshStatus()]);
  registerPwa();
}

async function loadConfig() {
  config = await api('/api/config');
  $('#videoIdInput').value = config.videoId || '';
  $('#channelIdInput').value = config.channelId || '';
  $('#qualityInput').value = config.quality || '720x1280';
  $('#riskThresholdInput').value = config.riskThreshold || 75;
  $('#streamKeyInput').value = '';
  $('#apiKeyInput').value = '';
  $('#streamKeyState').textContent = config.hasStreamKey ? '✓ Serverda shifrlangan holda saqlangan' : 'Saqlanmagan';
  $('#apiKeyState').textContent = config.hasApiKey ? '✓ API monitoring ulangan' : 'Saqlanmagan';
  applyCanvasQuality(config.quality || '720x1280');
  $('#qualityChip').textContent = (config.quality || '720x1280').replace('x', '×');
}

function applyCanvasQuality(q) {
  const [w, h] = q.split('x').map(Number);
  canvas.width = w || 720;
  canvas.height = h || 1280;
}

$('#settingsBtn').addEventListener('click', openSettings);
$('#navSettings').addEventListener('click', openSettings);
function openSettings() {
  loadConfig().catch(() => {});
  settingsDialog.showModal();
}

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/config', {
      method: 'PUT',
      body: {
        videoId: $('#videoIdInput').value.trim(),
        channelId: $('#channelIdInput').value.trim(),
        streamKey: $('#streamKeyInput').value.trim(),
        youtubeApiKey: $('#apiKeyInput').value.trim(),
        quality: $('#qualityInput').value,
        riskThreshold: Number($('#riskThresholdInput').value || 75)
      }
    });
    settingsDialog.close();
    await loadConfig();
    toast('Sozlamalar saqlandi');
  } catch (err) {
    toast(`Xato: ${err.message}`);
  }
});

function connectSocket() {
  if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}/ws`);
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => {
    $('#networkChip').textContent = 'CONNECTED';
    $('#networkChip').style.color = '#64e6b3';
  });

  socket.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'hello') {
      if (msg.liveState?.monitor) renderMonitor(msg.liveState.monitor);
      renderIngestState(Boolean(msg.liveState?.ingestActive));
    }
    if (msg.type === 'monitor') renderMonitor(msg.monitor);
    if (msg.type === 'monitor-error') {
      $('#monitorStatus').textContent = 'API ERROR';
      $('#monitorStatus').className = 'status-chip offline';
    }
    if (msg.type === 'incident') {
      loadIncidents();
      showIncidentAlert(msg.incident);
    }
    if (msg.type === 'ingest-ready') {
      ingestReadyResolver?.({ ok: true, msg });
      ingestReadyResolver = null;
    }
    if (msg.type === 'ingest-error') {
      ingestReadyResolver?.({ ok: false, error: msg.error });
      ingestReadyResolver = null;
      toast(msg.error || 'LIVE ulanish xatosi');
    }
    if (msg.type === 'ingest-stopped') {
      if (streaming) stopLiveLocal(false);
      if (msg.lastError) console.warn('FFmpeg:', msg.lastError);
    }
    if (msg.type === 'live-state') renderIngestState(Boolean(msg.liveState?.ingestActive));
  });

  socket.addEventListener('close', () => {
    $('#networkChip').textContent = 'OFFLINE';
    $('#networkChip').style.color = '';
    if (streaming) stopLiveLocal(false);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, 2500);
  });
}

async function startPreview() {
  if (sourceStream) return;
  try {
    sourceStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    cameraVideo.srcObject = sourceStream;
    await cameraVideo.play();
    stageEmpty.classList.add('hidden');
    drawing = true;
    drawPortrait();
    previewBtn.querySelector('small').textContent = 'Camera ON';
    toast('Kamera va mikrofon tayyor');
  } catch (err) {
    toast(`Kamera xatosi: ${err.message}`);
  }
}

function stopPreview() {
  if (streaming) return;
  drawing = false;
  sourceStream?.getTracks().forEach(t => t.stop());
  sourceStream = null;
  cameraVideo.srcObject = null;
  ctx.fillStyle = '#080c15';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  stageEmpty.classList.remove('hidden');
  previewBtn.querySelector('small').textContent = 'Preview';
}

previewBtn.addEventListener('click', () => sourceStream ? stopPreview() : startPreview());

function drawPortrait() {
  if (!drawing || !sourceStream) return;
  const vw = cameraVideo.videoWidth || 1280;
  const vh = cameraVideo.videoHeight || 720;
  const dw = canvas.width;
  const dh = canvas.height;
  const srcAspect = vw / vh;
  const dstAspect = dw / dh;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (srcAspect > dstAspect) {
    sw = vh * dstAspect;
    sx = (vw - sw) / 2;
  } else {
    sh = vw / dstAspect;
    sy = (vh - sh) / 2;
  }
  ctx.drawImage(cameraVideo, sx, sy, sw, sh, 0, 0, dw, dh);
  requestAnimationFrame(drawPortrait);
}

function getPortraitStream() {
  const capture = canvas.captureStream(30);
  const audioTracks = sourceStream?.getAudioTracks() || [];
  for (const track of audioTracks) capture.addTrack(track);
  return capture;
}

function waitForIngestReady(timeoutMs = 12000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      ingestReadyResolver = null;
      resolve({ ok: false, error: 'Server LIVE javobi kechikdi' });
    }, timeoutMs);
    ingestReadyResolver = (value) => {
      clearTimeout(t);
      resolve(value);
    };
  });
}

async function startLive() {
  if (streaming) return;
  if (!sourceStream) await startPreview();
  if (!sourceStream) return;
  if (!config?.hasStreamKey) {
    toast('Avval YouTube Stream Key kiriting');
    openSettings();
    return;
  }
  connectSocket();
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast('Server bilan ulanish kutilmoqda');
    return;
  }

  goLiveBtn.disabled = true;
  socket.send(JSON.stringify({ type: 'start-ingest', quality: config.quality, fps: 30 }));
  const ready = await waitForIngestReady();
  goLiveBtn.disabled = false;
  if (!ready.ok) {
    toast(ready.error || 'LIVE boshlanmadi');
    return;
  }

  portraitStream = getPortraitStream();
  const mimeCandidates = [
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm'
  ];
  const mimeType = mimeCandidates.find(x => MediaRecorder.isTypeSupported(x)) || '';
  try {
    recorder = new MediaRecorder(portraitStream, mimeType ? { mimeType, videoBitsPerSecond: 3500000, audioBitsPerSecond: 128000 } : undefined);
  } catch (err) {
    socket.send(JSON.stringify({ type: 'stop-ingest' }));
    toast(`Encoder xatosi: ${err.message}`);
    return;
  }

  recorder.addEventListener('dataavailable', async (e) => {
    if (!e.data?.size || socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 5 * 1024 * 1024) return;
    const buf = await e.data.arrayBuffer();
    socket.send(buf);
  });
  recorder.addEventListener('stop', () => portraitStream?.getTracks().forEach(t => t.stop()));
  recorder.start(1000);
  streaming = true;
  renderIngestState(true);
  toast('YouTube RTMPS LIVE boshlandi');
}

goLiveBtn.addEventListener('click', startLive);
stopBtn.addEventListener('click', () => stopLiveLocal(true));

function stopLiveLocal(sendStop = true) {
  if (sendStop && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop-ingest' }));
  try { if (recorder?.state !== 'inactive') recorder?.stop(); } catch {}
  recorder = null;
  portraitStream?.getTracks().forEach(t => t.stop());
  portraitStream = null;
  streaming = false;
  renderIngestState(false);
  toast('LIVE to‘xtatildi');
}

function renderIngestState(active) {
  const livePill = $('#livePill');
  livePill.textContent = active ? '● LIVE' : 'OFF AIR';
  livePill.classList.toggle('off', !active);
  goLiveBtn.classList.toggle('streaming', active);
  goLiveBtn.querySelector('span').textContent = active ? 'ON AIR' : 'LIVE';
  stopBtn.disabled = !active;
  previewBtn.disabled = active;
  $('#engineStatus').textContent = active ? 'LIVE' : 'READY';
}

async function refreshStatus() {
  try {
    const s = await api('/api/live/status');
    renderIngestState(Boolean(s.ingestActive));
    renderMonitor(s.monitor || {});
  } catch {}
}
setInterval(refreshStatus, 15000);

function fmt(n) {
  n = Number(n || 0);
  return new Intl.NumberFormat('en-US', { notation: n >= 1000000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
}

function renderMonitor(m) {
  const concurrent = Number(m.concurrent || 0);
  const views = Number(m.views || 0);
  const likes = Number(m.likes || 0);
  const risk = Number(m.risk || 0);
  $('#statConcurrent').textContent = fmt(concurrent);
  $('#overlayViewers').textContent = fmt(concurrent);
  $('#statViews').textContent = fmt(views);
  $('#statLikes').textContent = fmt(likes);
  $('#statRisk').textContent = `${risk}%`;
  $('#riskMini').textContent = `Risk ${risk}%`;
  $('#riskReason').textContent = (m.reasons || []).slice(0, 2).join(' • ') || 'normal';
  $('#statConcurrentSub').textContent = m.connected ? 'real-time concurrent viewers' : 'YouTube API kutilmoqda';
  $('#monitorStatus').textContent = m.connected ? 'API LIVE' : 'API OFF';
  $('#monitorStatus').className = `status-chip ${m.connected ? 'online' : 'offline'}`;

  const riskDot = $('#riskDot');
  const badge = $('#protectionBadge');
  if (risk >= 75) {
    riskDot.style.background = '#ff3158';
    badge.className = 'protection-badge danger';
    badge.innerHTML = '<span></span> Possible attack';
  } else if (risk >= 45) {
    riskDot.style.background = '#ffb84c';
    badge.className = 'protection-badge warn';
    badge.innerHTML = '<span></span> Suspicious';
  } else {
    riskDot.style.background = '#38d996';
    badge.className = 'protection-badge normal';
    badge.innerHTML = '<span></span> Shield active';
  }

  if (m.updatedAt) {
    monitorHistory.push({ t: new Date(m.updatedAt).getTime(), viewers: concurrent, risk });
    if (monitorHistory.length > 60) monitorHistory = monitorHistory.slice(-60);
    drawChart();
  }
}

function drawChart() {
  const c = $('#chartCanvas');
  const rect = c.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = Math.max(500, Math.round(rect.width * dpr));
  c.height = Math.max(220, Math.round(rect.height * dpr));
  const x = c.getContext('2d');
  const W = c.width, H = c.height;
  x.clearRect(0, 0, W, H);
  const pad = 24 * dpr;
  x.strokeStyle = 'rgba(255,255,255,.06)';
  x.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const y = pad + ((H - pad * 2) / 4) * i;
    x.beginPath(); x.moveTo(pad, y); x.lineTo(W - pad, y); x.stroke();
  }
  if (monitorHistory.length < 2) return;
  const maxV = Math.max(10, ...monitorHistory.map(v => v.viewers)) * 1.08;
  const points = monitorHistory.map((p, i) => ({
    px: pad + (i / (monitorHistory.length - 1)) * (W - pad * 2),
    py: H - pad - (p.viewers / maxV) * (H - pad * 2),
    ry: H - pad - (p.risk / 100) * (H - pad * 2)
  }));
  const gradient = x.createLinearGradient(0, pad, 0, H - pad);
  gradient.addColorStop(0, 'rgba(76,145,255,.3)');
  gradient.addColorStop(1, 'rgba(76,145,255,0)');
  x.beginPath();
  x.moveTo(points[0].px, H - pad);
  points.forEach(p => x.lineTo(p.px, p.py));
  x.lineTo(points.at(-1).px, H - pad);
  x.closePath(); x.fillStyle = gradient; x.fill();
  x.beginPath(); points.forEach((p, i) => i ? x.lineTo(p.px, p.py) : x.moveTo(p.px, p.py));
  x.strokeStyle = '#6099ff'; x.lineWidth = 2.2 * dpr; x.stroke();
  x.beginPath(); points.forEach((p, i) => i ? x.lineTo(p.px, p.ry) : x.moveTo(p.px, p.ry));
  x.strokeStyle = 'rgba(255,70,103,.9)'; x.lineWidth = 1.5 * dpr; x.stroke();
}
window.addEventListener('resize', () => requestAnimationFrame(drawChart));

async function loadIncidents() {
  try {
    const items = await api('/api/incidents');
    const list = $('#incidentList');
    if (!items.length) {
      list.innerHTML = '<div class="empty">Hali incident yo‘q.</div>';
      return;
    }
    list.innerHTML = items.map(i => {
      const t = new Date(i.ts).toLocaleString();
      const cls = i.severity === 'critical' ? 'incident critical' : 'incident';
      const reason = (i.reasons || []).join(' • ') || 'manual evidence';
      return `<div class="${cls}"><div class="incident-icon">${i.severity === 'critical' ? '!' : '⚠'}</div><div class="incident-main"><b>${i.risk || 0}% risk • ${fmt(i.concurrent)} viewer</b><small>${t} • ${escapeHtml(reason)}</small></div><button data-report-id="${i._id}">Report</button></div>`;
    }).join('');
    list.querySelectorAll('[data-report-id]').forEach(btn => btn.addEventListener('click', () => openIncidentReport(btn.dataset.reportId)));
  } catch {}
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[ch]));
}

$('#refreshIncidents').addEventListener('click', loadIncidents);

async function openIncidentReport(id) {
  try {
    const data = await api(`/api/incidents/${id}/report`);
    latestReport = data.reportText;
    latestSupportUrl = data.supportUrl || latestSupportUrl;
    $('#reportText').value = latestReport;
    reportDialog.showModal();
  } catch (err) { toast(err.message); }
}

async function captureManualEvidence(openReport = false) {
  try {
    const data = await api('/api/incidents/manual', { method: 'POST', body: {} });
    latestReport = data.incident.reportText;
    latestSupportUrl = data.supportUrl || latestSupportUrl;
    await loadIncidents();
    toast('Dalil MongoDB’da saqlandi');
    if (openReport) {
      $('#reportText').value = latestReport;
      reportDialog.showModal();
    }
  } catch (err) { toast(err.message); }
}

$('#evidenceBtn').addEventListener('click', () => captureManualEvidence(false));
$('#reportBtn').addEventListener('click', () => captureManualEvidence(true));
$('#closeReport').addEventListener('click', () => reportDialog.close());
$('#copyReportBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#reportText').value);
  toast('Report nusxalandi');
});
$('#openSupportBtn').addEventListener('click', () => window.open(latestSupportUrl, '_blank', 'noopener,noreferrer'));

function showIncidentAlert(incident) {
  toast(`⚠ ${incident.risk}% risk: shubhali trafik aniqlandi`);
  if (Notification.permission === 'granted') {
    try { new Notification('YT Shield — shubhali trafik', { body: `${incident.risk}% risk • ${fmt(incident.concurrent)} viewer`, icon: '/icon.svg' }); } catch {}
  }
}

async function registerPwa() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/sw.js'); } catch {}
  }
}

$('#notifyBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('Bu brauzer notification’ni qo‘llamaydi');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return toast('Notification ruxsati berilmadi');
  if (!config?.vapidPublicKey || !('serviceWorker' in navigator)) return toast('Lokal notification yoqildi');
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey) });
    await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
    toast('Push notification yoqildi');
  } catch (err) {
    toast(`Push xatosi: ${err.message}`);
  }
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('#installBtn').classList.remove('hidden');
});
$('#installBtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('#installBtn').classList.add('hidden');
});

$('.bottom-nav [data-scroll="top"]').addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
$('.bottom-nav [data-scroll="chart"]').addEventListener('click', () => $('#chartCanvas').scrollIntoView({ behavior: 'smooth', block: 'center' }));
$('.bottom-nav [data-scroll="incidents"]').addEventListener('click', () => $('.incidents-panel').scrollIntoView({ behavior: 'smooth', block: 'center' }));

window.addEventListener('beforeunload', () => {
  if (streaming && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop-ingest' }));
});

checkSession();
