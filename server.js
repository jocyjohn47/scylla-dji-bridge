// ================================================================
// server.js  —  Scylla.ai ↔ DJI FlightHub 2 Middleware Bridge v1.1
// ================================================================
'use strict';
require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { transform, buildDJIHeaders } = require('./transformer');
const { triggerWorkflow }            = require('./djiClient');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── In-memory config (survives restarts via .env, editable via /admin) ──
const cfg = {
  SCYLLA_PUSH_TOKEN  : process.env.SCYLLA_PUSH_TOKEN   || '',
  DJI_X_USER_TOKEN   : process.env.DJI_X_USER_TOKEN    || '',
  DJI_X_PROJECT_UUID : process.env.DJI_X_PROJECT_UUID  || 'b8cf4c12-0e36-4603-82df-c4660ce770be',
  DJI_WORKFLOW_UUID  : process.env.DJI_WORKFLOW_UUID    || '047beaa8-103e-4e49-9371-c54c253d555e',
  DJI_CREATOR_ID     : process.env.DJI_CREATOR_ID       || '1847118310561013760',
  DJI_FH2_ENDPOINT   : process.env.DJI_FH2_ENDPOINT    || 'https://es-flight-api-us.djigate.com',
  DJI_FH2_PATH       : process.env.DJI_FH2_PATH         || '/openapi/v0.1/workflow',
  AUTO_TRIGGER_LEVEL : parseInt(process.env.AUTO_TRIGGER_LEVEL || '3', 10),
  DEFAULT_LATITUDE   : parseFloat(process.env.DEFAULT_LATITUDE  || '22.793234156'),
  DEFAULT_LONGITUDE  : parseFloat(process.env.DEFAULT_LONGITUDE || '114.258620618'),
  ADMIN_PASSWORD     : process.env.ADMIN_PASSWORD || 'admin1234',
};

// sync cfg back to process.env so transformer.js picks them up
function syncEnv() {
  Object.entries(cfg).forEach(([k, v]) => { process.env[k] = String(v); });
}
syncEnv();

// ── Middleware ──────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(morgan('tiny'));

const webhookLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true });

// ── Log store (last 50) ─────────────────────────────────────────
const logs = [];
function addLog(type, msg, data) {
  const entry = { time: new Date().toISOString(), type, msg, data: data || null };
  logs.unshift(entry);
  if (logs.length > 50) logs.pop();
}

// ════════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════════

// ── Health ──────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({
    status : 'ok',
    service: 'Scylla → DJI FH2 Bridge v1.1',
    uptime : Math.floor(process.uptime()) + 's',
    configured: {
      DJI_X_USER_TOKEN  : !!cfg.DJI_X_USER_TOKEN && cfg.DJI_X_USER_TOKEN !== 'YOUR_SECRET_TOKEN',
      DJI_X_PROJECT_UUID: !!cfg.DJI_X_PROJECT_UUID,
      DJI_WORKFLOW_UUID : !!cfg.DJI_WORKFLOW_UUID,
      SCYLLA_PUSH_TOKEN : !!cfg.SCYLLA_PUSH_TOKEN && cfg.SCYLLA_PUSH_TOKEN !== 'your_scylla_push_token_here',
    }
  });
});

// ── Config read ─────────────────────────────────────────────────
app.get('/config', (_, res) => {
  res.json({
    dji: {
      project_uuid : cfg.DJI_X_PROJECT_UUID,
      workflow_uuid: cfg.DJI_WORKFLOW_UUID,
      creator_id   : cfg.DJI_CREATOR_ID,
      endpoint     : cfg.DJI_FH2_ENDPOINT + cfg.DJI_FH2_PATH,
      token_set    : !!cfg.DJI_X_USER_TOKEN && cfg.DJI_X_USER_TOKEN !== 'YOUR_SECRET_TOKEN',
    },
    scylla: { token_set: !!cfg.SCYLLA_PUSH_TOKEN && cfg.SCYLLA_PUSH_TOKEN !== 'your_scylla_push_token_here' },
    auto_trigger_level: cfg.AUTO_TRIGGER_LEVEL,
    default_gps: { latitude: cfg.DEFAULT_LATITUDE, longitude: cfg.DEFAULT_LONGITUDE },
  });
});

