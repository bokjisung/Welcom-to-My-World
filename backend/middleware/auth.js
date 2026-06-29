// ============================================================
// middleware/auth.js - JWT 인증 미들웨어
// ============================================================
require('dotenv').config();
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db  = require('../config/db');

// ─── JWT_SECRET 단일 관리 ─────────────────────────────────
// [보안] 이 값을 survey.js · log.js 등에서 직접 import해서 사용.
//        여기서만 선언하면 SECRET 불일치 버그를 원천 차단.
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === 'fallback_secret_change_me') {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] JWT_SECRET 이 설정되지 않았습니다. 서버를 종료합니다.');
    process.exit(1);
  } else {
    console.warn('[WARN] JWT_SECRET 미설정 — 개발용 임시값 사용 중. 배포 전 반드시 변경하세요!');
  }
}
const EFFECTIVE_SECRET = SECRET || 'fallback_secret_change_me';

// ─── 토큰 생성 (jti 포함) ─────────────────────────────────
function signToken(payload) {
  return jwt.sign(
    { ...payload, jti: uuidv4() },   // jti 없으면 블랙리스트가 작동 안 함
    EFFECTIVE_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ─── 토큰 검증 미들웨어 ────────────────────────────────────
async function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) return res.status(401).json({ success: false, message: '토큰이 없습니다.' });

  try {
    // 1) 먼저 서명 검증 (만료·변조 확인)
    const decoded = jwt.verify(token, EFFECTIVE_SECRET);

    // 2) jti 가 있을 때만 블랙리스트 조회
    if (decoded.jti) {
      const [rows] = await db.query(
        'SELECT id FROM token_blacklist WHERE token_jti = ?',
        [decoded.jti]
      );
      if (rows.length > 0) {
        return res.status(401).json({ success: false, message: '로그아웃된 토큰입니다.' });
      }
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: '유효하지 않은 토큰입니다.' });
  }
}

// ─── 관리자 전용 미들웨어 ────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, message: '관리자 권한이 필요합니다.' });
  }
  next();
}

// requireAuth = verifyToken 의 별칭 (visitor.js 와 호환)
const requireAuth = verifyToken;

module.exports = { verifyToken, requireAuth, requireAdmin, signToken, EFFECTIVE_SECRET };
