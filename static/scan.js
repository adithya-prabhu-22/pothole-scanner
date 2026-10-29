(() => {
'use strict';

const TOKEN = new URLSearchParams(location.search).get('token') || '';
const RESOLUTION = { width: 1920, height: 1080 };
const JPEG_QUALITY = 0.85;
const DRAIN_TIMEOUT_MS = 60000;

const $ = id => document.getElementById(id);
const video = $('preview'), framesEl = $('frames'), gpsEl = $('gps');
const speedEl = $('speed'), queueEl = $('queue'), errEl = $('err');
const toggleBtn = $('toggle'), overlay = $('overlay'), ackBtn = $('ack');

const state = { advance_m: 1.5, max_fps: 6, speed_warn_kmh: 25 };

document.querySelectorAll('.opts').forEach(g => {
  g.querySelectorAll('button').forEach(btn => {
    btn.onclick = () => {
      g.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state[g.dataset.key] = parseFloat(btn.dataset.val);
    };
  });
});

ackBtn.onclick = () => overlay.classList.add('hidden');

let sessionId = null;
let frameCounter = 0;
let latestGps = null;
let lastCapLat = null, lastCapLon = null, lastCapTime = 0;
let captureTimer = null;
let wakeLock = null;
let queue = [];
let uploading = false;
let stopped = false;

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function showError(msg) {
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

function log(msg) { console.log('[scan] ' + msg); }

async function start() {
  errEl.style.display = 'none';

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' },
               width: { ideal: RESOLUTION.width },
               height: { ideal: RESOLUTION.height } },
      audio: false,
    });
  } catch (e) {
    showError('Camera failed: ' + e.name + ' - ' + e.message);
    return;
  }
  video.srcObject = stream;
  await video.play();
  await new Promise(r => setTimeout(r, 500));

  const actualRes = video.videoWidth + 'x' + video.videoHeight;
  log('camera: ' + actualRes);

  try {
    wakeLock = await navigator.wakeLock.request('screen');
    log('wake lock acquired');
  } catch (e) {
    log('wake lock failed: ' + e.message);
  }

  try {
    const form = new FormData();
    form.append('device_id', navigator.userAgent);
    form.append('scan_settings', JSON.stringify({
      advance_m: state.advance_m,
      max_fps: state.max_fps,
      speed_warn_kmh: state.speed_warn_kmh,
      resolution_actual: actualRes,
      jpeg_quality: JPEG_QUALITY,
    }));
    const res = await fetch('/session/start', {
      method: 'POST',
      headers: { 'X-Upload-Token': TOKEN },
      body: form,
    });
    if (!res.ok) throw new Error('status ' + res.status);
    sessionId = (await res.json()).scan_session_id;
    log('session ' + sessionId);
  } catch (e) {
    showError('Session start failed: ' + e.message);
    stream.getTracks().forEach(t => t.stop());
    return;
  }

  navigator.geolocation.watchPosition(pos => {
    latestGps = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      speed: pos.coords.speed != null ? pos.coords.speed : 0,
      bearing: pos.coords.heading != null ? pos.coords.heading : 0,
    };
    gpsEl.textContent = '\u00B1' + latestGps.accuracy.toFixed(1) + 'm';
    gpsEl.className = latestGps.accuracy > 15 ? 'bad'
                     : latestGps.accuracy > 8 ? 'warn' : 'ok';
    const kmh = latestGps.speed * 3.6;
    speedEl.textContent = kmh.toFixed(0);
    speedEl.className = kmh > state.speed_warn_kmh + 5 ? 'bad'
                      : kmh > state.speed_warn_kmh ? 'warn' : 'ok';
  }, err => {
    gpsEl.textContent = 'GPS error';
    gpsEl.className = 'bad';
    log('gps error: ' + err.message);
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 5000 });

  captureTimer = setInterval(checkCapture, 100);
  stopped = false;
  toggleBtn.textContent = 'Stop Scan';
  toggleBtn.classList.add('running');
}

async function checkCapture() {
  if (stopped || !latestGps || video.videoWidth === 0) return;
  if (lastCapLat === null) {
    lastCapLat = latestGps.lat;
    lastCapLon = latestGps.lon;
    return;
  }
  const d = distanceMeters(lastCapLat, lastCapLon,
                           latestGps.lat, latestGps.lon);
  const minInterval = 1000 / state.max_fps;
  const elapsed = Date.now() - lastCapTime;
  if (d >= state.advance_m && elapsed >= minInterval) {
    lastCapLat = latestGps.lat;
    lastCapLon = latestGps.lon;
    lastCapTime = Date.now();
    await captureFrame();
  }
}

async function captureFrame() {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise(r =>
    canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY));
  if (!blob) return;

  const frameId = String(frameCounter++).padStart(7, '0');
  const form = new FormData();
  form.append('sid', sessionId);
  form.append('frame_id', frameId);
  form.append('epoch_ms', Date.now());
  form.append('lat', latestGps.lat);
  form.append('lon', latestGps.lon);
  form.append('gps_accuracy_m', latestGps.accuracy);
  form.append('speed_mps', latestGps.speed);
  form.append('bearing_deg', latestGps.bearing);
  form.append('image', blob, frameId + '.jpg');

  queue.push(form);
  framesEl.textContent = frameCounter;
  queueEl.textContent = queue.length;
  if (!uploading) uploadLoop();
}

async function uploadLoop() {
  uploading = true;
  while (queue.length > 0 && !stopped) {
    const form = queue.shift();
    queueEl.textContent = queue.length;
    try {
      const res = await fetch('/upload', {
        method: 'POST',
        headers: { 'X-Upload-Token': TOKEN },
        body: form,
      });
      if (!res.ok) throw new Error('status ' + res.status);
    } catch (e) {
      log('upload failed (' + e.message + '), retry in 2s');
      queue.unshift(form);
      queueEl.textContent = queue.length;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  uploading = false;
}

async function stop() {
  stopped = true;
  clearInterval(captureTimer);
  toggleBtn.disabled = true;

  const drainStart = Date.now();
  while ((uploading || queue.length > 0) &&
         Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
    queueEl.textContent = queue.length;
    await new Promise(r => setTimeout(r, 500));
  }

  const leftover = queue.length;
  if (leftover > 0) {
    showError(leftover + ' frames failed to upload - session marked partial');
  }

  try {
    const form = new FormData();
    form.append('sid', sessionId);
    form.append('partial', leftover > 0 ? 'true' : 'false');
    await fetch('/session/end', {
      method: 'POST',
      headers: { 'X-Upload-Token': TOKEN },
      body: form,
    });
  } catch (e) {
    showError('Session end failed: ' + e.message);
  }

  if (wakeLock) { try { await wakeLock.release(); } catch (e) {} wakeLock = null; }
  if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop());

  sessionId = null;
  toggleBtn.textContent = 'Start Scan';
  toggleBtn.classList.remove('running');
  toggleBtn.disabled = false;
}

toggleBtn.onclick = () => sessionId ? stop() : start();

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && sessionId && !wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
});

})();