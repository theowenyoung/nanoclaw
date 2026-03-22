#!/usr/bin/env tsx
/**
 * WeChat QR code login script.
 * Usage: npm run auth:weixin
 */
import {
  performQRLogin,
  saveCredentials,
  DEFAULT_BASE_URL,
} from './channels/weixin.js';

const baseUrl = process.env.WEIXIN_BASE_URL || DEFAULT_BASE_URL;

console.log(`Using API base: ${baseUrl}`);

const creds = await performQRLogin(baseUrl);
if (creds) {
  saveCredentials(creds);
  console.log(`Credentials saved. Account ID: ${creds.accountId}`);
  console.log(`Register this user with JID: wx:${creds.userId}`);
} else {
  console.log('Login failed or was cancelled.');
  process.exit(1);
}
