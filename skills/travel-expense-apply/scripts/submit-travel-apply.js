#!/usr/bin/env node

const http = require('http');

const BASE_URL = process.env.TRAVEL_APPLY_BASE_URL || 'http://221.224.251.134:6770/api/';
const SAVE_ENDPOINT = '/edo-reimburse/applyTravel/saveApplyTravel';

function post(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const body = JSON.stringify(data);
    const req = http.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'authorization':'Basic c2FiZXI6c2FiZXJfc2VjcmV0',
        'blade-auth': 'bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0ZW5hbnRfaWQiOiIwMDAwMDAiLCJ1c2VyX25hbWUiOiJKSDAwMTQwIiwicmVhbF9uYW1lIjoi5b6Q6aqPIiwiYXZhdGFyIjoiIiwiY2xpZW50X2lkIjoic2FiZXIiLCJyb2xlX25hbWUiOiIiLCJsaWNlbnNlIjoicG93ZXJlZCBieSBibGFkZXgiLCJwb3N0X2lkIjoiIiwidXNlcl9pZCI6IjE3Mjc1OTYxMzk4ODIzOTc2OTgiLCJyb2xlX2lkIjoiIiwic2NvcGUiOlsiYWxsIl0sIm5pY2tfbmFtZSI6IuW-kOmqjyIsIm9hdXRoX2lkIjoiIiwiZGV0YWlsIjp7Im9yZ0lkIjoxNzI3NTA3NTU2NjQzMzY0ODY2LCJ1c2VyVHlwZSI6ImFkbWluIn0sImV4cCI6MTc3NjM5NDE3NCwiZGVwdF9pZCI6IiIsImp0aSI6ImVmYzg1NGQ4LTRkY2ItNDFkYS05ZTQ1LWM0OTA1YzE4M2U1MyIsImFjY291bnQiOiJKSDAwMTQwIn0.-IF5FJX5xNrlvNAIcZhmODy83ktLlTGQ4FxlrzzVfTM',
      },
      timeout: 30000,
    }, (res) => {
      let chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString();
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('Invalid response: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

function buildPayload(formData) {
  const areasPOS = (formData.areas || []).map(a => ({
    areasCode: a.code,
    areasName: a.name,
  }));

  const associatePOS = (formData.associates || []).map(u => ({
    associateBy: u.id,
    associateName: u.name,
  }));

  return {
    orderType: 'sqcl',
    applyBy: formData.applyBy,
    applyCode: formData.applyCode,
    applyName: formData.applyName,
    applyOrgId: formData.applyOrgId,
    applyOrgCode: formData.applyOrgCode,
    applyOrgName: formData.applyOrgName,
    approvalStatus: 'sp',
    costOrgId: formData.costOrgId,
    costOrgCode: formData.costOrgCode,
    costOrgName: formData.costOrgName,
    enterpriseId: formData.enterpriseId,
    enterpriseCode: formData.enterpriseCode,
    enterpriseName: formData.enterpriseName,
    costId: formData.costId,
    costCode: formData.costCode,
    costName: formData.costName,
    remark: formData.remark,
    currencyId: formData.currencyId,
    currencyCode: formData.currencyCode || 'CNY',
    currencyName: formData.currencyName || '人民币',
    exchangeRate: formData.exchangeRate || 1,
    originalCoin: Number(formData.originalCoin),
    localCurrency: Number(formData.originalCoin),
    travelStartDate: formData.travelStartDate,
    travelEndDate: formData.travelEndDate,
    travelRange: Number(formData.travelRange),
    areasPOS,
    associatePOS,
  };
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error(JSON.stringify({ error: 'Missing form data JSON argument', code: 400 }));
    process.exit(1);
  }

  let formData;
  try {
    formData = JSON.parse(input);
  } catch (e) {
    console.error(JSON.stringify({ error: 'Invalid JSON: ' + e.message, code: 400 }));
    process.exit(1);
  }

  const requiredFields = [
    'applyBy', 'applyCode', 'applyName', 'applyOrgId', 'applyOrgCode', 'applyOrgName',
    'costOrgId', 'costOrgCode', 'costOrgName',
    'enterpriseId', 'enterpriseCode', 'enterpriseName',
    'costId', 'costCode', 'costName',
    'remark', 'originalCoin',
    'travelStartDate', 'travelEndDate', 'travelRange',
  ];

  const missing = requiredFields.filter(f => !formData[f] && formData[f] !== 0);
  if (missing.length > 0) {
    console.error(JSON.stringify({ error: 'Missing required fields: ' + missing.join(', '), code: 400 }));
    process.exit(1);
  }

  if (!formData.areas || formData.areas.length === 0) {
    console.error(JSON.stringify({ error: 'Missing required field: areas (at least one location)', code: 400 }));
    process.exit(1);
  }

  if (Number(formData.originalCoin) <= 0) {
    console.error(JSON.stringify({ error: 'originalCoin must be greater than 0', code: 400 }));
    process.exit(1);
  }

  const payload = buildPayload(formData);

  try {
    const result = await post(BASE_URL + SAVE_ENDPOINT, payload);
    console.log(JSON.stringify(result));
    process.exit(result.code === 200 ? 0 : 1);
  } catch (err) {
    console.error(JSON.stringify({ error: err.message, code: 500 }));
    process.exit(1);
  }
}

main();
