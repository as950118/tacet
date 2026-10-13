# 배포: Supabase + Koyeb + Vercel

```
 로컬 (tacet index / extract-backend) ──▶ Supabase (PostgreSQL, index DB)
                                                 ▲
 Vercel (web/, 대시보드) ──서버 측──▶ Koyeb (tacet serve --read-only) ─┘
```

- **데이터는 로컬에서 만든다.** 소스 코드와 Java는 로컬에만 있으면 된다. CLI가 Supabase에 직접 쓴다.
- **Koyeb**은 조회 API만 제공한다. 이미지 기본값이 `TACET_READ_ONLY=true`라서 인덱싱·삭제 요청은 403으로 거부한다.
- **Vercel** 대시보드는 서버에서 Koyeb을 호출한다. API 토큰은 브라우저로 가지 않는다.

## 1. Supabase

1. 프로젝트를 만든 뒤 **Connect → Session pooler** 연결 문자열을 복사한다.
   - 형식: `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
   - **Transaction pooler(6543)는 쓰지 않는다.** tacet은 연결마다 `search_path`를 지정하는데, transaction pooler에서는 이 설정이 유지되지 않는다. 6543 포트를 쓰면 시작할 때 오류를 낸다.
   - Direct 연결은 IPv6 전용이라 Koyeb이나 일부 로컬 네트워크에서 접속되지 않을 수 있다.
2. tacet 테이블은 `tacet` 스키마에 생긴다(`?schema=` 파라미터로 변경 가능). Supabase가 쓰는 `public` 스키마와 섞이지 않는다.
3. **SSL:** pg 8.x는 `sslmode=require`를 인증서 검증(verify-full)으로 처리한다. Supabase 인증서는 Supabase 자체 CA로 서명되어 있어, 그대로 쓰면 검증에 실패한다. 둘 중 하나를 고른다.
   - 권장: Database Settings → SSL Configuration에서 CA 인증서를 받아 `TACET_PG_CA` 환경변수에 PEM 내용 그대로 넣는다. 한 줄로 넣어야 하면 줄바꿈을 `\n`으로 바꿔도 된다. 이 변수가 있으면 URL의 `sslmode`·`sslrootcert`는 무시된다.
   - 간단히: URL 끝에 `?sslmode=no-verify`를 붙인다. 연결은 암호화되지만 서버 인증서는 검증하지 않는다.
4. **용량:** CMP400 같은 대형 frontend(파일 7.5k개)는 앱 하나당 약 180MB를 쓴다. Free 플랜(500MB)에는 앱 2개 정도만 들어간다. 재인덱싱하면 dead tuple이 쌓이므로 여유가 없으면 SQL Editor에서 `VACUUM FULL`을 실행한다.

## 2. 로컬에서 데이터 넣기

```bash
export TACET_INDEX='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres'
export TACET_PG_CA="$(cat ~/Downloads/prod-ca-2021.crt)"     # 또는 URL에 ?sslmode=no-verify

tacet -p cmp400-admin -c ./tacet.admin.json index ../CMP400-frontend
tacet -p cmp400-admin extract-backend ../CMP400-backend        # Java 17+
tacet -p cmp400-user  -c ./tacet.user.json  index ../CMP400-frontend
tacet -p cmp400-user  extract-backend ../CMP400-backend
tacet projects
```

- 다시 실행하면 바뀐 레코드만 다시 쓴다.
- 기존 `.tacet/index.db`(SQLite)를 복사하는 기능은 없다. 위 명령으로 Supabase에 다시 인덱싱한다.
- 프로젝트를 지우려면 로컬에서 같은 `TACET_INDEX`로 `tacet serve`를 띄우고 `DELETE /projects/<p>`를 호출한다(Koyeb은 읽기 전용).

## 3. Koyeb (API)

**Create Web Service → GitHub** → 이 저장소를 선택한다.

| 항목 | 값 |
|---|---|
| Builder | **Dockerfile** (저장소 루트 `Dockerfile`) |
| Exposed port | `8000` (HTTP), Route `/` |
| Health check | HTTP `GET /health`, port 8000 |
| Instance | 가장 작은 인스턴스로 충분. 대형 프로젝트의 `/unused`·`/pages`는 요청할 때 계산하므로 메모리 512MB 이상 권장 |

환경변수는 모두 **Secret**으로 넣는다.

| 이름 | 값 |
|---|---|
| `TACET_INDEX` | 1단계의 Session pooler URL |
| `TACET_PG_CA` | CA 인증서 PEM(또는 URL에 `sslmode=no-verify`) |
| `TACET_API_TOKEN` | `openssl rand -hex 32`로 만든 임의 문자열. 0.0.0.0에서 띄우므로 반드시 설정한다 |

배포 후 확인:

```bash
curl https://<app>.koyeb.app/health                                   # {"status":"ok","readOnly":true,...}
curl -H "Authorization: Bearer $TOKEN" https://<app>.koyeb.app/projects
```

로컬에서 이미지를 확인하려면:

```bash
docker build -t tacet-api .
docker run -p 8000:8000 -e TACET_INDEX=... -e TACET_API_TOKEN=... tacet-api
```

## 4. Vercel (대시보드)

**Add New Project** → 이 저장소 → **Root Directory: `web`**. 프레임워크(Next.js)는 자동으로 인식된다.

| 환경변수 | 값 |
|---|---|
| `TACET_API_URL` | `https://<app>.koyeb.app` |
| `TACET_API_TOKEN` | Koyeb과 같은 토큰 |
| `DASHBOARD_PASSWORD` | 대시보드 전체 HTTP Basic 인증. 비워두면 URL을 아는 누구나 볼 수 있다 |
| `DASHBOARD_USER` | 선택. 기본값 `tacet` |

대시보드 기능:

- 프로젝트 목록
- **API 사용 현황**
  - 미사용 / client 선언만 / 전체로 범위 선택
  - path 단계별 드롭다운 필터, method, 검색
  - 지금 보이는 행을 `path_1..n` 컬럼과 함께 CSV로 다운로드
- **페이지 ↔ API**
  - 페이지별 호출 API, 공통 API 숨기기
  - 페이지별 관계 그래프(ontology HTML) 열기

전체 ontology HTML은 대형 프로젝트에서 수십 MB라서 Vercel 함수 응답 한도를 넘는다. 그래서 대시보드는 페이지 단위(`focus`)로만 연다. 전체는 로컬에서 `tacet ontology -f html`로 본다.

로컬 개발:

```bash
cd web && npm install
TACET_API_URL=http://localhost:4318 npm run dev
```
