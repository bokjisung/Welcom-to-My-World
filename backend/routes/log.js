// ============================================================
// routes/log.js - 방문자 로그 저장 / 조회 / 통계 API
// ============================================================
const express  = require('express');
const router   = express.Router();
const UAParser = require('ua-parser-js');
const jwt      = require('jsonwebtoken');
const db       = require('../config/db');
const tg       = require('../config/telegram');
// ① SECRET 중복 선언 제거 — middleware에서 단일 관리하는 값을 import
const { verifyToken, requireAdmin, EFFECTIVE_SECRET } = require('../middleware/auth');

// ── JWT 에서 userId 추출 (선택적 인증, 실패 시 null 반환) ──
function extractUserId(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return null;
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], EFFECTIVE_SECRET);
    return decoded.id || null;
  } catch (_) {
    return null;
  }
}

// ─── POST /api/log/session - 세션 시작 ───────────────────
router.post('/session', async (req, res) => {
  const {
    session_id, referer, utm_source, utm_medium, utm_campaign,
    is_first_visit, visit_count
  } = req.body;

  // ② session_id 필수값 검증
  if (!session_id) {
    return res.status(400).json({ success: false, message: 'session_id 가 필요합니다.' });
  }

  const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const ua = req.headers['user-agent'] || '';
  const parser = new UAParser(ua);
  const browser = parser.getBrowser().name || 'unknown';
  const os      = parser.getOS().name      || 'unknown';
  const deviceType = (() => {
    const d = parser.getDevice().type;
    if (!d) return 'desktop';
    return ['mobile', 'tablet'].includes(d) ? d : 'unknown';
  })();

  const userId = extractUserId(req);

  try {
    await db.query(
      `INSERT IGNORE INTO visitor_sessions
         (session_id, user_id, ip_address, user_agent, browser, os, device_type,
          referer, utm_source, utm_medium, utm_campaign, is_first_visit, visit_count, is_logged_in)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session_id, userId, ip, ua, browser, os, deviceType,
        referer || null, utm_source || null, utm_medium || null, utm_campaign || null,
        is_first_visit ? 1 : 0, visit_count || 1, userId ? 1 : 0,
      ]
    );

    const deviceIcon  = deviceType === 'mobile' ? '📱' : deviceType === 'tablet' ? '📲' : '🖥️';
    const memberLabel = userId ? `회원 #${userId}` : '비회원';
    const firstLabel  = is_first_visit ? '✨ 첫 방문' : `재방문 (${visit_count || 1}회째)`;

    await tg.sendTelegram(
      `👀 <b>새 방문자</b>\n` +
      `${deviceIcon} ${browser} / ${os}\n` +
      `👤 ${memberLabel}  |  ${firstLabel}\n` +
      `🌐 IP: <code>${ip}</code>\n` +
      (referer    ? `🔗 유입: ${referer.slice(0, 60)}\n`    : '') +
      (utm_source ? `📣 UTM: ${utm_source}/${utm_medium || '-'}\n` : '') +
      `🕐 ${now()}`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[Log/Session]', err);
    res.status(500).json({ success: false });
  }
});

// ─── POST /api/log/session/end - 세션 종료 ───────────────
router.post('/session/end', async (req, res) => {
  const { session_id, duration_sec } = req.body;

  // ② session_id 미검증 버그 수정
  if (!session_id) {
    return res.status(400).json({ success: false, message: 'session_id 가 필요합니다.' });
  }

  try {
    await db.query(
      'UPDATE visitor_sessions SET ended_at = NOW(), duration_sec = ? WHERE session_id = ?',
      [duration_sec != null ? duration_sec : 0, session_id]
    );

    const dur = duration_sec || 0;
    if (dur >= 10) {
      const min = Math.floor(dur / 60);
      const sec = dur % 60;
      const durLabel = min > 0 ? `${min}분 ${sec}초` : `${sec}초`;
      const durIcon  = dur >= 300 ? '🔥' : dur >= 60 ? '⏱️' : '⚡';

      await tg.sendTelegram(
        `${durIcon} <b>방문 종료 — 체류시간</b>\n` +
        `⏳ <b>${durLabel}</b> 머물렀습니다\n` +
        `🔑 세션: <code>${session_id.slice(0, 8)}...</code>\n` +
        `🕐 ${now()}`
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Log/Session/End]', err);
    res.status(500).json({ success: false });
  }
});

// ─── POST /api/log/pageview - 페이지 뷰 ─────────────────
router.post('/pageview', async (req, res) => {
  const { session_id, page_url, page_title, referer, time_spent } = req.body;
  const userId = extractUserId(req);

  try {
    await db.query(
      'INSERT INTO page_views (session_id, user_id, page_url, page_title, referer, time_spent) VALUES (?, ?, ?, ?, ?, ?)',
      [session_id, userId, page_url, page_title, referer || null, time_spent || 0]
    );

    const spentSec   = time_spent || 0;
    const spentLabel = spentSec >= 60
      ? `${Math.floor(spentSec / 60)}분 ${spentSec % 60}초`
      : `${spentSec}초`;

    await tg.sendTelegram(
      `📄 <b>페이지 조회</b>\n` +
      `🔗 ${(page_title || page_url || '-').slice(0, 60)}\n` +
      `⏱️ 이 페이지에서: <b>${spentLabel}</b>\n` +
      `🔑 세션: <code>${(session_id || '').slice(0, 8)}...</code>\n` +
      `🕐 ${now()}`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[Log/Pageview]', err);
    res.status(500).json({ success: false });
  }
});

// ─── POST /api/log/event - 클릭/스크롤 이벤트 ───────────
router.post('/event', async (req, res) => {
  const { session_id, event_type, element_id, element_text, page_url, scroll_pct, extra_data } = req.body;
  const userId = extractUserId(req);

  try {
    await db.query(
      `INSERT INTO event_logs
         (session_id, user_id, event_type, element_id, element_text, page_url, scroll_pct, extra_data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        session_id, userId, event_type,
        element_id   || null,
        element_text || null,
        page_url,
        scroll_pct   || null,
        extra_data   ? JSON.stringify(extra_data) : null,
      ]
    );

    const notifyTypes = ['click', 'scroll_complete', 'form_submit', 'button_click'];
    if (notifyTypes.includes(event_type)) {
      const eventIcon = {
        click:           '🖱️',
        scroll_complete: '📜',
        form_submit:     '📨',
        button_click:    '🔘',
      }[event_type] || '⚡';

      await tg.sendTelegram(
        `${eventIcon} <b>사용자 이벤트: ${event_type}</b>\n` +
        (element_text ? `💬 요소: ${element_text.slice(0, 50)}\n`   : '') +
        (element_id   ? `🔖 ID: <code>${element_id}</code>\n`        : '') +
        (scroll_pct   ? `📊 스크롤: ${scroll_pct}%\n`               : '') +
        `🔗 ${(page_url || '-').slice(0, 60)}\n` +
        `🔑 세션: <code>${(session_id || '').slice(0, 8)}...</code>\n` +
        `🕐 ${now()}`
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Log/Event]', err);
    res.status(500).json({ success: false });
  }
});

// ─── GET /api/log/stats - 통계 API (관리자) ──────────────
router.get('/stats', verifyToken, requireAdmin, async (req, res) => {
  try {
    const [[totalVisits]]  = await db.query('SELECT COUNT(*) AS cnt FROM visitor_sessions');
    const [[todayVisits]]  = await db.query('SELECT COUNT(*) AS cnt FROM visitor_sessions WHERE DATE(started_at) = CURDATE()');
    const [[totalUsers]]   = await db.query('SELECT COUNT(*) AS cnt FROM users');
    const [[totalSurveys]] = await db.query('SELECT COUNT(*) AS cnt FROM surveys');
    const [[loginFails]]   = await db.query('SELECT COUNT(*) AS cnt FROM login_logs WHERE result = "fail" AND attempted_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)');

    const [deviceStats] = await db.query(
      'SELECT device_type, COUNT(*) AS cnt FROM visitor_sessions GROUP BY device_type'
    );
    const [hourlyStats] = await db.query(
      'SELECT HOUR(started_at) AS hr, COUNT(*) AS cnt FROM visitor_sessions WHERE started_at > DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY hr ORDER BY hr'
    );

    const deviceSummary = deviceStats
      .map(d => `  • ${d.device_type}: ${d.cnt}명`)
      .join('\n');

    await tg.sendTelegram(
      `📊 <b>통계 조회됨</b>\n` +
      `👥 총 방문: <b>${totalVisits.cnt}회</b>  |  오늘: <b>${todayVisits.cnt}회</b>\n` +
      `👤 가입자: <b>${totalUsers.cnt}명</b>  |  설문: <b>${totalSurveys.cnt}건</b>\n` +
      `⚠️ 24h 로그인 실패: <b>${loginFails.cnt}회</b>\n` +
      `📱 디바이스 현황:\n${deviceSummary}\n` +
      `🕐 ${now()}`
    );

    res.json({
      success: true,
      stats: {
        totalVisits:  totalVisits.cnt,
        todayVisits:  todayVisits.cnt,
        totalUsers:   totalUsers.cnt,
        totalSurveys: totalSurveys.cnt,
        loginFails24h: loginFails.cnt,
        deviceStats,
        hourlyStats,
      }
    });
  } catch (err) {
    console.error('[Log/Stats]', err);
    res.status(500).json({ success: false });
  }
});

// ─── GET /api/log/visitors - 방문자 목록 (관리자) ────────
router.get('/visitors', verifyToken, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM visitor_sessions ORDER BY started_at DESC LIMIT 200'
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('[Log/Visitors]', err);
    res.status(500).json({ success: false });
  }
});

// ─── 내부 헬퍼 ───────────────────────────────────────────
function now() {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

module.exports = router;
