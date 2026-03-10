// djiClient.js — sends transformed request to DJI FlightHub 2
'use strict';
const axios = require('axios');

async function triggerWorkflow(headers, body) {
  const base = process.env.DJI_FH2_ENDPOINT || 'https://es-flight-api-us.djigate.com';
  const path = process.env.DJI_FH2_PATH || '/openapi/v0.1/workflow';
  const url = `${base}${path}`;
  const resp = await axios.post(url, body, { headers, timeout: 10000 });
  return resp.data;
}

module.exports = { triggerWorkflow };
