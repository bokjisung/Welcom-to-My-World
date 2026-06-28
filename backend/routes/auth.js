// ============================================================
// routes/auth.js - 회원가입 / 로그인 / 로그아웃 API
// ============================================================
const express   = require('express');
const bcrypt    = require('bcrypt');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const router    = express.Router();

const db       = require('../config/db');
const tg       = require('../config/telegram');
const { signToken, verifyToken } = require('../middleware/auth');

// ─── Rate Limiter (로그인·회원가입 공통 사용) ─────────────
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,   // 10분
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: '잠시 후 다시 시도해주세요.' },
});

// bcrypt 최대 입력 길이 (72자 초과 시 잘림 → DoS 가능)
const BCRYPT_MAX_LEN = 72;

// ─── POST /api/auth/register - 회원가입 ──────────────────
router.post('/register', authLimiter, async (req, res) => {
  const { username, password, nickname, email } = req.body;

  // ── 필수값 검사 ─────────────────────────────────────────
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력하세요.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: '비밀번호는 8자 이상이어야 합니다.' });
  }
  if (password.length > BCRYPT_MAX_LEN) {
    return res.status(400).json({ success: false, message: `비밀번호는 ${BCRYPT_MAX_LEN}자 이하로 입력해주세요.` });
  }
  if (!nickname || nickname.trim().length < 2) {
    return res.status(400).json({ success: false, message: '닉네임은 2자 이상 입력해야 합니다.' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.(com|net|org|co\.kr|kr|io|dev|me|info|biz|edu|gov|ac\.kr)$/.test(email)) {
    return res.status(400).json({ success: false, message: '알맞은 이메일형식(@, .com, .net...)이 아닙니다.' });
  }

  const cleanNickname = nickname.trim();

  // ⑦ bcrypt는 트랜잭션 밖에서 먼저 수행 — FOR UPDATE 락 보유 시간 최소화
  const hash = await bcrypt.hash(password, 10);

  // 레이스 컨디션 방지: 중복 확인 3쿼리를 트랜잭션 + FOR UPDATE 로 묶음
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // ── 아이디 중복 확인 ────────────────────────────────────
    const [existsUser] = await conn.query(
      'SELECT id FROM users WHERE username = ? FOR UPDATE', [username]
    );
    if (existsUser.length > 0) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: '이미 사용 중인 아이디입니다.' });
    }

    // ── 닉네임 중복 확인 ────────────────────────────────────
    const [existsNick] = await conn.query(
      'SELECT id FROM users WHERE nickname = ? FOR UPDATE', [cleanNickname]
    );
    if (existsNick.length > 0) {
      await conn.rollback();
      return res.status(409).json({ success: false, message: '이미 사용중인 닉네임입니다.' });
    }

    // ── 이메일 중복 확인 ────────────────────────────────────
    if (email) {
      const [existsEmail] = await conn.query(
        'SELECT id FROM users WHERE email = ? FOR UPDATE', [email]
      );
      if (existsEmail.length > 0) {
        await conn.rollback();
        return res.status(409).json({ success: false, message: '이미 사용중인 이메일입니다.' });
      }
    }

    // ── DB 저장 (hash는 이미 위에서 계산 완료) ──────────────
    await conn.query(
      'INSERT INTO users (username, password_hash, nickname, email) VALUES (?, ?, ?, ?)',
      [username, hash, cleanNickname, email || null]
    );

    await conn.commit();

    const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
    await tg.notifySignup(username, ip);

    res.status(201).json({ success: true, message: '회원가입 완료!' });
  } catch (err) {
    await conn.rollback();
    // DB UNIQUE 제약 위반 (레이스 컨디션 최후 방어선)
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: '이미 사용 중인 아이디, 닉네임 또는 이메일입니다.' });
    }
    console.error('[Register]', err);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  } finally {
    conn.release();
  }
});

// ─── POST /api/auth/login - 로그인 ───────────────────────
router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  const ip = (req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';

  if (!username || !password) {
    return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력하세요.' });
  }
  if (password.length > BCRYPT_MAX_LEN) {
    return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE username = ? AND is_active = 1', [username]);

    if (rows.length === 0) {
      await db.query(
        'INSERT INTO login_logs (username, ip_address, user_agent, result, fail_reason) VALUES (?, ?, ?, ?, ?)',
        [username, ip, ua, 'fail', '존재하지 않는 아이디']
      );
      const [failCount] = await db.query(
        'SELECT COUNT(*) AS cnt FROM login_logs WHERE ip_address = ? AND result = "fail" AND attempted_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)',
        [ip]
      );
      if (failCount[0].cnt >= 5) await tg.notifyFailedLogin(username, ip, failCount[0].cnt);

      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
    }

    const user  = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      await db.query(
        'INSERT INTO login_logs (username, user_id, ip_address, user_agent, result, fail_reason) VALUES (?, ?, ?, ?, ?, ?)',
        [username, user.id, ip, ua, 'fail', '비밀번호 불일치']
      );
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 틀렸습니다.' });
    }

    // 로그인 성공
    const token = signToken({ id: user.id, username: user.username, role: user.role });
    await db.query(
      'INSERT INTO login_logs (username, user_id, ip_address, user_agent, result) VALUES (?, ?, ?, ?, ?)',
      [username, user.id, ip, ua, 'success']
    );
    // ⑤ 성공 시 해당 IP의 이전 실패 로그를 invalidated로 업데이트
    //    → 이후 실패 카운트 집계에서 제외되어 텔레그램 오탐 방지
    await db.query(
      `UPDATE login_logs
         SET fail_reason = CONCAT('[cleared] ', IFNULL(fail_reason, ''))
       WHERE ip_address = ? AND result = 'fail'
         AND attempted_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)`,
      [ip]
    );

    if (user.role === 'admin') await tg.notifyAdminLogin(username, ip);

    res.json({
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    console.error('[Login]', err);
    await tg.notifyError(`로그인 API 오류: ${err.message}`);
    res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
  }
});

// ─── POST /api/auth/logout - 로그아웃 ───────────────────
router.post('/logout', verifyToken, async (req, res) => {
  try {
    const jti = req.user?.jti;
    const exp = req.user?.exp;
    if (jti && exp) {
      await db.query(
        'INSERT IGNORE INTO token_blacklist (token_jti, expires_at) VALUES (?, FROM_UNIXTIME(?))',
        [jti, exp]
      );
    }
    res.json({ success: true, message: '로그아웃 완료.' });
  } catch (err) {
    console.error('[Logout]', err);
    res.status(500).json({ success: false, message: '서버 오류' });
  }
});

// ─── GET /api/auth/me - 현재 사용자 정보 ─────────────────
router.get('/me', verifyToken, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, username, nickname, email, role, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false });
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

module.exports = router;
