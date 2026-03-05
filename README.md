# Claude HUD Custom

[claude-hud](https://github.com/jarrodwatts/claude-hud) v0.0.6 기반 커스텀 포크. 다중 인스턴스 환경에서 발생하는 **429 Rate Limit 무한 루프 문제**를 근본적으로 해결한 버전.

## 원본 대비 변경 사항

### 문제점 (원본 claude-hud)

Claude Code를 여러 개 동시에 실행하면(예: 3개), 모든 인스턴스가 동일한 캐시 파일을 공유한다.
캐시 TTL이 15초로 매우 짧아서, 만료 시 모든 인스턴스가 **동시에** API를 호출하게 되고,
Anthropic의 `/api/oauth/usage` 엔드포인트가 429(Rate Limit)를 반환한다.
429 응답도 일반 실패와 동일하게 15초 TTL로 캐시되므로, 15초마다 또다시 동시 호출 → 429 반복.
결과: **"사용량 API 불가"가 영구적으로 표시**되는 상태.

```
인스턴스 A ─┐
인스턴스 B ─┼─ 캐시 만료 → 동시 API 호출 → 429 → 15초 대기 → 반복...
인스턴스 C ─┘
```

### 해결책 (이 포크)

3가지 메커니즘으로 근본적으로 해결:

#### 1. 3-Tier TTL (응답 유형별 차등 캐시)

| 응답 유형 | 원본 TTL | 커스텀 TTL | 이유 |
|-----------|----------|------------|------|
| 성공 (200) | 60초 | **3분** | 다중 인스턴스의 API 호출 빈도 감소 |
| 실패 (기타 오류) | 15초 | **2분** | 일시적 오류 시 충분한 대기 |
| Rate Limit (429) | 15초 (구분 없음) | **10분** | 429 전용 장기 백오프 |

#### 2. File-based Fetch Lock (파일 기반 잠금)

캐시가 만료되었을 때, **단 하나의 프로세스만** API를 호출하도록 파일 잠금을 사용한다.

```
인스턴스 A ─ 잠금 획득 → API 호출 → 캐시 갱신 → 잠금 해제
인스턴스 B ─ 잠금 실패 → 이전 캐시 데이터 반환 (stale cache)
인스턴스 C ─ 잠금 실패 → 이전 캐시 데이터 반환 (stale cache)
```

- `fs.writeFileSync(..., { flag: 'wx' })` (atomic create) 사용으로 race condition 방지
- 15초 이상 된 잠금 파일은 stale로 판단하고 자동 정리
- 잠금 실패 시 이전 캐시 데이터를 즉시 반환 (API 불가 표시 대신)

#### 3. FetchResult 타입 (응답 분류)

API 응답을 discriminated union으로 분류하여 429와 일반 오류를 구분한다:

```typescript
type FetchResult =
  | { ok: true; data: UsageApiResponse }
  | { ok: false; rateLimited: boolean };
```

- `rateLimited: true` → 10분 TTL로 캐시
- `rateLimited: false` → 2분 TTL로 캐시
- `ok: true` → 3분 TTL로 캐시

## 설치 방법

### 1. 클론

```bash
git clone https://github.com/YeoSeokMin/claude-hud-custom.git
cd claude-hud-custom
```

### 2. 빌드

```bash
npm install
npm run build
```

### 3. Claude Code 설정

`~/.claude/settings.json`의 `statusLine` 항목에 빌드된 경로를 지정:

```json
{
  "env": {
    "statusLine": "node /path/to/claude-hud-custom/dist/index.js"
  }
}
```

Windows 예시:
```json
{
  "env": {
    "statusLine": "node C:/Users/Admin/claude-hud-custom/dist/index.js"
  }
}
```

### 4. 설정 (선택사항)

`~/.claude/plugins/claude-hud/config.json` 파일을 만들어 커스텀 설정 가능:

```json
{
  "lineLayout": "compact",
  "showSeparators": false,
  "pathLevels": 1,
  "gitStatus": {
    "enabled": true,
    "showDirty": true,
    "showAheadBehind": false,
    "showFileStats": false
  },
  "display": {
    "showModel": true,
    "showContextBar": true,
    "showConfigCounts": true,
    "showDuration": true,
    "showUsage": true,
    "usageBarEnabled": true,
    "showTokenBreakdown": true,
    "showTools": true,
    "showAgents": true,
    "showTodos": true,
    "usageThreshold": 0,
    "environmentThreshold": 0
  }
}
```

## 설정 옵션

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `lineLayout` | string | `expanded` | 레이아웃: `compact` 또는 `expanded` |
| `showSeparators` | boolean | false | 구분선 표시 |
| `pathLevels` | 1-3 | 1 | 프로젝트 경로에 표시할 디렉토리 단계 수 |
| `gitStatus.enabled` | boolean | true | Git 브랜치 표시 |
| `gitStatus.showDirty` | boolean | true | 커밋되지 않은 변경사항 `*` 표시 |
| `gitStatus.showAheadBehind` | boolean | false | 리모트 대비 `↑N ↓N` 표시 |
| `gitStatus.showFileStats` | boolean | false | 파일 변경 카운트 `!M +A ✘D ?U` 표시 |
| `display.showModel` | boolean | true | 모델 이름 `[Opus]` 표시 |
| `display.showContextBar` | boolean | true | 컨텍스트 바 `████░░░░░░` 표시 |
| `display.showConfigCounts` | boolean | true | CLAUDE.md, rules, MCP, hooks 카운트 표시 |
| `display.showDuration` | boolean | true | 세션 지속 시간 표시 |
| `display.showUsage` | boolean | true | 사용량 제한 표시 (Pro/Max/Team 전용) |
| `display.usageBarEnabled` | boolean | true | 사용량을 바 형태로 표시 |
| `display.showTokenBreakdown` | boolean | true | 높은 컨텍스트(85%+)에서 토큰 상세 표시 |
| `display.showTools` | boolean | true | 도구 활동 라인 표시 |
| `display.showAgents` | boolean | true | 에이전트 활동 라인 표시 |
| `display.showTodos` | boolean | true | 할 일 진행 상황 표시 |

## HUD 표시 예시

### 세션 정보
```
[Opus | Max] █████░░░░░ 45% | my-project git:(main) | 2 CLAUDE.md | 5h: 25% | ⏱️ 5m
```

### 도구 활동
```
✓ Read ×3 | ✓ Edit ×1 | ⟳ Bash (running)
```

### 에이전트 상태
```
✓ Explore: 코드베이스 분석 (5s)
⟳ general-purpose: API 문서 조사 중...
```

### 할 일 진행
```
⟳ 테스트 작성 중 (3/5)
```

## 디버깅

사용량 API 문제가 발생하면 디버그 로그를 활성화:

```bash
DEBUG=claude-hud claude
```

캐시 파일 직접 확인:
```bash
cat ~/.claude/plugins/claude-hud/.usage-cache.json
```

잠금 파일 확인 (보통 존재하지 않아야 정상):
```bash
ls -la ~/.claude/plugins/claude-hud/.usage-fetch.lock
```

캐시 수동 초기화:
```bash
rm ~/.claude/plugins/claude-hud/.usage-cache.json
rm ~/.claude/plugins/claude-hud/.usage-fetch.lock
```

## 변경된 파일

| 파일 | 변경 내용 |
|------|-----------|
| `src/usage-api.ts` | FetchResult 타입, 3-tier TTL, fetch lock, stale cache 서빙 |
| `tests/usage-api.test.js` | 새 API에 맞춘 테스트 업데이트 + 429 캐시 테스트 추가 |

## 테스트

```bash
npm test
```

19개 테스트 모두 통과:
- 자격 증명 처리 (파일, 키체인, 만료)
- 플랜 이름 파싱 (Pro, Max, Team)
- 캐시 TTL (성공 3분, 실패 2분, 429 10분)
- 캐시 초기화

## 요구 사항

- Node.js 18+
- Claude Code v1.0.80+

## 라이선스

MIT - 원본 [claude-hud](https://github.com/jarrodwatts/claude-hud) 라이선스 동일
