const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;

const OXY_USERNAME = process.env.OXYLABS_USERNAME;
const OXY_PASSWORD = process.env.OXYLABS_PASSWORD;
const OXY_PORTS = [8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010];
let rrIndex = 0;

// Simple shared-secret auth so random people can't use your relay/proxy budget.
const RELAY_SECRET = process.env.RELAY_SECRET || null;

function nextProxyAgent(credId) {
  let hash = 0;
  const key = String(credId || 'default');
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const port = OXY_PORTS[hash % OXY_PORTS.length];
  const proxyUrl = `http://${OXY_USERNAME}:${OXY_PASSWORD}@isp.oxylabs.io:${port}`;
  return { agent: new HttpsProxyAgent(proxyUrl), port };
}

app.use((req, res, next) => {
  if (RELAY_SECRET && req.header('x-relay-secret') !== RELAY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// GET /proxy?url=<encoded target URL>&headers=<encoded JSON headers>
app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url query param' });
  if (!OXY_USERNAME || !OXY_PASSWORD) return res.status(500).json({ error: 'Relay missing OXYLABS_USERNAME/OXYLABS_PASSWORD env vars' });

  let extraHeaders = {};
  if (req.query.headers) {
    try { extraHeaders = JSON.parse(req.query.headers); } catch (e) { /* ignore malformed headers param */ }
  }

  const { agent, port } = nextProxyAgent(req.query.cred);

  try {
    const upstream = await axios.get(targetUrl, {
      httpsAgent: agent,
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...extraHeaders },
      validateStatus: () => true, // forward whatever status Qobuz/HiFi returns, don't throw
    });
    res.status(upstream.status).set('X-Relay-Port', String(port)).json(upstream.data);
  } catch (e) {
    console.error('[relay] proxy error via port ' + port + ':', e.message);
    res.status(502).json({ error: 'Relay proxy request failed', detail: e.message, port });
  }
});

// POST /proxy — same idea but for requests needing a body (rarely needed for Qobuz GET-style API)
app.get('/health', (req, res) => res.json({ ok: true, ports: OXY_PORTS.length }));

app.listen(PORT, () => console.log('Oxylabs relay listening on port ' + PORT));
