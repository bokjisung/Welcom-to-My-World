# HJS Dashboard — 백엔드 가이드 v1.1

> **Node.js + Express + MySQL** 기반 개인 대시보드  
> 방문자 추적 · 설문 · 로그인/회원가입 · 텔레그램 알림 통합

---

## 📁 프로젝트 구조

```
HJS-BackEnd/
├── backend/
│   ├── config/
│   │   ├── db.js          # MySQL 커넥션 풀 (단일 인스턴스)
│   │   └── telegram.js    # 텔레그램 알림 유틸리티
│   ├── db/
│   │   └── pool.js        # config/db.js re-export (동일 풀)
│   ├── middleware/
│   │   └── auth.js        # JWT 검증 · signToken · EFFECTIVE_SECRET
│   ├── routes/
│   │   ├── auth.js        # 회원가입 · 로그인 · 로그아웃 · /me
│   │   ├── survey.js      # 설문 저장 · 조회
│   │   ├── log.js         # 방문자 세션 · 페이지뷰 · 이벤트 · 통계
│   │   └── visitor.js     # 방문자 세션 (카멜케이스 API)
│   ├── scripts/
│   │   └── initAdmin.js   # 관리자 계정 초기화 (1회 실행)
│   ├── server.js          # Express 앱 진입점
│   └── package.json       # 의존성 (Node >=18 명시)
├── frontend/              # HTML/CSS/JS 정적 파일
├── sql/
│   └── schema.sql         # 테이블 정의 + 인덱스
├── .env.example
├── .gitignore
└── README.md
```

---

## ✅ 보안 개선 이력 (v1.0 → v1.1)

| # | 항목 | 내용 |
|---|---|---|
| ① | DB 풀 중복 제거 | `config/db.js` 단일 인스턴스, `db/pool.js`는 re-export |
| ② | 회원가입 Rate Limiter | `/register` · `/login` 공통 10분/10회 제한 |
| ③ | 레이스 컨디션 차단 | 중복 확인 3쿼리 트랜잭션 + `FOR UPDATE` 락 |
| ④ | bcrypt 길이 제한 | 72자 초과 입력 차단 (CPU DoS 방지) |
| ⑤ | JWT_SECRET 폴백 차단 | `production` 환경에서 미설정 시 서버 강제 종료 |
| ⑥ | jti 포함 토큰 생성 | 로그아웃 블랙리스트 정상 작동 |
| ⑦ | SECRET 단일 관리 | `middleware/auth.js`에서만 선언, 나머지는 import |
| ⑧ | session_id 필수 검증 | `/session/end` 등에서 누락 시 400 반환 |
| ⑨ | fetch 일관성 | `visitor.js` 전역 fetch → `node-fetch`로 통일 |
| ⑩ | 텔레그램 실패 로깅 | 발송 실패 시 `notification_logs`에 `failed` 기록 |
| ⑪ | 로그인 성공 시 실패기록 초기화 | 텔레그램 알림 오탐 방지 |
| ⑫ | `requireAdmin` 미들웨어 통일 | 인라인 role 체크 → 미들웨어로 일원화 |
| ⑬ | bcrypt 트랜잭션 밖으로 이동 | 락 보유 시간 최소화 (동시성 개선) |
| ⑭ | DB 인덱스 추가 | `token_blacklist(expires_at)`, `login_logs(ip, result, attempted_at)` |
| ⑮ | Node 버전 명시 | `package.json engines: ">=18.0.0"` |

---

## ⚙️ 전체 동작 흐름

```
Client
  │
  ▼
server.js  ─── CORS · JSON · 정적파일 서빙
  │
  ├─ /api/auth/*    ─── authLimiter → routes/auth.js
  │                       회원가입(트랜잭션+bcrypt) · 로그인 · 로그아웃 · /me
  │
  ├─ /api/survey/*  ─── routes/survey.js
  │                       POST: 비로그인도 허용 · GET: verifyToken + requireAdmin
  │
  ├─ /api/log/*     ─── routes/log.js
  │                       세션시작·종료 · 페이지뷰 · 이벤트 · 통계(관리자)
  │
  └─ /api/visitor/* ─── routes/visitor.js
                          세션시작·종료 · 페이지뷰 · 이벤트 · 통계(관리자)

모든 라우터 → config/db.js (단일 풀) → MySQL
주요 이벤트 → config/telegram.js → Telegram Bot API
                  └ 성공/실패 모두 notification_logs에 기록

server.js setInterval(6h)
  └ token_blacklist 만료 행 자동 삭제 (idx_tb_expires 인덱스 활용)
```

---

## 🚀 빠른 시작

### STEP 0 — 준비물

