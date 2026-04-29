#!/usr/bin/env node

const http = require('http');
const path = require('path');
const { getAuthHeaders } = require(path.join(__dirname, 'token-manager'));

const BASE_URL = process.env.TRAVEL_APPLY_BASE_URL || 'http://221.224.251.134:6770/api/';

function safeJsonParse(str) {
  const safe = str.replace(
      /("(?:[^"\\]|\\.)*")|(\b\d{16,}\b)/g,
      (match, str, num) => num ? `"${num}"` : match
  );
  return JSON.parse(safe);
}

function safeJsonStringify(obj) {
  return JSON.stringify(obj).replace(
      /"(-?\d{16,})"/g,
      '$1'
  );
}

function request(method, url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isGet = method.toUpperCase() === 'GET';
    let body = '';
    if (!isGet && data) {
      body = safeJsonStringify(data);
    }
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...getAuthHeaders(),
      },
      timeout: 30000,
    }, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(safeJsonParse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error('Invalid response JSON: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (!isGet) req.write(body);
    req.end();
  });
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error(JSON.stringify({
      error: 'Usage: api-call.js \'{"method":"POST|GET","path":"/edo-base/...","params":{...},"body":{...}}\'',
      code: 400
    }));
    process.exit(1);
  }

  let args;
  try { args = safeJsonParse(input); } catch (e) {
    console.error(JSON.stringify({ error: 'Invalid JSON: ' + e.message, code: 400 }));
    process.exit(1);
  }

  const method = (args.method || 'POST').toUpperCase();
  const path_ = args.path;
  if (!path_) {
    console.error(JSON.stringify({ error: '"path" is required', code: 400 }));
    process.exit(1);
  }

  let fullUrl = BASE_URL.replace(/\/+$/, '') + path_;

  if (args.params && Object.keys(args.params).length > 0) {
    const qs = Object.entries(args.params)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
        .join('&');
    if (qs) fullUrl += '?' + qs;
  }

  try {
    const result = await request(method, fullUrl, args.body || null);
    console.log(safeJsonStringify(result));
    process.exit(result.code === 200 ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message, code: 500 }));
    process.exit(1);
  }
}

main();
