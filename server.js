'use strict';
require('dotenv').config();

const express    = require('express');
const axios      = require('axios');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { transform, buildDJIHeaders } = require('./transformer');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── Config Store (in-memory, persisted to config.json) ───────────────────────
const fs   = require('fs');
const path = require('path');
const CFG_FILE = path.join(__dirname, 'config.json');

// Default empty config — admin fills everything via UI
const DEFAULT_CFG = {
  // DJI FlightHub 2
  DJI_FH2_ENDPOINT:   '',
  DJI_FH2_PATH:       '/openapi/v0.1/workflow',
  DJI_X_USER_TOKEN:   '',
  DJI_X_PROJECT_UUID: '',
  DJI_WORKFLOW_UUID:  '',
  DJI_CREATOR_ID:     '',
  // Source Platform (Scylla / any)
  SCYLLA_PUSH_TOKEN:  '',
  SOURCE_PLATFORM:    'scylla',
  // Bridge Defaults
  PORT:               '4000',
  ADMIN_PASSWORD:     'admin1234',
  AUTO_TRIGGER_LEVEL: '3',
  DEFAULT_LATITUDE:   '',
  DEFAULT_LONGITUDE:  '',
};

function loadCfg() {
  // Priority: config.json → env vars → defaults
  let saved = {};
  try {
    if (fs.existsSync(CFG_FILE)) {
      saved = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
    }
  } catch(e) {}
  const merged = { ...DEFAULT_CFG };
  // Apply env vars
  for (const key of Object.keys(DEFAULT_CFG)) {
    if (process.env[key]) merged[key] = process.env[key];
  }
  // Apply saved config (highest priority)
  for (const key of Object.keys(saved)) {
    if (saved[key] !== '') merged[key] = saved[key];
  }
  return merged;
}

function saveCfg(updates) {
  let existing = {};
  try {
    if (fs.existsSync(CFG_FILE)) existing = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
  } catch(e) {}
  const merged = { ...existing, ...updates };
  fs.writeFileSync(CFG_FILE, JSON.stringify(merged, null, 2));
  return merged;
}

let cfg = loadCfg();

// ── Logs ─────────────────────────────────────────────────────────────────────
const logs = [];
function addLog(type, msg, data) {
  const entry = { time: new Date().toISOString(), type, msg, data: data || null };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log(`[${type}] ${msg}`, data ? JSON.stringify(data).slice(0,120) : '');
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const webhookLimiter = rateLimit({ windowMs: 60_000, max: 60 });

// ── Helper: is bridge configured? ────────────────────────────────────────────
function isConfigured() {
  return !!(cfg.DJI_FH2_ENDPOINT && cfg.DJI_X_USER_TOKEN && cfg.DJI_X_PROJECT_UUID &&
            cfg.DJI_WORKFLOW_UUID && cfg.SCYLLA_PUSH_TOKEN);
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:     'ok',
    service:    'Universal DJI FH2 Bridge v2.0',
    uptime:     Math.floor(process.uptime()) + 's',
    configured: isConfigured(),
    setup_url:  `${req.protocol}://${req.get('host')}/admin`,
    fields: {
      DJI_FH2_ENDPOINT:   !!cfg.DJI_FH2_ENDPOINT,
      DJI_X_USER_TOKEN:   !!cfg.DJI_X_USER_TOKEN,
      DJI_X_PROJECT_UUID: !!cfg.DJI_X_PROJECT_UUID,
      DJI_WORKFLOW_UUID:  !!cfg.DJI_WORKFLOW_UUID,
      DJI_CREATOR_ID:     !!cfg.DJI_CREATOR_ID,
      SCYLLA_PUSH_TOKEN:  !!cfg.SCYLLA_PUSH_TOKEN,
    }
  });
});

