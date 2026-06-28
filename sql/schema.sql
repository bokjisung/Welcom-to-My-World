-- ============================================================
-- HJS Dashboard - Database Schema  (v2 - 설문 6문항 반영)
-- Engine: MySQL 8.0+  /  Charset: utf8mb4
-- ============================================================

CREATE DATABASE IF NOT EXISTS hjs_db
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE hjs_db;

-- ─────────────────────────────────────────────
-- [1] 회원 테이블
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  nickname      VARCHAR(50)  DEFAULT NULL UNIQUE,  -- 표시용 닉네임 (중복 불가)
  email         VARCHAR(100) DEFAULT NULL UNIQUE,
  role          ENUM('admin','user') DEFAULT 'user',
  is_active     TINYINT(1)   DEFAULT 1,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 기존 DB에 users 테이블이 이미 있는 경우 아래 ALTER 문으로 컬럼 추가:
-- ALTER TABLE users ADD COLUMN nickname VARCHAR(50) DEFAULT NULL UNIQUE AFTER password_hash;

-- ─────────────────────────────────────────────
-- [2] JWT 블랙리스트 (로그아웃 토큰 무효화)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_blacklist (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  token_jti  VARCHAR(100) NOT NULL UNIQUE,
  expires_at DATETIME     NOT NULL,
  created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tb_expires (expires_at)   -- 만료 정리 DELETE 쿼리 풀스캔 방지
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- [3] 설문조사 응답 테이블  ★ 원본 6문항 완전 반영
--
--   Q1. 디자인이 촌스럽다고 생각하시나요?
--   Q2. 페이지 정보가 한눈에 잘 들어오나요?
--   Q3. 색상(보라색 톤) 배색이 마음에 드시나요?
--   Q4. 모바일에서도 사용하기 편리한가요?
--   Q5. 다시 이 페이지를 방문하고 싶으신가요?
--   Q6. 자유 의견 (선택 · textarea)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS surveys (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id       INT UNSIGNED DEFAULT NULL,
  session_id    VARCHAR(100) DEFAULT NULL,

  -- Q1 ~ Q5: 선택형 (매우 그렇다 / 그렇다 / 보통이다 / 아니다 / 매우 아니다)
  q1_design     VARCHAR(50)  DEFAULT NULL,   -- 디자인 촌스러움 여부
  q2_readability VARCHAR(50) DEFAULT NULL,   -- 정보 가독성
  q3_color      VARCHAR(50)  DEFAULT NULL,   -- 색상 만족도
  q4_mobile     VARCHAR(50)  DEFAULT NULL,   -- 모바일 편의성
  q5_revisit    VARCHAR(50)  DEFAULT NULL,   -- 재방문 의향

  -- Q6: 자유 의견 (textarea)
  q6_comment    TEXT         DEFAULT NULL,

  ip_address    VARCHAR(45)  DEFAULT NULL,
  user_agent    TEXT         DEFAULT NULL,
  submitted_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- [4] 방문자 세션 테이블
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visitor_sessions (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id      VARCHAR(100) NOT NULL UNIQUE,
  user_id         INT UNSIGNED DEFAULT NULL,
  ip_address      VARCHAR(45)  DEFAULT NULL,
  user_agent      TEXT         DEFAULT NULL,
  browser         VARCHAR(50)  DEFAULT NULL,
  os              VARCHAR(50)  DEFAULT NULL,
  device_type     ENUM('desktop','mobile','tablet','bot','unknown') DEFAULT 'unknown',
  country         VARCHAR(50)  DEFAULT NULL,
  city            VARCHAR(50)  DEFAULT NULL,
  referer         TEXT         DEFAULT NULL,
  utm_source      VARCHAR(100) DEFAULT NULL,
  utm_medium      VARCHAR(100) DEFAULT NULL,
  utm_campaign    VARCHAR(100) DEFAULT NULL,
  is_first_visit  TINYINT(1)   DEFAULT 1,
  visit_count     INT UNSIGNED DEFAULT 1,
  is_logged_in    TINYINT(1)   DEFAULT 0,
  started_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
  ended_at        DATETIME     DEFAULT NULL,
  duration_sec    INT UNSIGNED DEFAULT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- [5] 페이지 뷰 로그 테이블
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS page_views (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id  VARCHAR(100) NOT NULL,
  user_id     INT UNSIGNED DEFAULT NULL,
  page_url    VARCHAR(500) DEFAULT NULL,
  page_title  VARCHAR(200) DEFAULT NULL,
  referer     TEXT         DEFAULT NULL,
  time_spent  INT UNSIGNED DEFAULT NULL,
  visited_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- [6] 이벤트 로그 테이블 (클릭·스크롤)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_logs (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id   VARCHAR(100) NOT NULL,
  user_id      INT UNSIGNED DEFAULT NULL,
  event_type   VARCHAR(50)  DEFAULT NULL,
  element_id   VARCHAR(100) DEFAULT NULL,
  element_text VARCHAR(200) DEFAULT NULL,
  page_url     VARCHAR(500) DEFAULT NULL,
  scroll_pct   TINYINT UNSIGNED DEFAULT NULL,
  extra_data   JSON         DEFAULT NULL,
  created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- [7] 로그인 시도 로그 테이블
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_logs (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username     VARCHAR(50)  DEFAULT NULL,
  user_id      INT UNSIGNED DEFAULT NULL,
  ip_address   VARCHAR(45)  DEFAULT NULL,
  user_agent   TEXT         DEFAULT NULL,
  result       ENUM('success','fail') NOT NULL,
  fail_reason  VARCHAR(100) DEFAULT NULL,
  attempted_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- [8] 알림 로그 테이블
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_logs (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  channel     ENUM('telegram','discord','email','sms') DEFAULT 'telegram',
  event_type  VARCHAR(100) DEFAULT NULL,
  message     TEXT         DEFAULT NULL,
  status      ENUM('sent','failed') DEFAULT 'sent',
  error_msg   TEXT         DEFAULT NULL,
  sent_at     DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- 인덱스
-- ─────────────────────────────────────────────
CREATE INDEX idx_vs_ip        ON visitor_sessions(ip_address);
CREATE INDEX idx_vs_started   ON visitor_sessions(started_at);
CREATE INDEX idx_pv_session   ON page_views(session_id);
CREATE INDEX idx_pv_visited   ON page_views(visited_at);
CREATE INDEX idx_el_session   ON event_logs(session_id);
CREATE INDEX idx_el_type      ON event_logs(event_type);
CREATE INDEX idx_ll_ip        ON login_logs(ip_address);
CREATE INDEX idx_ll_attempted ON login_logs(attempted_at);
-- ⑤ 실패 카운트 쿼리 (ip + result + attempted_at) 복합 인덱스
CREATE INDEX idx_ll_ip_result ON login_logs(ip_address, result, attempted_at);
CREATE INDEX idx_sv_submitted ON surveys(submitted_at);
CREATE INDEX idx_nl_status    ON notification_logs(status);

-- ─────────────────────────────────────────────
-- 기존 DB에 이미 surveys 테이블이 있을 경우
-- 아래 ALTER 문으로 컬럼 추가 (신규 설치 시 불필요)
-- ─────────────────────────────────────────────
-- ALTER TABLE surveys
--   CHANGE q1_purpose   q1_design      VARCHAR(50)  DEFAULT NULL,
--   CHANGE q2_frequency q2_readability VARCHAR(50)  DEFAULT NULL,
--   CHANGE q3_device    q3_color       VARCHAR(50)  DEFAULT NULL,
--   CHANGE q4_feedback  q4_mobile      VARCHAR(50)  DEFAULT NULL,
--   ADD COLUMN q5_revisit  VARCHAR(50) DEFAULT NULL AFTER q4_mobile,
--   ADD COLUMN q6_comment  TEXT        DEFAULT NULL AFTER q5_revisit;
