const express = require('express');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;

const OXY_USERNAME = process.env.OXYLABS_USERNAME;
const OXY_PASSWORD = process.env.OXYLABS_PASSWORD;
const OXY_PORTS = [8001, 8002, 8003, 8004, 8005, 8006, 8007, 8008, 8009, 8010];

// Simple shared-secret auth so random people can't use your relay/proxy budget.
const RELAY_SECRET = process.env.RELAY_SECRET || null;

// One agent per port, reused. Building a new HttpsProxyAgent per request opened
// a fresh CONNECT tunnel every call — 300ms+ of setup and double TLS instead of
// ~20ms on a warm one. keepAlive with a 25s idle timeout so we recycle tunnels
// before Oxylabs drops them and we start failing on dead sockets.
const _agents = new Map();

function nextProxyAgent(credId) {
  let hash = 0;
  const key = String(credId || 'default');
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const port = OXY_PORTS[hash % OXY_PORTS.length];
  let agent = _agents.get(port);
  if (!agent) {
    const proxyUrl = `http://${OXY_USERNAME}:${OXY_PASSWORD}@isp.oxylabs.io:${port}`;
    agent = new HttpsProxyAgent(proxyUrl, {
      keepAlive: true,
      keepAliveMsecs: 10000,
      timeout: 25000,
      maxSockets: 40,
      maxFreeSockets: 20,
    });
    _agents.set(port, agent);
  }
  return { agent, port };
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
      responseType: 'arraybuffer', // don't let axios decide; pass bytes through untouched
      decompress: true,
    });
    // Forward the body verbatim with its own content-type. This used to be
    // res.json(), which turned any non-JSON upstream (an HTML login page, a
    // bundle.js) into a quoted JSON string and silently broke the caller's
    // regexes. JSON callers are unaffected — they still parse the same bytes.
    res.status(upstream.status)
       .set('X-Relay-Port', String(port))
       .set('Content-Type', upstream.headers['content-type'] || 'application/octet-stream')
       .send(Buffer.from(upstream.data));
  } catch (e) {
    console.error('[relay] proxy error via port ' + port + ':', e.message);
    res.status(502).json({ error: 'Relay proxy request failed', detail: e.message, port });
  }
});

// POST /proxy — same idea but for requests needing a body (rarely needed for Qobuz GET-style API)
app.get('/health', (req, res) => res.json({ ok: true, ports: OXY_PORTS.length }));

app.listen(PORT, () => console.log('Oxylabs relay listening on port ' + PORT));
