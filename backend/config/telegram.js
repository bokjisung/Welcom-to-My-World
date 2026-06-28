// ============================================================
// config/telegram.js  텔레그램 알림 유틸리티  (v2)
// ============================================================
require('dotenv').config();
const fetch = require('node-fetch');
const db    = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const BASE_URL  = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ④ sendTelegram 에러 시 notification_logs에 failed 상태 기록
async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[Telegram] BOT_TOKEN 또는 CHAT_ID 미설정 — 알림 생략');
    return;
  }

  let status = 'sent';
  let errorMsg = null;

  try {
    const res  = await fetch(`${BASE_URL}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    CHAT_ID,
        text:       message,
        parse_mode: 'HTML',
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      status   = 'failed';
      errorMsg = data.description || 'Telegram API error';
    }
  } catch (err) {
    status   = 'failed';
    errorMsg = err.message;
    console.error('[Telegram] 발송 실패:', err.message);
  }

  // ④ 발송 성공/실패 로그 저장 (error_msg 컬럼 포함)
  try {
    await db.query(
      'INSERT INTO notification_logs (channel, event_type, message, status, error_msg) VALUES (?, ?, ?, ?, ?)',
      ['telegram', 'generic', message.slice(0, 500), status, errorMsg]
    );
  } catch (dbErr) {
    // DB 저장 실패는 console 경고만 — 요청 흐름에 영향 없음
    console.warn('[Telegram] 로그 저장 실패:', dbErr.message);
  }
}

const now = () => new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

module.exports = {
  sendTelegram,

  // 신규 회원 가입
  notifySignup: (username, ip) =>
    sendTelegram(
      `🎉 <b>신규 회원 가입</b>\n` +
      `👤 ${username}\n` +
      `🌐 IP: <code>${ip}</code>\n` +
      `🕐 ${now()}`
    ),

  // 설문 응답 (6문항 요약 포함)
  notifySurvey: (displayName, answers = {}) =>
    sendTelegram(
      `📋 <b>신규 설문 응답</b>\n` +
      `👤 ${displayName}\n` +
      (answers.q1 ? `Q1 디자인: ${answers.q1}\n`   : '') +
      (answers.q2 ? `Q2 가독성: ${answers.q2}\n`   : '') +
      (answers.q3 ? `Q3 색상: ${answers.q3}\n`     : '') +
      (answers.q4 ? `Q4 모바일: ${answers.q4}\n`   : '') +
      (answers.q5 ? `Q5 재방문: ${answers.q5}\n`   : '') +
      (answers.q6 ? `Q6 의견: ${answers.q6.slice(0, 80)}\n` : '') +
      `🕐 ${now()}`
    ),

  // 관리자 로그인
  notifyAdminLogin: (username, ip) =>
    sendTelegram(
      `🔐 <b>관리자 로그인</b>\n` +
      `👤 ${username}\n` +
      `🌐 IP: <code>${ip}</code>\n` +
      `🕐 ${now()}`
    ),

  // 비정상 로그인 시도
  notifyFailedLogin: (username, ip, count) =>
    sendTelegram(
      `⚠️ <b>로그인 실패 ${count}회</b>\n` +
      `👤 ${username}\n` +
      `🌐 IP: <code>${ip}</code>\n` +
      `🕐 ${now()}`
    ),

  // 서버 오류
  notifyError: (msg) =>
    sendTelegram(
      `🚨 <b>서버 오류 발생</b>\n` +
      `${String(msg).slice(0, 300)}\n` +
      `🕐 ${now()}`
    ),
};
