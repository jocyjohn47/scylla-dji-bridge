// transformer.js — Scylla payload → DJI FH2 body
'use strict';

const ALERT_LEVEL_MAP = {
  weapon: 5, gun: 5, knife: 5, explosive: 5, bomb: 5,
  fire: 5, smoke: 5, explosion: 5,
  fight: 4, intrusion: 4, break_in: 4, assault: 4,
  trespassing: 3, crowd: 3, suspicious: 3, anomaly: 3,
  loitering: 2, perimeter: 2,
};

function mapAlertLevel(payload) {
  if (payload.level && typeof payload.level === 'number') return payload.level;
  if (payload.alert) {
    if (payload.alert.severity) return payload.alert.severity;
    if (payload.alert.level) return payload.alert.level;
    if (payload.alert.label) {
      const key = payload.alert.label.toLowerCase();
      for (const [k, v] of Object.entries(ALERT_LEVEL_MAP)) {
        if (key.includes(k)) return v;
      }
    }
  }
  if (payload.severity) return payload.severity;
  return 3;
}

function extractCoordinates(payload) {
  const defLat = parseFloat(process.env.DEFAULT_LATITUDE || '22.793234156');
  const defLng = parseFloat(process.env.DEFAULT_LONGITUDE || '114.258620618');
  if (payload.location) {
    return {
      latitude: payload.location.latitude || payload.location.lat || defLat,
      longitude: payload.location.longitude || payload.location.lng || defLng
    };
  }
  if (payload.latitude || payload.longitude) {
    return { latitude: payload.latitude || defLat, longitude: payload.longitude || defLng };
  }
  if (payload.gps) {
    return { latitude: payload.gps.lat || defLat, longitude: payload.gps.lng || defLng };
  }
  return { latitude: defLat, longitude: defLng };
}

function transform(scyllaPayload) {
  const level = mapAlertLevel(scyllaPayload);
  const { latitude, longitude } = extractCoordinates(scyllaPayload);
  const alertLabel = (scyllaPayload.alert && scyllaPayload.alert.label) ||
                     scyllaPayload.type || scyllaPayload.alert_type || 'alert';
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const desc = scyllaPayload.description || scyllaPayload.desc ||
               (scyllaPayload.alert && scyllaPayload.alert.label) ||
               `Alert from ${scyllaPayload.camera_name || 'camera'}`;

  const djiBody = {
    workflow_uuid: process.env.DJI_WORKFLOW_UUID,
    trigger_type: 0,
    name: `${alertLabel}-${ts}`,
    params: {
      creator: process.env.DJI_CREATOR_ID,
      latitude,
      longitude,
      level,
      desc
    }
  };
  return { djiBody, level };
}

function buildDJIHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-User-Token': process.env.DJI_X_USER_TOKEN || '',
    'x-project-uuid': process.env.DJI_X_PROJECT_UUID || ''
  };
}

module.exports = { transform, buildDJIHeaders };
