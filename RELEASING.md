# Releasing Tacet

한 번의 태그 push로 네 곳에 게시된다.

| 레지스트리 | 산출물 | 이름 |
|---|---|---|
| npm | 6개 패키지 | `@tacet-api/core`, `@tacet-api/extractor-typescript`, `@tacet-api/extractor-java`(JAR 포함), `@tacet-api/ai-anthropic`, `@tacet-api/cli`, `@tacet-api/mcp` |
| PyPI | wheel + sdist | `tacet` (import `tacet`) |
| Maven Central | Maven 플러그인 | `io.github.heonjinjeong:tacet-maven-plugin` |
| Gradle Plugin Portal | Gradle 플러그인 | `io.github.heonjinjeong.tacet` |

## 최초 1회 설정

1. **GitHub 저장소**: `https://github.com/heonjinjeong/tacet` (패키지 메타데이터의 repository/scm URL. 다르면 모든 package.json, pom.xml, build.gradle.kts, pyproject.toml의 URL을 바꾼다.)
2. **npm**: npmjs.com에서 organization `tacet` 생성(`@tacet` scope) → Automation 토큰 발급 → 저장소 secret `NPM_TOKEN`.
3. **PyPI**: pypi.org → Publishing → "Add a new pending publisher": project `tacet`, owner `heonjinjeong`, repo `tacet`, workflow `release.yml`, environment `pypi`. GitHub 저장소에 environment `pypi` 생성. 토큰 저장 불필요(trusted publishing).
4. **Maven Central**: central.sonatype.com 로그인(GitHub 계정) → namespace `io.github.heonjinjeong` 인증 → User Token 발급 → secret `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`.
5. **서명 키(GPG)**: `gpg --full-generate-key` → 공개키를 keyserver에 업로드(`gpg --keyserver keyserver.ubuntu.com --send-keys <KEYID>`) → `gpg --armor --export-secret-keys <KEYID>`를 secret `SIGNING_KEY`, 암호를 `SIGNING_PASSWORD`.
6. **Gradle Plugin Portal**: plugins.gradle.org 로그인(GitHub 계정) → API Keys → secret `GRADLE_PUBLISH_KEY`, `GRADLE_PUBLISH_SECRET`.

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
