// ============================================================
// server.js - Express 메인 서버
// ============================================================
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const authRouter    = require('./routes/auth');
const surveyRouter  = require('./routes/survey');
const logRouter     = require('./routes/log');
const visitorRouter = require('./routes/visitor');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS 설정 ─────────────────────────────────────────────
const allowedOrigin = process.env.NODE_ENV === 'production'
  ? process.env.FRONTEND_URL
  : '*';

app.use(cors({
  origin: allowedOrigin,
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 프론트엔드 정적 파일 서빙
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ── API 라우터 ──────────────────────────────────────────────
app.use('/api/auth',    authRouter);
app.use('/api/survey',  surveyRouter);
app.use('/api/log',     logRouter);
app.use('/api/visitor', visitorRouter);

// ── 헬스체크 ───────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ ok: true, env: process.env.NODE_ENV, time: new Date().toISOString() })
);

// ── 404 ────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ success: false, message: 'Not Found' })
);

// ── 전역 에러 핸들러 ────────────────────────────────────────
app.use(async (err, req, res, next) => {
  console.error('[Server Error]', err);
  try {
    const tg = require('./config/telegram');
    await tg.notifyError(err.message);
  } catch (_) {}
  res.status(500).json({ success: false, message: '서버 내부 오류' });
});

// ── 만료된 JWT 블랙리스트 자동 정리 (6시간마다) ─────────────
const db = require('./config/db');
setInterval(async () => {
  try {
    const [result] = await db.query(
      'DELETE FROM token_blacklist WHERE expires_at < NOW()'
    );
    if (result.affectedRows > 0) {
      console.log(`[Cleanup] 만료 토큰 ${result.affectedRows}건 삭제`);
    }
  } catch (err) {
    console.error('[Cleanup] 토큰 블랙리스트 정리 실패:', err.message);
  }
}, 6 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`[Server] http://localhost:${PORT} (NODE_ENV=${process.env.NODE_ENV})`);
});
