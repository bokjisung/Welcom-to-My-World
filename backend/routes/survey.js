// ============================================================
// routes/survey.js  - 설문조사 저장 / 조회 API  (v2)
//
// 원본 welcome.html 6문항과 완전히 일치:
//   Q1. 디자인이 촌스럽다고 생각하시나요?
//   Q2. 페이지 정보가 한눈에 잘 들어오나요?
//   Q3. 색상(보라색 톤) 배색이 마음에 드시나요?
//   Q4. 모바일에서도 사용하기 편리한가요?
//   Q5. 다시 이 페이지를 방문하고 싶으신가요?
//   Q6. 자유 의견 (선택 · textarea)
// ============================================================
const express = require('express');
const jwt     = require('jsonwebtoken');
const router  = express.Router();
const db      = require('../config/db');
const tg      = require('../config/telegram');
// ① SECRET 중복 선언 제거 — middleware에서 단일 관리하는 값을 import
const { verifyToken, requireAdmin, EFFECTIVE_SECRET } = require('../middleware/auth');

// ─── POST /api/survey  설문 응답 저장 ─────────────────────
router.post('/', async (req, res) => {
  const {
    session_id,
    // 프론트 v1/v2 필드명 모두 수용
    q1_purpose,    q2_frequency,  q3_device,     q4_feedback,
    q1_design,     q2_readability, q3_color,
    q4_mobile,     q5_revisit,    q6_comment,
    extra_answers,
  } = req.body;

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';

  // ── JWT에서 user_id 추출 (비로그인 방문자도 허용) ─────────
  let userId = null;
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    try {
      const decoded = jwt.verify(authHeader.split(' ')[1], EFFECTIVE_SECRET);
      userId = decoded.id;
    } catch (_) {
      // 토큰 검증 실패 시 비로그인으로 처리 (의도된 동작)
    }
  }

  // ── extra_answers 파싱 ──────────────────────────────────
  let extra = {};
  if (extra_answers) {
    try { extra = JSON.parse(extra_answers); } catch (_) {}
  }

  // ── 최종 저장값 결정 (여러 필드명 OR 처리) ───────────────
  const final = {
    q1: q1_design      || q1_purpose    || null,
    q2: q2_readability || q2_frequency  || null,
    q3: q3_color       || q3_device     || null,
    q4: q4_mobile      || q4_feedback   || null,
    q5: q5_revisit     || extra.q5      || null,
    q6: q6_comment     || extra.q6      || extra.comment || null,
  };

  try {
    await db.query(
      `INSERT INTO surveys
         (user_id, session_id,
          q1_design, q2_readability, q3_color, q4_mobile, q5_revisit, q6_comment,
          ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, session_id || null,
        final.q1, final.q2, final.q3, final.q4, final.q5, final.q6,
        ip, ua,
      ]
    );

    const displayName = userId ? `회원 #${userId}` : '비회원';
    await tg.notifySurvey(displayName, final);

    res.json({ success: true, message: '설문 응답이 저장되었습니다.' });
  } catch (err) {
    console.error('[Survey POST]', err);
    res.status(500).json({ success: false, message: '저장에 실패했습니다.' });
  }
});

// ─── GET /api/survey  관리자 조회 ────────────────────────
// ⑥ 인라인 role 체크 → requireAdmin 미들웨어로 통일
router.get('/', verifyToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT
        s.id, s.submitted_at,
        u.username,
        s.q1_design      AS q1,
        s.q2_readability AS q2,
        s.q3_color       AS q3,
        s.q4_mobile      AS q4,
        s.q5_revisit     AS q5,
        s.q6_comment     AS q6,
        s.ip_address,
        s.session_id
      FROM surveys s
      LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.submitted_at DESC
      LIMIT 200
    `);
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    console.error('[Survey GET]', err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
