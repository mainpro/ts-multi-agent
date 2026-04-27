#!/usr/bin/env node
/**
 * token-manager.js - Token 管理模块
 *
 * 从环境变量 SKILL_ACCESS_TOKEN 读取 accessToken，提供给脚本使用。
 * - 有 token 则透传，没有也继续执行（由下游 API 返回 401）
 * - 401 不重试，直接返回
 *
 * 用法：
 *   const { getToken, getAuthHeaders } = require('./token-manager');
 */

'use strict';

const BASIC_AUTH = 'Basic c2FiZXI6c2FiZXJfc2VjcmV0';

/**
 * 从环境变量获取 accessToken
 * @returns {string|undefined} token 值，未设置时返回 undefined
 */
function getToken() {
  return process.env.SKILL_ACCESS_TOKEN || undefined;
}

/**
 * 构建认证 headers
 * @returns {Object} 包含 authorization 和 blade-auth 的 headers 对象
 */
function getAuthHeaders() {
  const token = getToken();
  const headers = {
    'authorization': BASIC_AUTH,
  };
  if (token) {
    headers['blade-auth'] = token.startsWith('bearer ') ? token : `bearer ${token}`;
  }
  return headers;
}

module.exports = { getToken, getAuthHeaders };
