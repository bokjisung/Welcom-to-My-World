// ============================================================
// tracker.js - 방문자 추적 / 로그 공통 모듈
// 모든 페이지에서 <script src="tracker.js"> 로 로드
// ============================================================
(function () {
  const API = 'http://welcom-to-my-world-production.up.railway.app/api';

  // ── 세션 ID 발급 (탭 단위 유지) ────────────────────────
  let sessionId = sessionStorage.getItem('_sid');
  if (!sessionId) {
    sessionId = 'sid_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    sessionStorage.setItem('_sid', sessionId);
  }

  // ── 방문 횟수 / 최초 방문 여부 (localStorage) ──────────
  let visitCount = parseInt(localStorage.getItem('_vc') || '0') + 1;
  const isFirst  = visitCount === 1;
  localStorage.setItem('_vc', visitCount);

  // ── UTM 파라미터 파싱 ────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const utmSource   = params.get('utm_source')   || null;
  const utmMedium   = params.get('utm_medium')   || null;
  const utmCampaign = params.get('utm_campaign') || null;

  // ── JWT 토큰 가져오기 ────────────────────────────────────
  function getToken() { return localStorage.getItem('hjs_token') || null; }
  function authHeader() {
    const t = getToken();
    return t ? { Authorization: 'Bearer ' + t } : {};
  }

  // ── 공통 fetch 래퍼 ─────────────────────────────────────
  function post(endpoint, body) {
    return fetch(API + endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body:    JSON.stringify(body),
    }).catch(() => {}); // 로그 실패가 UX를 깨지 않도록 조용히 처리
  }

  // ── 세션 시작 전송 ───────────────────────────────────────
  post('/log/session', {
    session_id:   sessionId,
    referer:      document.referrer || null,
    utm_source:   utmSource,
    utm_medium:   utmMedium,
    utm_campaign: utmCampaign,
    is_first_visit: isFirst,
    visit_count:  visitCount,
  });

  // ── 페이지뷰 전송 ────────────────────────────────────────
  post('/log/pageview', {
    session_id:  sessionId,
    page_url:    location.href,
    page_title:  document.title,
    referer:     document.referrer || null,
    time_spent:  0,
  });

  // ── 체류 시간 측정 후 세션 종료 전송 ─────────────────────
  const startTime = Date.now();
  function endSession() {
    const duration = Math.floor((Date.now() - startTime) / 1000);
    // sendBeacon은 페이지 언로드 시에도 신뢰성 있게 전송
    navigator.sendBeacon(
      API + '/log/session/end',
      JSON.stringify({ session_id: sessionId, duration_sec: duration })
    );
  }
  window.addEventListener('beforeunload', endSession);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') endSession();
  });

  // ── 버튼 클릭 이벤트 추적 ───────────────────────────────
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, a, [data-track]');
    if (!el) return;
    post('/log/event', {
      session_id:   sessionId,
      event_type:   'click',
      element_id:   el.id || null,
      element_text: (el.innerText || el.textContent || '').trim().slice(0, 100),
      page_url:     location.href,
    });
  });

  // ── 스크롤 깊이 추적 (25 / 50 / 75 / 100%) ──────────────
  const scrollMilestones = new Set();
  window.addEventListener('scroll', () => {
    const pct = Math.floor(
      ((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight) * 100
    );
    [25, 50, 75, 100].forEach((m) => {
      if (pct >= m && !scrollMilestones.has(m)) {
        scrollMilestones.add(m);
        post('/log/event', {
          session_id:  sessionId,
          event_type:  'scroll',
          scroll_pct:  m,
          page_url:    location.href,
        });
      }
    });
  }, { passive: true });

  // ── 전역 노출: 다른 스크립트에서 사용 가능 ───────────────
  window._tracker = { sessionId, getToken, authHeader, post, API };
})();
