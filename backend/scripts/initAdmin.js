// ============================================================
// scripts/initAdmin.js - 관리자 계정 최초 생성 스크립트
// 사용법: node scripts/initAdmin.js
// ============================================================
require('dotenv').config();
const bcrypt = require('bcrypt');
const db     = require('../config/db');

async function init() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'changeme123!';

  const hash = await bcrypt.hash(password, 10);
  try {
    await db.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES (?, ?, 'admin')
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin'`,
      [username, hash]
    );
    console.log(`[InitAdmin] 관리자 계정 생성 완료: ${username}`);
  } catch (err) {
    console.error('[InitAdmin] 실패:', err.message);
  }
  process.exit(0);
}
init();
