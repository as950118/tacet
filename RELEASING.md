# Releasing Tacet

한 번의 태그 push로 아래 레지스트리에 게시된다. 각 게시 job은 같은 이름의 GitHub environment에서 secret을 읽는다.

| 레지스트리 | 산출물 | 이름 | Environment / secret |
|---|---|---|---|
| npm | 6개 패키지 | `@tacet-api/core`, `@tacet-api/extractor-typescript`, `@tacet-api/extractor-java`(JAR 포함), `@tacet-api/ai-anthropic`, `@tacet-api/cli`, `@tacet-api/mcp` | `npm` / `NPM_TOKEN` |
| PyPI | wheel + sdist | `tacet-api` (import `tacet`) | `pypi` / `PYPI_API_TOKEN` |
| Gradle Plugin Portal | Gradle 플러그인 | `io.github.as950118.tacet` | `gradle` / `GRADLE_PUBLISH_KEY`, `GRADLE_PUBLISH_SECRET` |
| Maven Central (선택) | Maven 플러그인 | `io.github.as950118:tacet-maven-plugin` | 저장소 secret, 변수 `MAVEN_CENTRAL_ENABLED=true`일 때만 |

## 최초 1회 설정

1. **GitHub 저장소**: `https://github.com/as950118/tacet` (패키지 메타데이터의 repository/scm URL. 다르면 모든 package.json, pom.xml, build.gradle.kts, pyproject.toml의 URL을 바꾼다.)
2. **npm**: npmjs.com에서 organization `tacet-api` 생성(`@tacet-api` scope) → Automation(또는 publish 권한의 Granular) 토큰 발급 → environment `npm`의 secret `NPM_TOKEN`.
3. **PyPI**: pypi.org에서 API 토큰 발급(첫 업로드 전에는 "Entire account" 범위) → environment `pypi`의 secret `PYPI_API_TOKEN`. 첫 릴리스 후 `tacet-api` 프로젝트 범위 토큰으로 바꾼다.
4. **Gradle Plugin Portal**: plugins.gradle.org에 GitHub 계정 `as950118`로 로그인(플러그인 ID `io.github.as950118.*`는 이 계정에서만 게시된다) → API Keys → environment `gradle`의 secret `GRADLE_PUBLISH_KEY`, `GRADLE_PUBLISH_SECRET`. 서명 키(`SIGNING_KEY`)가 없으면 서명 없이 게시한다.
5. **Maven Central (선택)**: central.sonatype.com 로그인(GitHub 계정) → namespace `io.github.as950118` 인증 → User Token 발급 → 저장소 secret `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`. 서명 키(GPG): `gpg --full-generate-key` → 공개키를 keyserver에 업로드(`gpg --keyserver keyserver.ubuntu.com --send-keys <KEYID>`) → `gpg --armor --export-secret-keys <KEYID>`를 secret `SIGNING_KEY`, 암호를 `SIGNING_PASSWORD`. 다 되면 저장소 변수 `MAVEN_CENTRAL_ENABLED`를 `true`로 둔다.

## 릴리스 절차

```bash
node scripts/set-version.mjs 0.2.0    # 모든 산출물 버전 변경 (npm 내부 의존성 포함)
npm install                           # package-lock.json 갱신
git commit -am "Release 0.2.0"
git tag v0.2.0 && git push && git push --tags
```

`release.yml`은 먼저 태그와 모든 버전이 일치하는지 확인하고 전체 테스트(TS, Java extractor, Python, Gradle/Maven
플러그인)를 실행한 뒤, 통과해야만 각 레지스트리에 게시한다.

## 게시 전 로컬 확인

```bash
npm run build:jar && npm run build
npm run pack:all                                  # dist-packages/*.tgz (npm publish와 같은 tarball)
(cd python && cp ../LICENSE . && uv build && uvx twine check dist/*)
(cd plugins/gradle && ./gradlew validatePlugins publishToMavenLocal)
(cd plugins/maven && mvn -Prelease -Dgpg.skip verify)
```
