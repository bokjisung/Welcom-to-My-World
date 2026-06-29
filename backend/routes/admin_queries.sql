-- ============================================================
-- 관리자용 SQL 조회 예시  (v2 - 6문항 반영)
-- ============================================================

-- ① 설문 응답 전체 조회 (6문항 컬럼 포함)
SELECT
  s.id,
  s.submitted_at,
  COALESCE(u.username, '비회원') AS 응답자,
  s.q1_design       AS Q1_디자인촌스러움,
  s.q2_readability  AS Q2_정보가독성,
  s.q3_color        AS Q3_색상만족도,
  s.q4_mobile       AS Q4_모바일편의성,
  s.q5_revisit      AS Q5_재방문의향,
  s.q6_comment      AS Q6_자유의견,
  s.ip_address
FROM surveys s
LEFT JOIN users u ON u.id = s.user_id
ORDER BY s.submitted_at DESC;

-- ② 문항별 응답 분포 (Q1 예시, 나머지도 동일 패턴으로 사용)
SELECT q1_design AS 응답, COUNT(*) AS 건수
FROM surveys
WHERE q1_design IS NOT NULL
GROUP BY q1_design
ORDER BY 건수 DESC;

-- ③ 오늘 방문자 수
SELECT COUNT(*) AS 오늘_방문자
FROM visitor_sessions
WHERE DATE(started_at) = CURDATE();

-- ④ 기기별 방문 비율
SELECT device_type AS 기기, COUNT(*) AS 방문수,
       ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER(), 1) AS 비율_pct
FROM visitor_sessions
GROUP BY device_type ORDER BY 방문수 DESC;

-- ⑤ 최근 7일 일별 방문자 추이
SELECT DATE(started_at) AS 날짜, COUNT(*) AS 방문자수
FROM visitor_sessions
WHERE started_at >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
GROUP BY DATE(started_at) ORDER BY 날짜;

-- ⑥ 로그인 실패 IP 상위 목록 (보안 감사)
SELECT ip_address, COUNT(*) AS 실패횟수, MAX(attempted_at) AS 마지막_시도
FROM login_logs
WHERE result = 'fail'
  AND attempted_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY ip_address HAVING 실패횟수 >= 3
ORDER BY 실패횟수 DESC;

-- ⑦ 설문 참여율 (방문자 대비)
SELECT
  (SELECT COUNT(*) FROM surveys) AS 설문_응답수,
  (SELECT COUNT(*) FROM visitor_sessions) AS 총_방문수,
  ROUND(
    (SELECT COUNT(*) FROM surveys) * 100.0 /
    NULLIF((SELECT COUNT(*) FROM visitor_sessions), 0), 1
  ) AS 참여율_pct;
