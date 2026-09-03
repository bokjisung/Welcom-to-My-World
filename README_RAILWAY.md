# 가배 발주품 관리 — Railway 운영 배포판

이 폴더는 **Railway에 실제 배포해 여러 사용자가 같은 발주 데이터를 공유**하도록 만든 운영용 버전입니다.

## 1. 이 버전에서 해결한 핵심 문제

- Railway의 동적 `PORT` 사용: Gunicorn이 `0.0.0.0:$PORT`에 바인딩합니다.
- 영구 DB 저장: `RAILWAY_VOLUME_MOUNT_PATH`를 자동 감지하고 그 안에 `gabae.db`를 저장합니다.
- Volume 누락 방지: Railway에서 Volume 없이 실행하면 기본적으로 시작을 중단하여 재배포 후 데이터 유실을 막습니다.
- 공개 URL 보안: Railway에서는 기본적으로 `GABAE_AUTH_PASSWORD`가 없으면 시작하지 않습니다.
- 사진 저장 구조 개선: 사진 base64를 전체 JSON에 넣지 않고 `/data/images`에 별도 JPEG 파일로 저장합니다.
- 이전 DB 호환: 예전 DB 안의 base64 사진은 시작 시 Volume의 이미지 파일로 자동 이전합니다.
- 동시 수정 보호: 버전 번호가 다르면 HTTP 409로 충돌을 감지합니다.
- 저장 이력: 최근 100개 이전 상태를 `app_state_history`에 보관합니다.
- 서버 검증: 품목/사이트/수량/가격/날짜/사진 경로의 형식과 최대 크기를 서버에서도 검사합니다.
- 운영 서버: Python 개발용 `http.server` 대신 Flask + Gunicorn을 사용합니다.
- 배포 헬스체크: `/api/health`가 DB 접근과 저장 경로 상태를 확인합니다.
- 보안 헤더: CSP, nosniff, frame 차단, referrer 제한을 적용합니다.

## 2. Railway 배포 전 반드시 알아둘 점

### Volume은 필수

SQLite와 사진 파일은 컨테이너 임시 파일 시스템이 아니라 Railway Volume에 저장해야 합니다.

**Railway 서비스 → Volume 추가 → Mount Path를 `/data`로 설정**하세요.

앱은 Railway가 자동 제공하는 `RAILWAY_VOLUME_MOUNT_PATH` 값을 사용하므로 별도로 DB 경로 변수를 만들 필요가 없습니다.

### Replica는 1개만 사용

Railway Volume은 replicas와 함께 사용할 수 없습니다. 이 앱은 **1 서비스 + 1 replica + 1 Volume** 구성을 전제로 합니다.

SQLite 기반이므로 사용자가 크게 늘어 여러 replica가 필요한 규모가 되면 PostgreSQL + Object Storage 구조로 이전하는 것이 맞습니다.

### 공개 배포에는 암호 필수

Railway Variables에 다음을 설정하세요.

```text
GABAE_AUTH_USERNAME=gabae
GABAE_AUTH_PASSWORD=충분히_긴_임의의_암호
```

브라우저에서 Railway 주소에 접속하면 기본 로그인 창이 뜹니다. 여러 사용자가 같은 아이디와 암호를 공유해 사용할 수 있습니다.

완전 공개 운영을 정말 원할 때만 아래 변수를 사용합니다.

```text
GABAE_ALLOW_PUBLIC=1
```

권장하지 않습니다.

## 3. 가장 안전한 Railway 배포 순서

1. 이 폴더의 **내용 전체**를 GitHub 저장소 루트에 올립니다.
2. Railway에서 `New Project` → `Deploy from GitHub repo`로 저장소를 선택합니다.
3. 첫 배포가 Volume/암호 미설정으로 실패해도 정상입니다. 데이터 유실 방지를 위한 fail-fast 동작입니다.
4. 해당 서비스에 **Volume**을 추가하고 Mount Path를 `/data`로 설정합니다.
5. 서비스 `Variables`에 아래 두 값을 추가합니다.
   - `GABAE_AUTH_USERNAME=gabae`
   - `GABAE_AUTH_PASSWORD=<긴 암호>`