// ── Config API ────────────────────────────────────────────────────────────────
app.get('/config', (req, res) => {
  // Return safe config (no secrets)
  res.json({
    DJI_FH2_ENDPOINT:   cfg.DJI_FH2_ENDPOINT,
    DJI_FH2_PATH:       cfg.DJI_FH2_PATH,
    DJI_X_PROJECT_UUID: cfg.DJI_X_PROJECT_UUID,
    DJI_WORKFLOW_UUID:  cfg.DJI_WORKFLOW_UUID,
    DJI_CREATOR_ID:     cfg.DJI_CREATOR_ID,
    SOURCE_PLATFORM:    cfg.SOURCE_PLATFORM,
    AUTO_TRIGGER_LEVEL: cfg.AUTO_TRIGGER_LEVEL,
    DEFAULT_LATITUDE:   cfg.DEFAULT_LATITUDE,
    DEFAULT_LONGITUDE:  cfg.DEFAULT_LONGITUDE,
    configured:         isConfigured(),
  });
});

// ── Webhook (main entry point) ────────────────────────────────────────────────
app.post('/webhook/scylla', webhookLimiter, async (req, res) => {
  // Auth check
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (cfg.SCYLLA_PUSH_TOKEN && token !== cfg.SCYLLA_PUSH_TOKEN) {
    addLog('WARN', 'Rejected — bad token', { received: token.slice(0,8) });
    return res.status(401).json({ error: 'Invalid push token' });
  }
  if (!isConfigured()) {
    addLog('WARN', 'Bridge not configured yet');
    return res.status(503).json({
      error:    'Bridge not configured',
      setup:    'Please complete setup at /admin',
      missing:  Object.entries({
        DJI_FH2_ENDPOINT:   cfg.DJI_FH2_ENDPOINT,
        DJI_X_USER_TOKEN:   cfg.DJI_X_USER_TOKEN,
        DJI_X_PROJECT_UUID: cfg.DJI_X_PROJECT_UUID,
        DJI_WORKFLOW_UUID:  cfg.DJI_WORKFLOW_UUID,
        SCYLLA_PUSH_TOKEN:  cfg.SCYLLA_PUSH_TOKEN,
      }).filter(([,v]) => !v).map(([k]) => k)
    });
  }

  const payload = req.body;
  const { djiBody, level, latitude, longitude, alertLabel } = transform(payload, cfg);

  addLog('IN', `Alert received — level ${level}`, {
    alertLabel,
    camera: payload.camera_id || payload.camera_name || 'N/A',
    coordinates: { lat: latitude, lng: longitude }
  });

  try {
    const url  = `${cfg.DJI_FH2_ENDPOINT}${cfg.DJI_FH2_PATH}`;
    const hdrs = buildDJIHeaders(cfg);
    const resp = await axios.post(url, djiBody, { headers: hdrs, timeout: 10000 });

    addLog('OUT', `DJI dispatch OK — level ${level}`, {
      djiBody,
      djiResp: resp.data
    });

    return res.json({
      status:      'dispatched',
      level,
      djiBody,
      djiResponse: resp.data
    });
  } catch(err) {
    const errData = {
      message: err.message,
      status:  err.response?.status,
      data:    err.response?.data
    };
    addLog('ERR', 'DJI dispatch failed', errData);
    return res.status(502).json({ error: 'DJI dispatch failed', details: errData });
  }
});

// Also accept generic webhook path
app.post('/webhook', webhookLimiter, (req, res, next) => {
  req.url = '/webhook/scylla';
  next('route');
});

// ── Logs API ──────────────────────────────────────────────────────────────────
app.get('/logs', (req, res) => {
  res.json({ count: logs.length, logs: logs.slice(0, 100) });
});

// ── Admin API: Save Config ─────────────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  const { password, ...updates } = req.body;
  if (password !== cfg.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong admin password' });
  }
  // Only save known fields
  const allowed = Object.keys(DEFAULT_CFG);
  const clean   = {};
  for (const k of allowed) {
    if (updates[k] !== undefined && updates[k] !== '') clean[k] = updates[k];
  }
  saveCfg(clean);
  cfg = loadCfg();
  addLog('CFG', 'Config updated via admin', { fields: Object.keys(clean) });
  return res.json({ success: true, configured: isConfigured() });
});