// ── Scylla Webhook ──────────────────────────────────────────────
app.post('/webhook/scylla', webhookLimiter, async (req, res) => {
  // 1. Validate Bearer token
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!cfg.SCYLLA_PUSH_TOKEN || cfg.SCYLLA_PUSH_TOKEN === 'your_scylla_push_token_here') {
    addLog('WARN', 'SCYLLA_PUSH_TOKEN not configured — accepting all');
  } else if (token !== cfg.SCYLLA_PUSH_TOKEN) {
    addLog('WARN', 'Rejected webhook — bad token', { receivedToken: token.slice(0,8)+'...' });
    return res.status(401).json({ error: 'Invalid Scylla push token' });
  }

  // 2. Transform
  const payload = req.body;
  const { djiBody, level } = transform(payload);

  addLog('IN', `Scylla alert received — level ${level}`, {
    alertLabel : payload.alert?.label || 'unknown',
    camera     : payload.camera_name || 'N/A',
    coordinates: { lat: djiBody.params.latitude, lng: djiBody.params.longitude },
  });

  // 3. Check threshold
  if (level < cfg.AUTO_TRIGGER_LEVEL) {
    addLog('SKIP', `Level ${level} below threshold ${cfg.AUTO_TRIGGER_LEVEL} — no dispatch`);
    return res.json({ status: 'skipped', reason: `level ${level} < threshold ${cfg.AUTO_TRIGGER_LEVEL}`, level });
  }

  // 4. Forward to DJI FH2
  try {
    const headers = buildDJIHeaders();
    const djiResp = await triggerWorkflow(headers, djiBody);
    addLog('OUT', `DJI FH2 dispatch OK — level ${level}`, { djiBody, djiResp });
    return res.json({ status: 'dispatched', level, djiBody, djiResponse: djiResp });
  } catch (err) {
    const errData = { message: err.message, status: err.response?.status, data: err.response?.data };
    addLog('ERR', 'DJI FH2 call failed', errData);
    return res.status(502).json({ status: 'error', error: 'DJI FH2 call failed', detail: errData });
  }
});

// ── Test trigger ────────────────────────────────────────────────
app.post('/test/trigger', async (req, res) => {
  const { latitude, longitude, level = 5, description = 'Manual test dispatch' } = req.body;
  const mockPayload = {
    location: {
      latitude : latitude  || cfg.DEFAULT_LATITUDE,
      longitude: longitude || cfg.DEFAULT_LONGITUDE,
    },
    alert      : { label: 'test_dispatch', severity: level },
    description,
  };
  const { djiBody } = transform(mockPayload);
  try {
    const headers  = buildDJIHeaders();
    const djiResp  = await triggerWorkflow(headers, djiBody);
    addLog('TEST', 'Manual test dispatch sent', { djiBody, djiResp });
    return res.json({ status: 'ok', djiBody, djiResponse: djiResp });
  } catch (err) {
    const errData = { message: err.message, status: err.response?.status, data: err.response?.data };
    addLog('ERR', 'Test dispatch failed', errData);
    return res.status(502).json({ status: 'error', detail: errData });
  }
});

// ── Recent logs ─────────────────────────────────────────────────
app.get('/logs', (_, res) => res.json({ count: logs.length, logs }));

