#!/usr/bin/env node

const http = require('http');

const BASE_URL = process.env.TRAVEL_APPLY_BASE_URL || 'http://221.224.251.134:6770/api/';

function request(method, url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isGet = method.toUpperCase() === 'GET';
    let body = '';
    if (!isGet && data) {
      body = JSON.stringify(data);
    }
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'authorization':'Basic c2FiZXI6c2FiZXJfc2VjcmV0',
        'blade-auth': 'bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZW5hbnRfaWQiOiIwMDAwMDAiLCJ1c2VyX25hbWUiOiJKSDAwMTQwIiwicmVhbF9uYW1lIjoi5b6Q6aqPIiwiYXZhdGFyIjoiIiwiY2xpZW50X2lkIjoic2FiZXIiLCJyb2xlX25hbWUiOiIiLCJsaWNlbnNlIjoicG93ZXJlZCBieSBibGFkZXgiLCJwb3N0X2lkIjoiIiwidXNlcl9pZCI6IjE3Mjc1OTYxMzk4ODIzOTc2OTgiLCJyb2xlX2lkIjoiIiwic2NvcGUiOlsiYWxsIl0sIm5pY2tfbmFtZSI6IuW-kOmqjyIsIm9hdXRoX2lkIjoiIiwiZGV0YWlsIjp7Im9yZ0lkIjoxNzI3NTA3NTU2NjQzMzY0ODY2LCJ1c2VyVHlwZSI6ImFkbWluIn0sImV4cCI6MTc3NjM5MDUzNSwiZGVwdF9pZCI6IiIsImp0aSI6IjU0ODg4NWRkLTc2YTgtNGRhYi05ZDAyLWRiODZkYTg3YTMzZSIsImFjY291bnQiOiJKSDAwMTQwIn0.TsUomDOBlcitZLc12l5nO_bcdkFzGHoyoLGGaW521sM',
      },
      timeout: 30000,
    }, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
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
  try { args = JSON.parse(input); } catch (e) {
    console.error(JSON.stringify({ error: 'Invalid JSON: ' + e.message, code: 400 }));
    process.exit(1);
  }

  const method = (args.method || 'POST').toUpperCase();
  const path = args.path;
  if (!path) {
    console.error(JSON.stringify({ error: '"path" is required', code: 400 }));
    process.exit(1);
  }

  let fullUrl = BASE_URL.replace(/\/+$/, '') + path;

  if (args.params && Object.keys(args.params).length > 0) {
    const qs = Object.entries(args.params)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    if (qs) fullUrl += '?' + qs;
  }

  try {
    const result = await request(method, fullUrl, args.body || null);
    console.log(JSON.stringify(result));
    process.exit(result.code === 200 ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message, code: 500 }));
    process.exit(1);
  }
}

main();