// ── Admin: Test DJI Connection ────────────────────────────────────────────────
app.post('/api/test-dji', async (req, res) => {
  const { password } = req.body;
  if (password !== cfg.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  if (!cfg.DJI_FH2_ENDPOINT || !cfg.DJI_X_USER_TOKEN) {
    return res.status(400).json({ error: 'DJI endpoint and token required first' });
  }
  try {
    const url  = `${cfg.DJI_FH2_ENDPOINT}${cfg.DJI_FH2_PATH}`;
    const hdrs = buildDJIHeaders(cfg);
    const body = {
      workflow_uuid: cfg.DJI_WORKFLOW_UUID,
      trigger_type:  0,
      name:          `bridge-test-${Date.now()}`,
      params: {
        creator:   cfg.DJI_CREATOR_ID,
        latitude:  parseFloat(cfg.DEFAULT_LATITUDE)  || 25.12489,
        longitude: parseFloat(cfg.DEFAULT_LONGITUDE) || 55.38150,
        level:     parseInt(cfg.AUTO_TRIGGER_LEVEL)  || 3,
        desc:      'Bridge connection test'
      }
    };
    const resp = await axios.post(url, body, { headers: hdrs, timeout: 10000 });
    addLog('TEST', 'DJI test dispatch', { resp: resp.data });
    return res.json({ success: true, djiResponse: resp.data });
  } catch(err) {
    return res.status(502).json({
      success: false,
      error:   err.message,
      status:  err.response?.status,
      data:    err.response?.data
    });
  }
});

// ── Admin: Test Webhook ────────────────────────────────────────────────────────
app.post('/api/test-webhook', async (req, res) => {
  const { password } = req.body;
  if (password !== cfg.ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  // Simulate a Scylla alert
  try {
    const host     = `${req.protocol}://${req.get('host')}`;
    const testBody = {
      alert:       { label: 'intrusion', severity: 3 },
      camera_id:   'test-cam-01',
      camera_name: 'Test Camera',
      location:    { latitude: parseFloat(cfg.DEFAULT_LATITUDE) || 25.12489, longitude: parseFloat(cfg.DEFAULT_LONGITUDE) || 55.38150 },
      description: 'Bridge self-test alert',
      timestamp:   new Date().toISOString()
    };
    const resp = await axios.post(`${host}/webhook/scylla`, testBody, {
      headers: { 'Authorization': `Bearer ${cfg.SCYLLA_PUSH_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return res.json({ success: true, result: resp.data });
  } catch(err) {
    return res.status(502).json({
      success: false,
      error:   err.message,
      data:    err.response?.data
    });
  }
});

// ── Admin UI ──────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const configured = isConfigured();
  const statusColor = configured ? '#48bb78' : '#f6ad55';
  const statusText  = configured ? '✅ CONFIGURED & READY' : '⚠️ SETUP REQUIRED';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>DJI FH2 Bridge — Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e2e8f0;min-height:100vh}
.topbar{background:linear-gradient(135deg,#1a1f2e,#2d3748);padding:16px 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #2d3748}
.topbar h1{font-size:18px;font-weight:700;color:#63b3ed}
.topbar h1 span{color:#68d391;font-size:13px;margin-left:8px}
.status-bar{background:#1a1f2e;padding:10px 24px;border-bottom:1px solid #2d3748;display:flex;align-items:center;gap:12px}
.status-dot{width:10px;height:10px;border-radius:50%;background:${statusColor};box-shadow:0 0 6px ${statusColor}}
.status-text{font-size:13px;font-weight:600;color:${statusColor}}
.container{max-width:900px;margin:0 auto;padding:24px}
.card{background:#1a1f2e;border-radius:12px;padding:24px;margin-bottom:20px;border:1px solid #2d3748}
.card h2{font-size:15px;font-weight:700;color:#90cdf4;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.card h2 .badge{font-size:11px;background:#2d3748;padding:2px 8px;border-radius:20px;color:#a0aec0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:12px;color:#a0aec0;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.field input,.field select{background:#0f1117;border:1px solid #4a5568;border-radius:8px;padding:10px 12px;color:#e2e8f0;font-size:13px;width:100%;transition:border .2s}
.field input:focus,.field select:focus{outline:none;border-color:#63b3ed}
.field input.filled{border-color:#48bb78}
.field input.empty{border-color:#fc8181}
.hint{font-size:11px;color:#718096;margin-top:3px}
.full{grid-column:1/-1}
.btn-row{display:flex;gap:10px;margin-top:6px;flex-wrap:wrap}
.btn{padding:10px 20px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:600;transition:all .2s}
.btn-primary{background:#3182ce;color:#fff}.btn-primary:hover{background:#2b6cb0}
.btn-success{background:#38a169;color:#fff}.btn-success:hover{background:#2f855a}
.btn-warning{background:#d69e2e;color:#fff}.btn-warning:hover{background:#b7791f}
.btn-danger{background:#e53e3e;color:#fff}.btn-danger:hover{background:#c53030}
.btn-gray{background:#2d3748;color:#e2e8f0}.btn-gray:hover{background:#4a5568}
#msg{margin-top:12px;padding:10px 14px;border-radius:8px;font-size:13px;display:none}
#msg.ok{display:block;background:#1c4532;color:#68d391;border:1px solid #2f855a}
#msg.err{display:block;background:#742a2a;color:#fc8181;border:1px solid #c53030}
.url-box{background:#0f1117;border:1px solid #2d3748;border-radius:6px;padding:8px 12px;font-family:monospace;font-size:12px;color:#63b3ed;word-break:break-all;margin-top:6px}
.log-box{background:#0f1117;border-radius:8px;padding:12px;max-height:280px;overflow-y:auto;font-family:monospace;font-size:11px}
.log-IN{color:#68d391}.log-OUT{color:#63b3ed}.log-ERR{color:#fc8181}.log-WARN{color:#f6ad55}.log-CFG{color:#b794f4}.log-TEST{color:#76e4f7}
.section-title{font-size:13px;color:#718096;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #2d3748}
.setup-steps{counter-reset:step}
.step{display:flex;gap:12px;margin-bottom:14px;align-items:flex-start}
.step-num{background:#3182ce;color:#fff;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;margin-top:2px}
.step-content{flex:1}
.step-title{font-size:13px;font-weight:600;color:#e2e8f0}
.step-desc{font-size:12px;color:#718096;margin-top:2px}
</style>
</head>
<body>
<div class="topbar">
  <h1>🚁 DJI FlightHub 2 Bridge <span>v2.0 Universal</span></h1>
  <div style="font-size:12px;color:#718096">Admin Panel</div>
</div>
<div class="status-bar">
  <div class="status-dot"></div>
  <div class="status-text">${statusText}</div>
  <div style="margin-left:auto;font-size:12px;color:#718096">Port: ${PORT}</div>
</div>

<div class="container">

  ${!configured ? `
  <div class="card" style="border-color:#d69e2e">
    <h2>🚀 Quick Setup Guide</h2>
    <div class="setup-steps">
      <div class="step"><div class="step-num">1</div><div class="step-content"><div class="step-title">Get DJI FH2 Endpoint</div><div class="step-desc">Your FH2 server URL e.g. https://83.111.79.70:30812 or https://es-flight-api-us.djigate.com</div></div></div>
      <div class="step"><div class="step-num">2</div><div class="step-content"><div class="step-title">Get Organisation Key</div><div class="step-desc">FH2 Dashboard → My Organization → Settings → FlightHub Sync → Copy Organization Key</div></div></div>
      <div class="step"><div class="step-num">3</div><div class="step-content"><div class="step-title">Get Project UUID & Workflow UUID</div><div class="step-desc">FH2 Dashboard → Your Project → Automation → Triggered Workflow → Select workflow → Copy IDs</div></div></div>
      <div class="step"><div class="step-num">4</div><div class="step-content"><div class="step-title">Set Scylla Push Token</div><div class="step-desc">Choose any secret password — you'll enter same value in Scylla webhook config</div></div></div>
      <div class="step"><div class="step-num">5</div><div class="step-content"><div class="step-title">Fill form below → Save → Test</div><div class="step-desc">Click "Test DJI Connection" to verify before going live</div></div></div>
    </div>
  </div>` : ''}

  <!-- CONFIGURATION FORM -->
  <div class="card">
    <h2>⚙️ Configuration <span class="badge">All fields saved permanently to disk</span></h2>

    <div class="section-title">🔒 Admin Access</div>
    <div class="grid" style="margin-bottom:16px">
      <div class="field">
        <label>Admin Password</label>
        <input type="password" id="ADMIN_PASSWORD" value="${cfg.ADMIN_PASSWORD}" placeholder="admin1234"/>
        <div class="hint">Password to access this admin panel</div>
      </div>
      <div class="field">
        <label>Current Password (required to save)</label>
        <input type="password" id="currentPassword" placeholder="Enter current admin password"/>
      </div>
    </div>

    <div class="section-title">🌐 DJI FlightHub 2 Server</div>
    <div class="grid" style="margin-bottom:16px">
      <div class="field full">
        <label>DJI FH2 Endpoint URL ⭐</label>
        <input type="text" id="DJI_FH2_ENDPOINT" value="${cfg.DJI_FH2_ENDPOINT}"
          placeholder="e.g. https://83.111.79.70:30812  OR  https://es-flight-api-us.djigate.com"
          class="${cfg.DJI_FH2_ENDPOINT ? 'filled' : 'empty'}"/>
        <div class="hint">Your FH2 server IP/domain + port. On-prem: use your server IP. Cloud: use djigate.com URL</div>
      </div>
      <div class="field">
        <label>API Path</label>
        <input type="text" id="DJI_FH2_PATH" value="${cfg.DJI_FH2_PATH || '/openapi/v0.1/workflow'}"
          placeholder="/openapi/v0.1/workflow"/>
        <div class="hint">Usually /openapi/v0.1/workflow — don't change unless DJI says so</div>
      </div>
      <div class="field">
        <label>Source Platform</label>
        <select id="SOURCE_PLATFORM">
          <option value="scylla" ${cfg.SOURCE_PLATFORM==='scylla'?'selected':''}>Scylla.ai</option>
          <option value="generic" ${cfg.SOURCE_PLATFORM==='generic'?'selected':''}>Generic / Other</option>
          <option value="avigilon" ${cfg.SOURCE_PLATFORM==='avigilon'?'selected':''}>Avigilon</option>
          <option value="milestone" ${cfg.SOURCE_PLATFORM==='milestone'?'selected':''}>Milestone</option>
        </select>
        <div class="hint">Your camera AI platform sending alerts</div>
      </div>
    </div>

    <div class="section-title">🔑 DJI Authentication</div>
    <div class="grid" style="margin-bottom:16px">
      <div class="field full">
        <label>DJI Organisation Key (X-User-Token) ⭐</label>
        <input type="password" id="DJI_X_USER_TOKEN" value="${cfg.DJI_X_USER_TOKEN}"
          placeholder="eyJhbGci... (JWT token from FlightHub Sync)"
          class="${cfg.DJI_X_USER_TOKEN ? 'filled' : 'empty'}"/>
        <div class="hint">FH2 → My Organization → Settings → FlightHub Sync → Organization Key</div>
      </div>
      <div class="field">
        <label>Project UUID ⭐</label>
        <input type="text" id="DJI_X_PROJECT_UUID" value="${cfg.DJI_X_PROJECT_UUID}"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          class="${cfg.DJI_X_PROJECT_UUID ? 'filled' : 'empty'}"/>
        <div class="hint">From FH2 project URL or Auto Trigger page</div>
      </div>
      <div class="field">
        <label>Workflow UUID ⭐</label>
        <input type="text" id="DJI_WORKFLOW_UUID" value="${cfg.DJI_WORKFLOW_UUID}"
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          class="${cfg.DJI_WORKFLOW_UUID ? 'filled' : 'empty'}"/>
        <div class="hint">From FH2 → Automation → Triggered Workflow → workflow_uuid</div>
      </div>
      <div class="field">
        <label>Creator ID</label>
        <input type="text" id="DJI_CREATOR_ID" value="${cfg.DJI_CREATOR_ID}"
          placeholder="e.g. 1847118310561013760"
          class="${cfg.DJI_CREATOR_ID ? 'filled' : 'empty'}"/>
        <div class="hint">User ID from JWT token (auto-extracted if left blank)</div>
      </div>
    </div>

    <div class="section-title">📡 Source Platform (Scylla / Camera AI)</div>
    <div class="grid" style="margin-bottom:16px">
      <div class="field">
        <label>Push Token (Bearer) ⭐</label>
        <input type="text" id="SCYLLA_PUSH_TOKEN" value="${cfg.SCYLLA_PUSH_TOKEN}"
          placeholder="e.g. mysecrettoken123"
          class="${cfg.SCYLLA_PUSH_TOKEN ? 'filled' : 'empty'}"/>
        <div class="hint">Secret password — same value goes in Scylla webhook Bearer token field</div>
      </div>
    </div>

    <div class="section-title">📍 Default Settings</div>
    <div class="grid" style="margin-bottom:16px">
      <div class="field">
        <label>Default Latitude</label>
        <input type="text" id="DEFAULT_LATITUDE" value="${cfg.DEFAULT_LATITUDE}"
          placeholder="e.g. 25.12489"/>
        <div class="hint">Used when alert has no GPS coords</div>
      </div>
      <div class="field">
        <label>Default Longitude</label>
        <input type="text" id="DEFAULT_LONGITUDE" value="${cfg.DEFAULT_LONGITUDE}"
          placeholder="e.g. 55.38150"/>
        <div class="hint">Used when alert has no GPS coords</div>
      </div>
      <div class="field">
        <label>Default Alert Level (1-5)</label>
        <select id="AUTO_TRIGGER_LEVEL">
          <option value="1" ${cfg.AUTO_TRIGGER_LEVEL==='1'?'selected':''}>1 - Very Low</option>
          <option value="2" ${cfg.AUTO_TRIGGER_LEVEL==='2'?'selected':''}>2 - Low</option>
          <option value="3" ${cfg.AUTO_TRIGGER_LEVEL==='3'?'selected':''}>3 - Medium</option>
          <option value="4" ${cfg.AUTO_TRIGGER_LEVEL==='4'?'selected':''}>4 - High</option>
          <option value="5" ${cfg.AUTO_TRIGGER_LEVEL==='5'?'selected':''}>5 - Critical</option>
        </select>
        <div class="hint">Fallback level when alert type can't be mapped</div>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn btn-primary" onclick="saveConfig()">💾 Save Configuration</button>
      <button class="btn btn-success" onclick="testDJI()">🔌 Test DJI Connection</button>
      <button class="btn btn-warning" onclick="testWebhook()">📡 Test Full Webhook</button>
      <button class="btn btn-gray" onclick="loadLogs()">🔄 Refresh Logs</button>
    </div>
    <div id="msg"></div>
  </div>

  <!-- WEBHOOK INFO -->
  <div class="card">
    <h2>📡 Webhook Endpoints</h2>
    <div class="grid">
      <div class="field">
        <label>Scylla / Camera AI Webhook URL</label>
        <div class="url-box" id="webhookUrl">Loading...</div>
        <div class="hint">Paste this URL in your camera AI platform webhook config</div>
      </div>
      <div class="field">
        <label>Auth Type in Scylla</label>
        <div class="url-box">Bearer Token → use your Push Token above</div>
      </div>
      <div class="field">
        <label>Health Check</label>
        <div class="url-box" id="healthUrl">Loading...</div>
      </div>
      <div class="field">
        <label>Logs</label>
        <div class="url-box" id="logsUrl">Loading...</div>
      </div>
    </div>
  </div>

  <!-- LIVE LOGS -->
  <div class="card">
    <h2>📋 Live Logs <span class="badge">Last 100 events</span></h2>
    <div class="log-box" id="logBox">Loading...</div>
  </div>

</div>

<script>
const BASE = window.location.origin;
document.getElementById('webhookUrl').textContent = BASE + '/webhook/scylla';
document.getElementById('healthUrl').textContent  = BASE + '/health';
document.getElementById('logsUrl').textContent    = BASE + '/logs';

function showMsg(text, isOk) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = isOk ? 'ok' : 'err';
  setTimeout(() => el.className = '', 8000);
}

async function saveConfig() {
  const password = document.getElementById('currentPassword').value;
  if (!password) { showMsg('❌ Enter current admin password first', false); return; }
  const fields = ['ADMIN_PASSWORD','DJI_FH2_ENDPOINT','DJI_FH2_PATH','DJI_X_USER_TOKEN',
    'DJI_X_PROJECT_UUID','DJI_WORKFLOW_UUID','DJI_CREATOR_ID','SCYLLA_PUSH_TOKEN',
    'SOURCE_PLATFORM','AUTO_TRIGGER_LEVEL','DEFAULT_LATITUDE','DEFAULT_LONGITUDE'];
  const body = { password };
  for (const f of fields) {
    const el = document.getElementById(f);
    if (el && el.value) body[f] = el.value;
  }
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (d.success) {
      showMsg('✅ Configuration saved! Bridge is ' + (d.configured ? 'READY' : 'still needs more fields'), true);
      setTimeout(() => location.reload(), 1500);
    } else {
      showMsg('❌ ' + (d.error || 'Save failed'), false);
    }
  } catch(e) { showMsg('❌ Error: ' + e.message, false); }
}

async function testDJI() {
  const password = document.getElementById('currentPassword').value;
  if (!password) { showMsg('❌ Enter admin password first', false); return; }
  showMsg('🔄 Testing DJI connection...', true);
  try {
    const r = await fetch('/api/test-dji', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const d = await r.json();
    if (d.success) {
      showMsg('✅ DJI Connection OK! Response code: ' + d.djiResponse?.code + ' — Drone dispatched!', true);
    } else {
      showMsg('❌ DJI Error: ' + JSON.stringify(d.data || d.error), false);
    }
  } catch(e) { showMsg('❌ ' + e.message, false); }
}

async function testWebhook() {
  const password = document.getElementById('currentPassword').value;
  if (!password) { showMsg('❌ Enter admin password first', false); return; }
  showMsg('🔄 Sending test alert through full pipeline...', true);
  try {
    const r = await fetch('/api/test-webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const d = await r.json();
    if (d.success && d.result?.djiResponse?.code === 0) {
      showMsg('✅ Full pipeline OK! Alert → Bridge → DJI → Drone dispatched! UUID: ' + d.result.djiResponse?.data?.uuid, true);
    } else {
      showMsg('❌ Pipeline error: ' + JSON.stringify(d.result?.djiResponse || d.error || d), false);
    }
  } catch(e) { showMsg('❌ ' + e.message, false); }
}

function loadLogs() {
  fetch('/logs').then(r => r.json()).then(d => {
    const box = document.getElementById('logBox');
    if (!d.logs || !d.logs.length) { box.innerHTML = '<span style="color:#718096">No logs yet</span>'; return; }
    box.innerHTML = d.logs.map(l => {
      const t    = new Date(l.time).toLocaleTimeString();
      const data = l.data ? ' — ' + JSON.stringify(l.data).slice(0,120) : '';
      return \`<div class="log-\${l.type}">[\${t}] [\${l.type}] \${l.msg}\${data}</div>\`;
    }).join('');
  });
}

// Auto-color fields
document.querySelectorAll('input[type=text], input[type=password]').forEach(el => {
  el.addEventListener('input', () => {
    el.className = el.value ? 'filled' : 'empty';
  });
});

loadLogs();
setInterval(loadLogs, 8000);
</script>
</body>
</html>`);
});

// ── Keep-Alive ────────────────────────────────────────────────────────────────
(function startKeepAlive() {
  const INTERVAL = 14 * 60 * 1000;
  function ping() {
    const SELF = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const mod  = SELF.startsWith('https') ? require('https') : require('http');
    mod.get(`${SELF}/health`, r => {
      console.log(`[keep-alive] ✅ ${new Date().toISOString()} (${r.statusCode})`);
    }).on('error', e => console.log(`[keep-alive] ⚠️ ${e.message}`));
  }
  setTimeout(() => { ping(); setInterval(ping, INTERVAL); }, 3 * 60 * 1000);
})();

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Universal DJI FlightHub 2 Bridge  v2.0          ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`🚀 Port     : ${PORT}`);
  console.log(`🔧 Admin    : http://localhost:${PORT}/admin`);
  console.log(`📡 Webhook  : POST http://localhost:${PORT}/webhook/scylla`);
  console.log(`🩺 Health   : GET  http://localhost:${PORT}/health`);
  console.log(`📋 Config   : ${fs.existsSync(CFG_FILE) ? '✅ config.json found' : '⚠️  No config yet — open /admin to setup'}\n`);
});

module.exports = app;