// ── Config update API ───────────────────────────────────────────
app.post('/admin/config', (req, res) => {
  const { adminPassword, ...newCfg } = req.body;
  if (adminPassword !== cfg.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Wrong admin password' });
  }
  const allowed = [
    'SCYLLA_PUSH_TOKEN','DJI_X_USER_TOKEN','DJI_X_PROJECT_UUID',
    'DJI_WORKFLOW_UUID','DJI_CREATOR_ID','DJI_FH2_ENDPOINT','DJI_FH2_PATH',
    'AUTO_TRIGGER_LEVEL','DEFAULT_LATITUDE','DEFAULT_LONGITUDE','ADMIN_PASSWORD'
  ];
  let updated = [];
  for (const key of allowed) {
    if (newCfg[key] !== undefined && newCfg[key] !== '') {
      cfg[key] = key === 'AUTO_TRIGGER_LEVEL' ? parseInt(newCfg[key], 10)
               : (key === 'DEFAULT_LATITUDE' || key === 'DEFAULT_LONGITUDE') ? parseFloat(newCfg[key])
               : newCfg[key];
      updated.push(key);
    }
  }
  syncEnv();
  addLog('CFG', `Config updated: ${updated.join(', ')}`);
  return res.json({ status: 'ok', updated });
});

// ── Admin UI ────────────────────────────────────────────────────
app.get('/admin', (_, res) => {
  const tokenOK = !!cfg.DJI_X_USER_TOKEN && cfg.DJI_X_USER_TOKEN !== 'YOUR_SECRET_TOKEN';
  const scyllaOK = !!cfg.SCYLLA_PUSH_TOKEN && cfg.SCYLLA_PUSH_TOKEN !== 'your_scylla_push_token_here';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Bridge Admin — Scylla.ai ↔ DJI FH2</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
  .topbar{background:linear-gradient(135deg,#1a1f2e,#0d1b2a);padding:20px 32px;border-bottom:2px solid #2d3748;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
  .topbar h1{font-size:22px;font-weight:800;color:#fff}
  .topbar span{font-size:13px;color:#94a3b8}
  .status-bar{display:flex;gap:10px;padding:14px 32px;background:#141824;border-bottom:1px solid #2d3748;flex-wrap:wrap}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:5px 14px;border-radius:20px;font-size:13px;font-weight:700}
  .badge.ok{background:#1a3a2a;color:#68d391;border:1px solid #276749}
  .badge.warn{background:#3b2800;color:#f6ad55;border:1px solid #d69e2e}
  .container{max-width:900px;margin:0 auto;padding:28px 24px}
  .card{background:#1a2035;border:1px solid #2d3748;border-radius:14px;padding:24px;margin-bottom:22px}
  .card h2{font-size:16px;font-weight:700;color:#63b3ed;margin-bottom:18px;display:flex;align-items:center;gap:8px}
  .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:600px){.form-grid{grid-template-columns:1fr}}
  .field{display:flex;flex-direction:column;gap:6px}
  .field label{font-size:12px;font-weight:700;color:#a0aec0;text-transform:uppercase;letter-spacing:.5px}
  .field input,.field select{background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 14px;color:#e2e8f0;font-size:14px;outline:none;transition:border .2s}
  .field input:focus,.field select:focus{border-color:#3182ce}
  .field .hint{font-size:11px;color:#718096}
  .field .required{color:#fc8181}
  .btn{padding:12px 24px;border-radius:10px;font-size:14px;font-weight:700;border:none;cursor:pointer;transition:all .2s}
  .btn-primary{background:#3182ce;color:#fff}
  .btn-primary:hover{background:#2b6cb0}
  .btn-green{background:#276749;color:#9ae6b4}
  .btn-green:hover{background:#22543d}
  .btn-red{background:#c53030;color:#fed7d7}
  .btn-red:hover{background:#9b2c2c}
  .btn-row{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}
  #msg{margin-top:14px;padding:12px 16px;border-radius:8px;font-size:14px;display:none}
  #msg.ok{background:#1a3a2a;border:1px solid #276749;color:#68d391}
  #msg.err{background:#3b1818;border:1px solid #c53030;color:#fc8181}
  .log-box{background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:14px;height:220px;overflow-y:auto;font-family:monospace;font-size:12px}
  .log-entry{padding:4px 0;border-bottom:1px solid #1a2035}
  .log-entry .time{color:#718096}
  .log-entry .type-IN{color:#63b3ed}
  .log-entry .type-OUT{color:#68d391}
  .log-entry .type-ERR{color:#fc8181}
  .log-entry .type-WARN{color:#f6ad55}
  .log-entry .type-SKIP{color:#a0aec0}
  .log-entry .type-TEST{color:#b794f4}
  .log-entry .type-CFG{color:#fbd38d}
  .url-box{background:#0d1117;border:1px solid #2b6cb0;border-radius:8px;padding:10px 14px;font-family:monospace;font-size:13px;color:#63b3ed;word-break:break-all;margin:8px 0}
  .section-divider{height:1px;background:#2d3748;margin:8px 0 16px}
  .fullwidth{grid-column:1/-1}
</style>
</head>
<body>
<div class="topbar">
  <div>
    <h1>⚙️ Bridge Admin — Scylla.ai ↔ DJI FlightHub 2</h1>
    <span>Live config editor • No restart needed</span>
  </div>
  <div style="display:flex;gap:8px;align-items:center">
    <span style="font-size:12px;color:#718096">Bridge URL:</span>
    <span style="font-family:monospace;font-size:12px;color:#63b3ed">${req.protocol}://${req.get('host')}</span>
  </div>
</div>
<div class="status-bar">
  <span class="badge ${tokenOK ? 'ok' : 'warn'}">${tokenOK ? '✅' : '⚠️'} DJI X-User-Token ${tokenOK ? 'SET' : 'MISSING'}</span>
  <span class="badge ${scyllaOK ? 'ok' : 'warn'}">${scyllaOK ? '✅' : '⚠️'} Scylla Push Token ${scyllaOK ? 'SET' : 'MISSING'}</span>
  <span class="badge ok">🔗 Project UUID: ${cfg.DJI_X_PROJECT_UUID.slice(0,8)}...</span>
  <span class="badge ok">🚁 Workflow UUID: ${cfg.DJI_WORKFLOW_UUID.slice(0,8)}...</span>
  <span class="badge ok">📡 Trigger Level: ≥${cfg.AUTO_TRIGGER_LEVEL}</span>
</div>

<div class="container">

  <!-- Webhook URL box -->
  <div class="card">
    <h2>📡 Your Webhook URLs (paste these into Scylla.ai)</h2>
    <div style="font-size:13px;color:#94a3b8;margin-bottom:8px">Scylla HTTP Endpoint → URL field:</div>
    <div class="url-box">${req.protocol}://${req.get('host')}/webhook/scylla</div>
    <div style="font-size:13px;color:#94a3b8;margin:12px 0 8px">Health check:</div>
    <div class="url-box">${req.protocol}://${req.get('host')}/health</div>
    <div style="font-size:13px;color:#94a3b8;margin:12px 0 8px">Recent logs:</div>
    <div class="url-box">${req.protocol}://${req.get('host')}/logs</div>
  </div>

  <!-- Config Form -->
  <div class="card">
    <h2>✏️ Edit Configuration</h2>
    <form id="cfgForm">
      <div class="form-grid">

        <div class="field fullwidth">
          <label>🔐 Admin Password <span class="required">*required to save</span></label>
          <input type="password" id="adminPassword" placeholder="Enter admin password" autocomplete="off"/>
          <span class="hint">Default password: admin1234 (change it after first login)</span>
        </div>

        <div class="section-divider fullwidth"></div>
        <div class="fullwidth" style="color:#63b3ed;font-size:13px;font-weight:700;margin-bottom:4px">── Scylla.ai Settings ──</div>

        <div class="field fullwidth">
          <label>🔑 Scylla Push Token <span class="required">*</span></label>
          <input type="text" id="SCYLLA_PUSH_TOKEN" placeholder="e.g. my_secret_scylla_token_2024" value="${cfg.SCYLLA_PUSH_TOKEN !== 'your_scylla_push_token_here' ? cfg.SCYLLA_PUSH_TOKEN : ''}"/>
          <span class="hint">You invent this value — paste the same value into Scylla.ai → Create HTTP Endpoint → Push Token</span>
        </div>

        <div class="section-divider fullwidth"></div>
        <div class="fullwidth" style="color:#68d391;font-size:13px;font-weight:700;margin-bottom:4px">── DJI FlightHub 2 Settings ──</div>

        <div class="field fullwidth">
          <label>🚁 DJI X-User-Token (Organization Key) <span class="required">*MOST IMPORTANT</span></label>
          <input type="text" id="DJI_X_USER_TOKEN" placeholder="64-character hex key from FH2 → My Org → Settings → FlightHub Sync → Org Key" value="${cfg.DJI_X_USER_TOKEN !== 'YOUR_SECRET_TOKEN' ? cfg.DJI_X_USER_TOKEN : ''}"/>
          <span class="hint">📍 Where to find: Login fh.dji.com → top-right avatar → My Organization → ⚙️ gear icon → FlightHub Sync tab → Organization Key (copy full key)</span>
        </div>

        <div class="field">
          <label>🗂️ DJI Project UUID</label>
          <input type="text" id="DJI_X_PROJECT_UUID" value="${cfg.DJI_X_PROJECT_UUID}"/>
          <span class="hint">Pre-filled from your FH2 settings ✓</span>
        </div>

        <div class="field">
          <label>⚡ Workflow UUID</label>
          <input type="text" id="DJI_WORKFLOW_UUID" value="${cfg.DJI_WORKFLOW_UUID}"/>
          <span class="hint">Pre-filled from your FH2 settings ✓</span>
        </div>

        <div class="field">
          <label>👤 Creator ID</label>
          <input type="text" id="DJI_CREATOR_ID" value="${cfg.DJI_CREATOR_ID}"/>
        </div>

        <div class="field">
          <label>🌍 DJI FH2 Server Region</label>
          <select id="DJI_FH2_ENDPOINT">
            <option value="https://es-flight-api-us.djigate.com" ${cfg.DJI_FH2_ENDPOINT.includes('us') ? 'selected' : ''}>🌎 International (US)</option>
            <option value="https://es-flight-api-eu.djigate.com" ${cfg.DJI_FH2_ENDPOINT.includes('eu') ? 'selected' : ''}>🌍 European (EU)</option>
          </select>
        </div>

        <div class="section-divider fullwidth"></div>
        <div class="fullwidth" style="color:#f6ad55;font-size:13px;font-weight:700;margin-bottom:4px">── Trigger Settings ──</div>

        <div class="field">
          <label>📊 Auto-Dispatch Level Threshold</label>
          <select id="AUTO_TRIGGER_LEVEL">
            <option value="1" ${cfg.AUTO_TRIGGER_LEVEL===1?'selected':''}>1 — All alerts (dispatch everything)</option>
            <option value="2" ${cfg.AUTO_TRIGGER_LEVEL===2?'selected':''}>2 — Low and above</option>
            <option value="3" ${cfg.AUTO_TRIGGER_LEVEL===3?'selected':''}>3 — Medium and above (recommended)</option>
            <option value="4" ${cfg.AUTO_TRIGGER_LEVEL===4?'selected':''}>4 — High and above</option>
            <option value="5" ${cfg.AUTO_TRIGGER_LEVEL===5?'selected':''}>5 — Critical only</option>
          </select>
          <span class="hint">Alerts below this level will be logged but won't dispatch a drone</span>
        </div>

        <div class="field">
          <label>📍 Default GPS — Latitude</label>
          <input type="number" step="any" id="DEFAULT_LATITUDE" value="${cfg.DEFAULT_LATITUDE}"/>
          <span class="hint">Used when Scylla alert has no GPS coordinates</span>
        </div>

        <div class="field">
          <label>📍 Default GPS — Longitude</label>
          <input type="number" step="any" id="DEFAULT_LONGITUDE" value="${cfg.DEFAULT_LONGITUDE}"/>
        </div>

        <div class="field fullwidth">
          <label>🔐 New Admin Password (optional — leave blank to keep current)</label>
          <input type="password" id="ADMIN_PASSWORD" placeholder="Leave blank to keep current password"/>
        </div>

      </div>

      <div id="msg"></div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary" onclick="saveConfig()">💾 Save & Apply Config</button>
        <button type="button" class="btn btn-green"   onclick="testHealth()">🩺 Test Health</button>
        <button type="button" class="btn btn-red"     onclick="testDispatch()">🚁 Dispatch Drone Now (Test)</button>
        <button type="button" class="btn" style="background:#2d3748;color:#a0aec0" onclick="loadLogs()">📋 Refresh Logs</button>
      </div>
    </form>
  </div>

  <!-- Live Logs -->
  <div class="card">
    <h2>📋 Live Activity Log <span style="font-size:12px;font-weight:400;color:#718096">(last 50 events)</span></h2>
    <div class="log-box" id="logBox">Loading logs...</div>
  </div>

</div>

<script>
async function saveConfig() {
  const fields = ['SCYLLA_PUSH_TOKEN','DJI_X_USER_TOKEN','DJI_X_PROJECT_UUID',
                  'DJI_WORKFLOW_UUID','DJI_CREATOR_ID','DJI_FH2_ENDPOINT',
                  'AUTO_TRIGGER_LEVEL','DEFAULT_LATITUDE','DEFAULT_LONGITUDE','ADMIN_PASSWORD'];
  const body = { adminPassword: document.getElementById('adminPassword').value };
  fields.forEach(f => { body[f] = document.getElementById(f).value; });
  try {
    const r = await fetch('/admin/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    showMsg(r.ok ? 'ok' : 'err', r.ok ? '✅ Config saved! Updated: ' + d.updated.join(', ') : '❌ ' + (d.error || 'Error'));
    if (r.ok) setTimeout(() => location.reload(), 1500);
  } catch(e) { showMsg('err', '❌ Network error: ' + e.message); }
}
async function testHealth() {
  try {
    const r = await fetch('/health');
    const d = await r.json();
    const all = Object.values(d.configured).every(Boolean);
    showMsg(all ? 'ok' : 'err', all ? '✅ Bridge healthy! All tokens configured.' : '⚠️ Bridge running but some tokens missing: ' + JSON.stringify(d.configured));
  } catch(e) { showMsg('err', '❌ ' + e.message); }
}
async function testDispatch() {
  const lat = ${cfg.DEFAULT_LATITUDE};
  const lng = ${cfg.DEFAULT_LONGITUDE};
  try {
    const r = await fetch('/test/trigger', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({latitude:lat,longitude:lng,level:5,description:'Admin panel test dispatch'}) });
    const d = await r.json();
    showMsg(r.ok ? 'ok' : 'err', r.ok ? '🚁 Dispatch sent! DJI response: ' + JSON.stringify(d.djiResponse) : '❌ ' + JSON.stringify(d));
  } catch(e) { showMsg('err', '❌ ' + e.message); }
}
async function loadLogs() {
  try {
    const r = await fetch('/logs');
    const d = await r.json();
    const box = document.getElementById('logBox');
    if (!d.logs.length) { box.innerHTML = '<span style="color:#718096">No activity yet</span>'; return; }
    box.innerHTML = d.logs.map(l =>
      '<div class="log-entry"><span class="time">' + l.time.replace('T',' ').slice(0,19) + '</span> ' +
      '<span class="type-' + l.type + '">[' + l.type + ']</span> ' + l.msg + '</div>'
    ).join('');
  } catch(e) {}
}
function showMsg(type, text) {
  const el = document.getElementById('msg');
  el.className = type; el.textContent = text; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 6000);
}
loadLogs();
setInterval(loadLogs, 8000);
</script>
</body>
</html>`);
});

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   Scylla.ai  →  DJI FlightHub 2  Bridge  v1.1   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`🚀 Running on port: ${PORT}`);
  console.log(`🔧 Admin panel   : http://localhost:${PORT}/admin`);
  console.log(`📡 Webhook       : POST http://localhost:${PORT}/webhook/scylla`);
  console.log(`🩺 Health        : GET  http://localhost:${PORT}/health\n`);
});

module.exports = app;
