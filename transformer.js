'use strict';

// ── transformer.js — Universal Alert Payload → DJI FH2 Body ──────────────────
// Supports: Scylla.ai, Avigilon, Milestone, Genetec, generic webhook

const ALERT_LEVEL_MAP = {
  // Level 5 — Critical
  weapon: 5, gun: 5, knife: 5, explosive: 5, bomb: 5,
  fire: 5, smoke: 5, explosion: 5, shootng: 5, armed: 5,
  // Level 4 — High
  fight: 4, intrusion: 4, break_in: 4, assault: 4, aggression: 4,
  // Level 3 — Medium
  trespassing: 3, crowd: 3, suspicious: 3, anomaly: 3, threat: 3,
  // Level 2 — Low
  loitering: 2, perimeter: 2, motion: 2, detected: 2,
};

function mapAlertLevel(payload, defaultLevel) {
  const def = parseInt(defaultLevel) || 3;
  // Direct level field
  if (payload.level && typeof payload.level === 'number') return payload.level;
  if (payload.severity && typeof payload.severity === 'number') return payload.severity;
  // Nested alert object
  if (payload.alert) {
    if (payload.alert.severity) return parseInt(payload.alert.severity);
    if (payload.alert.level)    return parseInt(payload.alert.level);
    if (payload.alert.label) {
      const key = payload.alert.label.toLowerCase();
      for (const [k, v] of Object.entries(ALERT_LEVEL_MAP)) {
        if (key.includes(k)) return v;
      }
    }
  }
  // String severity mapping
  const sev = (payload.severity || payload.priority || '').toString().toLowerCase();
  if (sev === 'critical' || sev === 'high')   return 5;
  if (sev === 'medium'   || sev === 'normal') return 3;
  if (sev === 'low')                          return 2;
  // Alert type text matching
  const alertText = (payload.type || payload.alert_type || payload.event || '').toLowerCase();
  for (const [k, v] of Object.entries(ALERT_LEVEL_MAP)) {
    if (alertText.includes(k)) return v;
  }
  return def;
}

function extractCoordinates(payload, defLat, defLng) {
  const lat = parseFloat(defLat) || 25.12489;
  const lng = parseFloat(defLng) || 55.38150;
  // Various coordinate formats
  if (payload.location) {
    return {
      latitude:  parseFloat(payload.location.latitude  || payload.location.lat  || lat),
      longitude: parseFloat(payload.location.longitude || payload.location.lng  || payload.location.lon || lng)
    };
  }
  if (payload.gps) {
    return {
      latitude:  parseFloat(payload.gps.lat || payload.gps.latitude  || lat),
      longitude: parseFloat(payload.gps.lng || payload.gps.longitude || lng)
    };
  }
  if (payload.coordinates) {
    return {
      latitude:  parseFloat(payload.coordinates.lat || payload.coordinates.latitude  || lat),
      longitude: parseFloat(payload.coordinates.lng || payload.coordinates.longitude || lng)
    };
  }
  if (payload.latitude  !== undefined) return { latitude: parseFloat(payload.latitude),  longitude: parseFloat(payload.longitude || lng) };
  if (payload.lat       !== undefined) return { latitude: parseFloat(payload.lat),       longitude: parseFloat(payload.lng || lng) };
  return { latitude: lat, longitude: lng };
}

function extractDescription(payload) {
  return payload.description
    || payload.desc
    || payload.message
    || payload.details
    || (payload.alert && payload.alert.label)
    || (payload.alert && payload.alert.description)
    || payload.type
    || payload.event
    || `Alert from ${payload.camera_name || payload.camera_id || payload.source || 'camera'}`;
}

function extractAlertLabel(payload) {
  return (payload.alert && payload.alert.label)
    || payload.type
    || payload.alert_type
    || payload.event
    || 'alert';
}

function transform(incomingPayload, cfg) {
  const level                    = mapAlertLevel(incomingPayload, cfg.AUTO_TRIGGER_LEVEL);
  const { latitude, longitude }  = extractCoordinates(incomingPayload, cfg.DEFAULT_LATITUDE, cfg.DEFAULT_LONGITUDE);
  const alertLabel               = extractAlertLabel(incomingPayload);
  const desc                     = extractDescription(incomingPayload);
  const ts                       = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

  const djiBody = {
    workflow_uuid: cfg.DJI_WORKFLOW_UUID,
    trigger_type:  0,
    name:          `${alertLabel}-${ts}`,
    params: {
      creator:   cfg.DJI_CREATOR_ID,
      latitude,
      longitude,
      level,
      desc
    }
  };
  return { djiBody, level, latitude, longitude, alertLabel };
}

function buildDJIHeaders(cfg) {
  return {
    'Content-Type':   'application/json',
    'X-User-Token':   cfg.DJI_X_USER_TOKEN  || '',
    'x-project-uuid': cfg.DJI_X_PROJECT_UUID || ''
  };
}

module.exports = { transform, buildDJIHeaders, mapAlertLevel, extractCoordinates };
