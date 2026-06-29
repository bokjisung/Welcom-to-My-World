// ============================================================
// config/db.js - MySQL 커넥션 풀 (단일 인스턴스)
// ※ 이 파일이 프로젝트 전체의 유일한 DB 풀입니다.
//   db/pool.js 는 이 파일을 re-export 합니다.
// ============================================================
require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT) || 3306,
  database:           process.env.DB_NAME     || 'hjs_db',
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASS || process.env.DB_PASSWORD || '',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
  timezone:           '+09:00',
  charset:            'utf8mb4',
});

pool.getConnection()
  .then(conn => { console.log('[DB] MySQL 연결 성공'); conn.release(); })
  .catch(err  => { console.error('[DB] MySQL 연결 실패:', err.message); process.exit(1); });

module.exports = pool;
