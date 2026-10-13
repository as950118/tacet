# 배포: Supabase + Render + Vercel

```
 로컬 (tacet index / extract-backend) ──▶ Supabase (PostgreSQL, index DB)
                                                 ▲
 Vercel (web/, 대시보드) ──서버 측──▶ Render (tacet serve --read-only) ┘
```

- **데이터는 로컬에서 만든다.** 소스 코드와 Java는 로컬에만 있으면 된다. CLI가 Supabase에 직접 쓴다.
- **Render**는 조회 API만 제공한다. 이미지 기본값이 `TACET_READ_ONLY=true`라서 인덱싱·삭제 요청은 403으로 거부한다.
- **Vercel** 대시보드는 서버에서 Render의 API를 호출한다. API 토큰은 브라우저로 가지 않는다.

## 1. Supabase

1. 프로젝트를 만든 뒤 **Connect → Session pooler** 연결 문자열을 복사한다.
   - 형식: `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
   - **Transaction pooler(6543)는 쓰지 않는다.** tacet은 연결마다 `search_path`를 지정하는데, transaction pooler에서는 이 설정이 유지되지 않는다. 6543 포트를 쓰면 시작할 때 오류를 낸다.
   - Direct 연결은 IPv6 전용이라 Render 같은 호스트나 일부 로컬 네트워크에서 접속되지 않을 수 있다.
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
- `index`·`extract-backend`가 끝나면 페이지↔API 맵과 API 사용 현황을 미리 계산해 `snapshots` 테이블에 저장한다. 배포된 API는 이 결과를 그대로 돌려준다. CMP400 기준 응답 시간은 12초에서 0.1~0.4초로, 응답 크기는 1.6MB에서 gzip 100KB로 줄었다.
  - 이전 버전으로 넣은 데이터는 다시 인덱싱하지 않고 `tacet -p <name> snapshot`만 실행하면 된다.
  - 인덱싱 상태가 결과와 맞지 않으면 API가 직접 계산한다. 느리지만 틀린 결과를 주지는 않는다.
- 기존 `.tacet/index.db`(SQLite)를 복사하는 기능은 없다. 위 명령으로 Supabase에 다시 인덱싱한다.
- 프로젝트를 지우려면 로컬에서 같은 `TACET_INDEX`로 `tacet serve`를 띄우고 `DELETE /projects/<p>`를 호출한다(배포된 API는 읽기 전용).

## 3. Render (API)

저장소 루트의 `render.yaml`(Blueprint)이 서비스 설정을 담고 있다. 내용은 다음과 같다.
- Docker 빌드, free 플랜, Singapore 리전
- health check `/health`
- `main` 브랜치에 push되면 자동 배포

1. **New → Blueprint** → 이 저장소를 연결한다.
2. 입력란에 `TACET_INDEX`(1단계 Session pooler URL)를 넣는다. 다른 값은 Blueprint가 정한다.
   - `TACET_API_TOKEN`: 자동으로 생성된다. 서비스의 Environment 탭에서 복사해 Vercel에 넣는다.
   - `NODE_OPTIONS=--max-old-space-size=300`: free 인스턴스 메모리가 512MB이기 때문이다. 파일 7.5k개 규모의 프로젝트에서 최대 약 410MB를 쓴다.
   - SSL을 검증하려면 `TACET_PG_CA`를 추가한다. 넣지 않으면 URL의 `sslmode=no-verify`를 쓴다.
3. 포트는 Render가 주는 `$PORT`를 서버가 그대로 쓴다.

**Free 플랜 제약:** 15분 동안 요청이 없으면 서비스가 잠든다. 첫 요청은 깨어나는 데 1분 정도 걸리고, 대시보드도 그동안 기다린다.

대형 프로젝트의 `/unused`·`/pages`는 요청할 때 계산한다. 그래서 첫 조회는 5~10초 걸린다. 이후 같은 프로젝트를 조회할 때는 메모리에 남은 모델을 다시 쓴다.

배포 후 확인:

```bash
curl https://tacet-api.onrender.com/health                                   # {"status":"ok","readOnly":true,...}
curl -H "Authorization: Bearer $TOKEN" https://tacet-api.onrender.com/projects
```

Docker 이미지라서 다른 호스트(Fly.io, Railway, Koyeb, Cloud Run 등)에서도 같은 환경변수로 실행된다.

로컬에서 이미지를 확인하려면:

```bash
docker build -t tacet-api .
docker run -p 8000:8000 -e TACET_INDEX=... -e TACET_API_TOKEN=... tacet-api
```

## 4. Vercel (대시보드)

**Add New Project** → 이 저장소 → **Root Directory: `web`**. 프레임워크(Next.js)는 자동으로 인식된다.

| 환경변수 | 값 |
|---|---|
| `TACET_API_URL` | `https://tacet-api.onrender.com`(Render가 준 URL) |
| `TACET_API_TOKEN` | Render의 `TACET_API_TOKEN`과 같은 값 |
| `DASHBOARD_PASSWORD` | 대시보드 전체 HTTP Basic 인증. 비워두면 URL을 아는 누구나 볼 수 있다 |
| `DASHBOARD_USER` | 선택. 기본값 `tacet` |

대시보드는 결과를 Vercel 캐시에 최대 10분 동안 보관한다. 다시 열 때는 수십 ms 안에 뜨고, Render가 잠들어 있어도 기다리지 않는다.
- 다시 인덱싱했다면 프로젝트 화면의 **새로고침** 버튼을 눌러 바로 반영한다.
- `web/vercel.json`은 함수 리전을 Render와 같은 Singapore(`sin1`)로 고정한다.

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