6. 서비스 설정에서 **Healthcheck Path**를 `/api/health`로 지정합니다.
7. 서비스 설정의 Replica 수가 **1**인지 확인합니다.
8. 변경 사항을 Deploy/Redeploy 합니다.
9. `Settings` → `Networking` → `Generate Domain`으로 공개 주소를 만듭니다.
10. 생성된 `https://...up.railway.app` 주소에 접속해서 로그인합니다.
11. 품목 하나를 입력하고 `저장하기`를 누른 뒤, 다른 브라우저/휴대폰에서 같은 주소로 접속해 동일한 내용이 보이는지 확인합니다.
12. Railway에서 Redeploy 한 번 실행한 뒤에도 저장 내용과 사진이 그대로 남는지 마지막으로 확인합니다.

## 4. Railway 설정값

| 항목 | 값 |
|---|---|
| Build | Dockerfile 자동 감지 |
| Start | Dockerfile의 Gunicorn CMD 사용 |
| Port | Railway `PORT` 자동 사용 |
| Host | `0.0.0.0` |
| Healthcheck | `/api/health` |
| Volume mount | `/data` |
| Replica | 1 |
| DB | `/data/gabae.db` |
| Photos | `/data/images/*.jpg` |

`PORT`는 직접 만들지 마세요. Railway가 런타임에 제공합니다.

## 5. 왜 railway.json을 넣지 않았나

2026년 9월 현재 Railway 공식 문서에서 기존 Config as Code(`railway.json`, `railway.toml`)는 deprecated 상태이며, **새 서비스는 이 방식에 새로 opt-in할 수 없습니다**. 따라서 이 배포판은 오래된 `railway.json`에 의존하지 않습니다.

Dockerfile은 Railway가 자동 감지하고, Volume/Healthcheck/Variables/Domain은 Railway 대시보드에서 설정하는 방식으로 구성했습니다.

프로젝트 단위 Infrastructure as Code가 꼭 필요하면 Railway CLI의 `railway config init`으로 현재 프로젝트에 연결된 `.railway/railway.ts`를 생성하는 방식을 사용하세요. 이 파일은 프로젝트 리소스와 연결되는 설정이므로 범용 ZIP에 임의 ID를 넣지 않았습니다.

## 6. 로컬 실행

Windows:

```text
start_windows.bat
```

macOS / Linux:

```bash
./start_mac_linux.sh
```

기본 주소:

```text
http://localhost:8000
```

로컬에서는 Railway가 아니므로 암호가 없어도 실행됩니다. 로컬에서도 암호를 쓰려면 `GABAE_AUTH_PASSWORD`를 환경 변수로 설정하세요.

## 7. DB와 사진 백업

실제 운영 데이터는 `/data` Volume에 있습니다.

- DB: `/data/gabae.db`
- 사진: `/data/images/`

Railway Volume 백업 기능을 사용하는 것을 권장합니다. 또한 Railway CLI의 Volume 파일 관리 명령으로 별도 복사본을 내려받을 수 있습니다.

DB 안에는 최근 100개 이전 상태가 `app_state_history`에 저장되므로 단순 오조작 복구에 도움이 됩니다. 다만 이것은 Volume 자체가 손상/삭제되는 상황의 백업을 대신하지 않습니다.

## 8. 운영 규모의 한계

이 버전은 카페/매장/소규모 팀처럼 **소수 사용자가 하나의 공용 발주판을 공유하는 용도**에 맞습니다.

다음 조건이 필요해지면 SQLite 구조를 PostgreSQL로 바꾸는 것을 권장합니다.

- 여러 replica 필요
- 수십~수백 명의 상시 동시 편집
- 사용자별 계정/권한/감사 로그 필요
- 대량 사진/파일 보관
- 다수 매장별 데이터 분리

## 9. 비상 옵션

아래 옵션은 안전장치를 끄므로 일반 운영에서는 사용하지 마세요.

```text
GABAE_ALLOW_EPHEMERAL=1   # Railway에서 Volume 없이 임시 저장 허용
GABAE_ALLOW_PUBLIC=1      # Railway에서 암호 없이 공개 허용
```

## 10. 배포 후 확인 주소

로그인 없이 확인 가능한 Healthcheck:

```text
https://<도메인>/api/health
```

정상 예:

```json
{
  "ok": true,
  "database": "gabae.db",
  "persistentVolume": true,
  "storage": "/data"
}
```

`persistentVolume`이 `false`이면 운영 완료로 보지 마세요.