| 항목 | 버전 | 필수 여부 |
|---|---|---|
| Node.js | **v18 이상** | ✅ 필수 |
| MySQL | 8.0+ 또는 MariaDB | ✅ 필수 |
| 텔레그램 계정 | — | ✅ 필수 |
| 원격 서버 | — | 🔵 선택 |

```bash
node -v   # v18.x.x 이상 확인
npm -v
```

> ⚠️ Node.js 17 이하는 내장 `fetch`가 없어 동작하지 않습니다.  
> https://nodejs.org 에서 LTS 버전을 설치하세요.

---

### STEP 1 — DB 생성

```sql
mysql -u root -p

CREATE DATABASE hjs_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'hjs_user'@'localhost' IDENTIFIED BY '비밀번호_여기';
GRANT ALL PRIVILEGES ON hjs_db.* TO 'hjs_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

```bash
# 테이블 + 인덱스 한번에 적용
mysql -u hjs_user -p hjs_db < sql/schema.sql
```

---

### STEP 2 — 텔레그램 봇 만들기

1. 텔레그램에서 **@BotFather** 검색 → `/newbot`
2. 봇 이름 · username 입력 → **토큰 복사 보관**
3. **@userinfobot** 에서 `/start` → 내 Chat ID 확인
4. 만든 봇에게 먼저 `/start` 메시지 보내기 (안 하면 알림 안 옴)

---

### STEP 3 — .env 설정

```bash
cd backend
cp ../.env.example .env
```

```dotenv
PORT=3000
NODE_ENV=development

DB_HOST=localhost
DB_PORT=3306
DB_NAME=hjs_db
DB_USER=hjs_user
DB_PASS=STEP1에서_설정한_비밀번호

# ⚠️ 반드시 32자 이상의 랜덤 문자열로 설정
# production 환경에서 미설정 시 서버가 시작되지 않습니다
JWT_SECRET=여기에_32자_이상_랜덤_문자열_예시hjs2026secretkeyabcdef
JWT_EXPIRES_IN=7d

TELEGRAM_BOT_TOKEN=STEP2에서_받은_토큰
TELEGRAM_CHAT_ID=STEP2에서_확인한_숫자ID

FRONTEND_URL=http://localhost:3000

ADMIN_USERNAME=admin
ADMIN_PASSWORD=강한_비밀번호_8자이상
```

> ⚠️ `.env` 파일은 절대 GitHub에 올리지 마세요 (`.gitignore`에 포함됨)

---

### STEP 4 — 설치 및 실행

```bash
cd backend
npm install

# 관리자 계정 생성 (최초 1회만)
node scripts/initAdmin.js

# 개발 서버 (파일 변경 시 자동 재시작)
npm run dev

# 운영 서버
npm start
```

성공 메시지:
```
[DB] MySQL 연결 성공
[Server] http://localhost:3000 (NODE_ENV=development)
```

---

## 🔐 API 엔드포인트

### 인증 (`/api/auth`)

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/register` | ❌ | 회원가입 (Rate Limit: 10분/10회) |
| POST | `/login` | ❌ | 로그인 → JWT 반환 (Rate Limit: 10분/10회) |
| POST | `/logout` | ✅ Bearer | JWT 블랙리스트 등록 |
| GET | `/me` | ✅ Bearer | 내 정보 조회 |

**회원가입 규칙**
- 비밀번호: 8자 이상 72자 이하
- 닉네임: 2자 이상
- 이메일: 형식 검사 (선택)
- 동시 가입 시 레이스 컨디션 트랜잭션으로 차단

### 설문 (`/api/survey`)

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/` | ❌ (선택) | 설문 응답 저장 (비로그인 허용) |
| GET | `/` | ✅ Admin | 설문 목록 조회 |

**6문항 필드명**

```json
{
  "q1_design":      "예 / 아니오",
  "q2_readability": "예 / 아니오",
  "q3_color":       "예 / 아니오",
  "q4_mobile":      "예 / 아니오",
  "q5_revisit":     "예 / 아니오",
  "q6_comment":     "자유 의견 (선택)"
}
```

### 방문자 로그 (`/api/log`, `/api/visitor`)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/log/session` | 세션 시작 (UA 파싱, 텔레그램 알림) |
| POST | `/api/log/session/end` | 세션 종료 (체류시간 저장) |
| POST | `/api/log/pageview` | 페이지뷰 기록 |
| POST | `/api/log/event` | 클릭·스크롤 이벤트 기록 |
| GET | `/api/log/stats` | 통계 요약 (관리자) |
| GET | `/api/log/visitors` | 방문자 목록 (관리자) |
| POST | `/api/visitor/session/start` | 세션 시작 (카멜케이스) |
| POST | `/api/visitor/session/end` | 세션 종료 (카멜케이스) |
| GET | `/api/visitor/stats` | 통계 (관리자) |

