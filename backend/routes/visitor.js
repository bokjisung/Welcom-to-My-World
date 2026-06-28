// ============================================================
// routes/visitor.js — 방문자 로그 / 통계 API
// ============================================================
const express      = require('express');
// ③ Node.js 18 미만 환경 대응 — node-fetch로 통일 (telegram.js와 일관성 유지)
const fetch        = require('node-fetch');
const { UAParser } = require('ua-parser-js');
const pool         = require('../db/pool');   // config/db.js 와 동일한 인스턴스
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ─────────────────────────────────────────────────────────
// POST /api/visitor/session/start — 세션 시작
// ─────────────────────────────────────────────────────────
router.post('/session/start', async (req, res) => {
  const {
    sessionId, userId, referer,
    utmSource, utmMedium, utmCampaign,
    isFirstVisit,   // 프론트(쿠키)에서 판단한 값을 받음
  } = req.body;

  if (!sessionId) return res.status(400).json({ ok: false, message: 'sessionId 필요' });

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || null;
  const ua = req.headers['user-agent'] || '';

  const parser  = new UAParser(ua);
  const uaRes   = parser.getResult();
  const browser = uaRes.browser.name || null;
  const os      = uaRes.os.name      || null;
  const deviceType = (() => {
    const type = uaRes.device.type;
    if (!type) return 'desktop';
    if (type === 'mobile')  return 'mobile';
    if (type === 'tablet')  return 'tablet';
    return 'unknown';
  })();

  try {
    // IP 위치 조회 (ipapi.co 무료 tier, 실패 시 무시)
    // ③ 전역 fetch 대신 require('node-fetch') 사용 (Node 17 이하 호환)
    let country = null, city = null;
    try {
      if (ip && ip !== '127.0.0.1' && ip !== '::1') {
        const geoRes = await fetch(`https://ipapi.co/${ip}/json/`);
        if (geoRes.ok) {
          const geo = await geoRes.json();
          country = geo.country_name || null;
          city    = geo.city         || null;
        }
      }
    } catch (_) { /* 위치 조회 실패 시 무시 */ }

    await pool.execute(
      `INSERT INTO visitor_sessions
         (session_id, user_id, ip_address, user_agent, browser, os, device_type,
          country, city, referer, utm_source, utm_medium, utm_campaign, is_first_visit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_id     = COALESCE(VALUES(user_id), user_id),
         visit_count = visit_count + 1`,
      [
        sessionId, userId || null, ip, ua, browser, os, deviceType,
        country, city, referer || null,
        utmSource || null, utmMedium || null, utmCampaign || null,
        isFirstVisit ? 1 : 0,
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[Session Start]', err);
    res.status(500).json({ ok: false, message: '세션 저장 실패' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/visitor/session/end — 세션 종료 (체류시간)
// ─────────────────────────────────────────────────────────
router.post('/session/end', async (req, res) => {
  const { sessionId, durationSec } = req.body;
  if (!sessionId) return res.status(400).json({ ok: false, message: 'sessionId 필요' });

  try {
    await pool.execute(
      `UPDATE visitor_sessions SET ended_at = NOW(), duration_sec = ? WHERE session_id = ?`,
      [durationSec != null ? durationSec : null, sessionId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[Session End]', err);
    res.status(500).json({ ok: false });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/visitor/pageview — 페이지 조회 기록
// ─────────────────────────────────────────────────────────
router.post('/pageview', async (req, res) => {
  const { sessionId, pageUrl, pageTitle } = req.body;
  if (!sessionId || !pageUrl) return res.status(400).json({ ok: false, message: 'sessionId, pageUrl 필요' });

  try {
    await pool.execute(
      `INSERT INTO page_views (session_id, page_url, page_title) VALUES (?, ?, ?)`,
      [sessionId, pageUrl, pageTitle || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[Pageview]', err);
    res.status(500).json({ ok: false });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/visitor/event — 클릭/행동 이벤트 기록
// ─────────────────────────────────────────────────────────
router.post('/event', async (req, res) => {
  const { sessionId, eventType, elementId, elementText, pageUrl, extraData } = req.body;
  if (!sessionId || !eventType) return res.status(400).json({ ok: false, message: 'sessionId, eventType 필요' });

  try {
    await pool.execute(
      `INSERT INTO event_logs (session_id, event_type, element_id, element_text, page_url, extra_data)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        sessionId, eventType,
        elementId   || null,
        elementText || null,
        pageUrl     || null,
        extraData   ? JSON.stringify(extraData) : null,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[Event]', err);
    res.status(500).json({ ok: false });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/visitor/stats — 통계 요약 (관리자)
// ─────────────────────────────────────────────────────────
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [[todayRow]]    = await pool.execute(`SELECT COUNT(*) AS cnt FROM visitor_sessions WHERE DATE(started_at) = CURDATE()`);
    const [[totalRow]]    = await pool.execute(`SELECT COUNT(*) AS cnt FROM visitor_sessions`);
    const [[memberRow]]   = await pool.execute(`SELECT COUNT(*) AS cnt FROM users`);
    const [[surveyRow]]   = await pool.execute(`SELECT COUNT(*) AS cnt FROM surveys`);
    const [deviceRows]    = await pool.execute(`SELECT device_type, COUNT(*) AS cnt FROM visitor_sessions GROUP BY device_type`);
    const [countryRows]   = await pool.execute(`SELECT country, COUNT(*) AS cnt FROM visitor_sessions GROUP BY country ORDER BY cnt DESC LIMIT 10`);
    const [hourRows]      = await pool.execute(`SELECT HOUR(started_at) AS hour, COUNT(*) AS cnt FROM visitor_sessions GROUP BY hour ORDER BY hour`);
    const [pageRows]      = await pool.execute(`SELECT page_url, COUNT(*) AS cnt FROM page_views GROUP BY page_url ORDER BY cnt DESC LIMIT 10`);
    const [[loginFailRow]]= await pool.execute(`SELECT COUNT(*) AS cnt FROM login_logs WHERE result='fail' AND DATE(attempted_at) = CURDATE()`);

    res.json({
      ok: true,
      stats: {
        today_visitors:    todayRow.cnt,
        total_visitors:    totalRow.cnt,
        total_members:     memberRow.cnt,
        total_surveys:     surveyRow.cnt,
        today_login_fails: loginFailRow.cnt,
        by_device:         deviceRows,
        by_country:        countryRows,
        by_hour:           hourRows,
        top_pages:         pageRows,
      },
    });
  } catch (err) {
    console.error('[Visitor Stats]', err);
    res.status(500).json({ ok: false, message: '통계 조회 실패' });
  }
});

module.exports = router;
