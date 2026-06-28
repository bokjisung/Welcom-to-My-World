// backend/utils/telegram.js — 텔레그램 알림 유틸
const fetch = require('node-fetch');
const pool  = require('../db/pool');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const API_URL   = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

/**
 * 텔레그램 메시지 전송
 * @param {string} message - Markdown 지원 메시지
 * @param {string} eventType - 이벤트 유형 (로그용)
 */
async function sendTelegram(message, eventType = 'general') {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[Telegram] BOT_TOKEN 또는 CHAT_ID 미설정');
    return;
  }

  let status = 'sent';
  let errorMsg = null;

  try {
    const res = await fetch(API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    CHAT_ID,
        text:       message,
        parse_mode: 'Markdown',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body}`);
    }

    console.log(`[Telegram] 알림 전송 성공: ${eventType}`);
  } catch (err) {
    status   = 'failed';
    errorMsg = err.message;
    console.error('[Telegram] 전송 실패:', err.message);
  }

  // 발송 로그 저장
  try {
    await pool.execute(
      `INSERT INTO notification_logs (channel, event_type, message, status, error_msg)
       VALUES ('telegram', ?, ?, ?, ?)`,
      [eventType, message, status, errorMsg]
    );
  } catch (dbErr) {
    console.error('[Telegram] 로그 저장 실패:', dbErr.message);
  }
}

// ─── 이벤트별 알림 메시지 생성 ───────────────────────────

function notifyNewUser(username) {
  return sendTelegram(
    `🎉 *신규 회원 가입*\n` +
    `👤 아이디: \`${username}\`\n` +
    `🕐 시간: ${now()}`,
    'new_user'
  );
}

function notifyNewSurvey(sessionId, userId) {
  return sendTelegram(
    `📋 *신규 설문 응답*\n` +
    `🔑 세션: \`${sessionId.slice(0, 8)}...\`\n` +
    `👤 회원: ${userId ? `ID ${userId}` : '비회원'}\n` +
    `🕐 시간: ${now()}`,
    'new_survey'
  );
}

function notifyAdminLogin(username, ip) {
  return sendTelegram(
    `🔐 *관리자 로그인*\n` +
    `👤 아이디: \`${username}\`\n` +
    `🌐 IP: \`${ip}\`\n` +
    `🕐 시간: ${now()}`,
    'admin_login'
  );
}

function notifyFailedLogin(username, ip, count) {
  return sendTelegram(
    `⚠️ *비정상 로그인 시도*\n` +
    `👤 아이디: \`${username}\`\n` +
    `🌐 IP: \`${ip}\`\n` +
    `🔢 연속 실패: *${count}회*\n` +
    `🕐 시간: ${now()}`,
    'failed_login'
  );
}

function notifyServerError(error) {
  return sendTelegram(
    `🚨 *서버 오류 발생*\n` +
    `\`\`\`${String(error).slice(0, 300)}\`\`\`\n` +
    `🕐 시간: ${now()}`,
    'server_error'
  );
}

function notifyHighTraffic(visitorCount) {
  return sendTelegram(
    `📈 *방문자 급증*\n` +
    `👥 최근 1시간 방문자: *${visitorCount}명*\n` +
    `🕐 시간: ${now()}`,
    'high_traffic'
  );
}

function now() {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

module.exports = {
  sendTelegram,
  notifyNewUser,
  notifyNewSurvey,
  notifyAdminLogin,
  notifyFailedLogin,
  notifyServerError,
  notifyHighTraffic,
};