---

## 🗄️ DB 테이블 구조

| 테이블 | 설명 | 주요 인덱스 |
|---|---|---|
| `users` | 회원 정보 | `username(UNIQUE)`, `nickname(UNIQUE)`, `email(UNIQUE)` |
| `token_blacklist` | 로그아웃 토큰 | `token_jti(UNIQUE)`, `expires_at` ← **6h마다 자동 정리** |
| `login_logs` | 로그인 이력 | `ip_address`, `(ip, result, attempted_at)` 복합 인덱스 |
| `visitor_sessions` | 방문자 세션 | `ip_address`, `started_at` |
| `page_views` | 페이지뷰 | `session_id`, `visited_at` |
| `event_logs` | 클릭·스크롤 | `session_id`, `event_type` |
| `surveys` | 설문 응답 | `submitted_at` |
| `notification_logs` | 텔레그램 발송 이력 | `status` — 실패 시 `error_msg` 기록 |

---

## ☁️ 배포 (Railway 기준)

1. https://railway.app 가입 (GitHub 로그인)
2. New Project → Deploy from GitHub repo
3. MySQL 서비스 추가 → 연결 정보 자동 제공
4. Variables 탭에서 `.env` 값 입력
   - `NODE_ENV=production` 으로 변경
   - `FRONTEND_URL=https://실제주소.railway.app`
   - `JWT_SECRET` 반드시 32자 이상 랜덤 문자열
5. 자동 배포 → 도메인 발급

### 배포 전 체크리스트

```
□ NODE_ENV=production
□ JWT_SECRET 32자 이상 랜덤 문자열
□ DB_PASS 강한 비밀번호
□ TELEGRAM_BOT_TOKEN / CHAT_ID 설정
□ FRONTEND_URL 실제 배포 주소
□ .env 파일 GitHub에 없는지 확인
□ node scripts/initAdmin.js 실행 완료
```

---

## 🔧 PM2 영구 실행 (직접 서버 운영 시)

```bash
npm install -g pm2
cd backend
pm2 start server.js --name hjs
pm2 startup
pm2 save

# 로그 확인
pm2 logs hjs
# 재시작
pm2 restart hjs
```

---

## 🛠️ 문제 해결

| 증상 | 원인 | 해결 |
|---|---|---|
| `[DB] MySQL 연결 실패` | DB_PASS 틀림 또는 MySQL 미실행 | MySQL 서비스 시작, `.env` 확인 |
| `[FATAL] JWT_SECRET 미설정` | production에서 JWT_SECRET 없음 | `.env`에 32자 이상 문자열 설정 |
| 텔레그램 알림 안 옴 | BOT_TOKEN/CHAT_ID 오류 | 봇에게 `/start` 먼저 보냈는지 확인 |
| 로그인 후 401 반환 | JWT_SECRET 불일치 또는 토큰 만료 | `.env` JWT_SECRET 확인 |
| CORS 오류 | FRONTEND_URL 불일치 | 실제 서버 주소로 FRONTEND_URL 수정 |
| `npm install` 오류 | Node.js 버전 낮음 (17 이하) | `node -v` 확인 후 v18 이상으로 업그레이드 |
| 회원가입 429 Too Many Requests | Rate Limiter 작동 중 | 10분 후 재시도 |

---

## 📂 GitHub 업로드 기준

| 파일/폴더 | 업로드 | 이유 |
|---|---|---|
| `.env` | ❌ | 비밀번호·토큰 포함 |
| `.env.example` | ✅ | 값 없는 템플릿 |
| `sql/schema.sql` | ✅ | 구조만 있고 데이터 없음 |
| `node_modules/` | ❌ | `npm install`로 복원 가능 |
| `*.sql.bak` | ❌ | 실제 데이터 포함 가능 |
| 소스코드 전체 | ✅ | `.env` 분리로 안전 |

---

## 📊 데이터 확인 방법

### DBeaver (무료, 추천)
1. https://dbeaver.io 설치
2. MySQL 연결 → `localhost:3306 / hjs_db`
3. 테이블 우클릭 → View Data

### 터미널 직접 조회
```sql
mysql -u hjs_user -p hjs_db

-- 설문 응답
SELECT * FROM surveys ORDER BY submitted_at DESC;

-- 오늘 방문자
SELECT COUNT(*) FROM visitor_sessions WHERE DATE(started_at) = CURDATE();

-- 로그인 실패 이력
SELECT * FROM login_logs WHERE result = 'fail' ORDER BY attempted_at DESC LIMIT 20;

-- 텔레그램 발송 실패 이력
SELECT * FROM notification_logs WHERE status = 'failed' ORDER BY sent_at DESC;
```
