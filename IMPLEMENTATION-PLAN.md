# aiStats — Implementation Plan

Источник дизайна: `DESIGN.md`. Этот файл — план сборки. Все факты о данных сверены на этой машине.

> Дистрибуция: репо `git@github.com:rus-lan/aiStats.git`, установка через `curl | sh` из GitHub Releases (prebuilt dist) — фаза **P11**. P0–P10 от неё не зависят.

## Grounding confirmed (drives the plan)

- **Node** `v22.22.1`. `require('node:sqlite')` работает **по умолчанию** — только `ExperimentalWarning`, флаг не нужен. `new DatabaseSync(path,{readOnly:true})` открывает живую 358 MB WAL-базу Opencode. Главный риск снят.
- **CC**: 1303 `*.jsonl` в 8 slug'ах под `~/.claude/projects/<slug>/`. На `assistant`: `message.usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`, `cache_creation.ephemeral_*`, `iterations[]`, **`server_tool_use.{web_search_requests,web_fetch_requests}`** (прямой read-vs-research сигнал), `message.model`, `attributionSkill`, `isSidechain`, `cwd`, `gitBranch`, `timestamp`. `system` subtypes: `turn_duration`(`durationMs`), `stop_hook_summary`. `tool_use` c `name`+`caller`.
- **CC subagents**: `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json`(`agentType,spawnDepth,toolUseId`); `isSidechain:true`, `agentId`. Спавн в main = `tool_use name:"Agent"`, его `toolUseResult` = `{agentId,agentType,resolvedModel,totalDurationMs,totalTokens,totalToolUseCount,usage,toolStats}` (готовый роллап).
- **Нормализация id модели**: `message.model="claude-opus-4-8"`, но `resolvedModel="claude-opus-4-8[1m]"` — срезать `[...]` перед прайс-lookup.
- **Opencode** `1.17.15`: `opencode stats` (Sessions 197, Cost $1.66, Input 8.6M, Output 635.1K, Cache Read 117.7M). `opencode export <id>` (+`--sanitize` для фикстур). Таблицы `session,message,part,event,todo,project`. **Caveat: `session.cost` бывает `0`** при заполненных токенах — $ считать суммой message/`step-finish` cost.
- **Интеграция**: `~/claude-config/` (skills/agents/install.sh) — корень CC-авторинга через `/config-apply`; `~/.config/opencode/plugins/*.js` — примеры плагинов (`telegram-notify.js` и др.).
- **Repo** `aiStats/` пуст, greenfield.
- **Gotcha**: `str += buffer` рвёт multibyte UTF-8 на границе чанков — читать весь `Buffer`, потом `.toString('utf8')`.

## A. Module / file layout

```
aiStats/
  package.json  tsconfig.json  tsconfig.build.json  eslint config
  bin/aistats.js            # #!/usr/bin/env node; NODE_NO_WARNINGS; import('../dist/cli/main.js')
  src/
    cli/ main.ts commands/{report,ingest,rebuild,install}.ts flags.ts
    core/
      types.ts             # normalized model + adapter contract (section B)
      store/ {store,sqlite-store,jsonl-store,open,schema,paths}.ts
      ingest/ {pipeline,cursor}.ts
      phase/ {infer,signals,blocks}.ts
      metrics/ {engine,slices,ratios}.ts
      recommend/ {rules,engine}.ts
      cost/ {prices,cost}.ts
      util/ {json,git,redact,model-id,time}.ts
    adapter/
      claude-code/ {index,transcript,subagents,paths}.ts
      opencode/ {index,db,export}.ts
    render/
      report-model.ts
      terminal/ {render,bars,spark,color}.ts
      html/ {render,theme,script}.ts  html/svg/{bar,line,donut,heatmap}.ts
    integration/
      claude-code/ skill/aistats.md  hooks/*   # copied into ~/claude-config by install
      opencode/ aistats-plugin.js
  test/ unit/  fixtures/{cc,opencode}/  golden/  helpers/
```

- `package.json`: `"type":"module"`, `"engines":{"node":">=22.22"}`, `"bin":{"aistats":"bin/aistats.js"}`. Scripts: `build`=`tsc -p tsconfig.build.json`, `typecheck`=`tsc --noEmit`, `lint`=`eslint . --max-warnings=0`, `test`=`node --test` (built-in runner), `check`=typecheck+lint+test. **No runtime deps**; dev-only `typescript,@types/node,eslint,typescript-eslint`. Everything else from `node:` builtins (`sqlite,util.parseArgs,child_process,crypto`).
- tsconfig strict: `strict,noUncheckedIndexedAccess,exactOptionalPropertyTypes,noImplicitOverride,noFallthroughCasesInSwitch`, `module/moduleResolution=nodenext`, `target=es2023`, `verbatimModuleSyntax`, `isolatedModules`, `outDir=dist`.
- **node:sqlite probe** (`store/open.ts`): try `import('node:sqlite')` → `SqliteStore`, else `JsonlStore`; cache decision in `~/.aistats/store.meta.json`. Both satisfy one `Store` interface — upstream never branches.

## B. Shared internal types (`src/core/types.ts`)

Adapters emit phase-free `AdapterRun[]`; pipeline assigns phase and persists `Run/Turn/Toolcall`.

- `ToolName='cc'|'opencode'`; `Phase='reading'|'research'|'planning'|'implementation'|'review'|'verify'|'fix'`; `ToolcallStatus='ok'|'error'|'in_progress'`.
- `TokenTotals{input,output,cacheRead,cacheWrite,reasoning?}`.
- `SourceRef{kind:'cc-jsonl'|'oc-export', path?, byteOffset?, ocSessionId?, ocCursorTime?}` — idempotency cursor.
- `AdapterToolcall{name,tStart,tEnd?,status,isEdit,file?}`.
- `AdapterTurn{idx,tStart,tEnd,durationMs?,model?,skill?,tokens,webRequests,toolcalls,hadVerify,verifyFailed}`.
- `AdapterRun{sourceTool,runKey,sessionId,isSubagent,parentRunKey?,agentType?,spawnDepth?,cwd?,model?,tStart,tEnd,open,tokens,costUsd?,turns,sourceRef}`.
- Persisted: `Run{id,tool,projectKey,agentType?,isSubagent,parentRunId?,model?,tStart,tEnd,open,tokens,costUsd?,cursor}`; `Turn{id,runId,idx,tStart,tEnd,durationMs?,tokens,model?,phase,skill?,blockId,isFixEpisodeStart}`; `Toolcall{id,turnId,name,tStart,tEnd?,status,isEdit,file?}`.
- `Adapter{tool, discover(opts):SourceRef[], parse(ref):AdapterRun[]}`; `DiscoverOpts{cursors:Map, since?}`.

`Run/Turn/Toolcall` — единственное, что читает metrics engine. Report-model строит только `metrics/engine.ts` и он — единственный вход обоих рендереров.

## C. Build phases (MVP-first). Проверка всегда против реальных данных этой машины.

### P0 — Skeleton + types + store
Goal: пакет собирается, `aistats --help` работает, store открывается (sqlite|jsonl), схема, `~/.aistats` mode 700.
Accept: `build+typecheck+lint` чисто; round-trip Run/Turn/Toolcall; `stat -c '%a' ~/.aistats`==700; backend решён и закэширован.
Verify: insert+read через оба стора, равенство; `probeSqlite()`→sqlite.

### P1 — CC retro adapter + ingest (idempotent)
Goal: `aistats ingest --all` парсит все CC JSONL → Runs/Turns/Toolcalls; сабагенты слинкованы.
Grounded: main = `isSidechain:false`; turn = `assistant` + следующие `tool_use`/`toolUseResult`/`system` до следующего `assistant`/`user`; `durationMs` из `turn_duration`; токены из `message.usage`; `webRequests` из `usage.server_tool_use`; `skill` из `attributionSkill`; спавн `tool_use name:"Agent"` → читаем `subagents/agent-<agentId>.jsonl`+`.meta.json` как child (`parentRunKey,agentType,spawnDepth`); курсор = `byteOffset` (размер файла).
Accept: идемпотентно (2-й ingest = 0 новых); offset растёт; child-runs с `parentRunId`.
Verify: распарсить сессию aiStats и feedHub, проверить кол-ва turns/toolcalls, захват `attributionSkill`; сумма `output_tokens` ~ `stats-cache.json`; ingest дважды → одинаковые счётчики; feedHub subagents → child с `agentType` из `.meta.json`.

### P2 — Phase inference
Goal: одна из 7 фаз на turn детерминированно; блоки + fix-эпизоды.
Rules: приоритет agent-type/skill → tool-mix → default. read-only(Read/Grep/Glob)→reading; +web(`webRequests>0`)→research; Edit/Write/patch→implementation; verify-bash→verify; verifyFailed→edit→fix (старт эпизода); review-agent/plan→review/planning. Contiguous same-phase→`blockId`.
Accept: у каждого turn фаза; блоки непрерывны; fix-эпизоды считаются по одному.
Verify: unit на синтетике; на реальных сессиях — гистограмма фаз + счётчик flips (индикатор over-split); тюнинг порогов до зависимых метрик.

### P3 — Metrics engine
Goal: Report-model из store — срезы tool·project/global·phase·actor·model·days.
Accept: тотали сходятся с сырьём (токены, toolcalls); phase-time=Σ blocks; fixes=эпизоды.
Verify: Σ phase time == Σ turn durations; Σ tokens == P1; unit на каждый ratio.
Risk: двойной счёт токенов сабагента (в parent `Agent` result есть `totalTokens`) — суммируем только child-runs, parent значение только для валидации.

### P4 — Terminal renderer  ← MVP заканчивается тут (полезный отчёт из одной CC-истории)
Goal: `aistats report` печатает терминальный отчёт (без файла), ASCII-бары/спарки/цвет, `--full`; `--project/--global`, `--days N`, `--tool cc`.
Accept: рендер фаз/токенов/счётчиков/ratios; `--project` из git-root cwd фильтрует; non-TTY → без цвета.
Verify: `aistats report --global --tool cc` — sanity против `stats-cache.json`; в каталоге проекта `--project` показывает только его slug.

### P5 — Opencode adapter (export-based)
Goal: ingest Opencode.
Grounded: `db.ts`(readOnly) для перечня id + курсор(`time_updated`),`directory`,`parent_id`; на каждую новую сессию `opencode export <id>` → `{info,messages:[{info,parts}]}`; turn=assistant-message; токены/cost из message `info` и `step-finish`; toolcalls из `tool`-parts (edit=`patch`/`edit`/`write`); сабагент=`task`-part(`input.subagent_type`,`state.metadata.{parentSessionId,sessionId}`)→child по `parent_id`; курсор=max message time.
Accept: токены per session сходятся с DB и `opencode stats`; **$ = сумма message/`step-finish` cost** (не `session.cost`).
Verify: `ses_0bc2a61eaffeFVqwn0UFftX8Qp` export→сумма токенов==DB колонок; сумма всех≈Input 8.6M/Output 635.1K/$1.66. Whole-buffer decode.
Risk: 197× спавн `opencode export` — инкремент по курсору, пропуск неизменённых `time_updated`; `-wal` — некоммиченное невидимо readOnly, контент только через `export`, DB — только перечень/курсор.

### P6 — Project keying + cross-tool merge
Goal: объединить CC+Opencode по проекту; global=все; ось инструмента сохранена.
Grounded: `projectKey`=`git rev-parse --show-toplevel` от cwd (CC `cwd`/OC `directory`), фолбэк норм. абс. cwd; кэш резолва.
Accept: общий репо схлопывается в один `projectKey`; `--tool all/cc/opencode`; `--global` агрегирует.
Verify: общий каталог → один key с двумя суб-строками по инструментам.

### P7 — HTML renderer
Goal: `--html [path]` self-contained; дефолт `~/.aistats/reports/aistats-<scope>-<ts>.html`; `--out`; не писать в дерево проекта.
Accept: офлайн, без CDN; инлайн CSS/JS; bar/line/donut/heatmap инлайн-SVG из TS; тултипы vanilla; light/dark; учитывает `--redact`; guard против записи под git-root проекта.
Verify: генерим `--global`; в файле ноль `http(s)://` и есть `<svg`; открыть в браузере; дефолт-путь в `~/.aistats/reports/`.

### P8 — Recommendation rule-engine
Goal: детерминированные правила над метриками → текст + доказательство + оценка импакта, ранжирование; терминал top-N, HTML все.
Accept: правило даёт условие/порог/числа/импакт; ранжирование; override конфига меняет срабатывание.
Verify: unit на границах порогов; на реальных данных ≥1 осмысленная рекомендация с числами.

### P9 — Live triggers (CC hooks + Opencode plugin)
Goal: тонкие шимы зовут `aistats ingest --session <path|id>`.
Modules: `integration/claude-code/*`→ авторятся в `~/claude-config/` (скилл `/aistats`, хуки PostToolUse/SubagentStop/Stop); `integration/opencode/aistats-plugin.js` (event `session.idle`≈Stop, `tool.execute.after`); `install.ts`.
Details: `install --claude-code` копирует в `~/claude-config/` (юзер потом `/config-apply`; в `~/.claude` не писать); `install --opencode` кладёт плагин в `~/.config/opencode/plugins/`. Шимы ≤20 строк, только спавн `aistats ingest`.
Accept: после CC-хода хук триггерит ingest только этой сессии (offset-инкремент, быстро); OC `session.idle` — ingest этой сессии.
Verify: dry-run хук-команды против живого файла — только новые turns; форма плагина как у рабочих в `~/.config/opencode/plugins/`.
Risk: латентность хука — offset-resume держит sub-second; не блокировать инструмент.

### P10 — `--redact`, price table, polish
Goal: `--redact` (хеш имён проектов + drop заголовков), зашитая прайс-таблица Anthropic → best-effort $ для CC, override конфига, доки.
Details: таблица по нормализованному id (`claude-opus-4-8`); неизвестная модель → только токены, `$ n/a`; OC $ как есть; `--redact` чистит везде (терминал+HTML).
Accept: `--redact` без сырых путей/заголовков; CC $ для известных моделей, иначе `n/a`; override меняет цены.
Verify: diff redacted vs normal на утечки; unit на cost-мат (input/output/cache-read/cache-write); `[1m]` нормализуется перед lookup.

### P11 — Packaging + `curl|sh` installer
Goal: `curl|sh` ставит CLI из GitHub Releases; prebuilt dist, на цели ничего не собираем.
Modules: `install.sh` (корень репо), `scripts/release.sh`, `bin/aistats.js` (`--version`), поля `version`/`repository` в `package.json`.
Repo: `git@github.com:rus-lan/aiStats.git`; одна строка `curl -fsSL https://raw.githubusercontent.com/rus-lan/aiStats/main/install.sh | sh`.
Flow install.sh (POSIX sh): node≥22 check → latest release via GitHub API (override `AISTATS_VERSION`/`AISTATS_TARBALL`) → распаковка в `~/.local/lib/aistats` → symlink `~/.local/bin/aistats` → `~/.aistats` mode 700 → PATH-warning → подсказка `aistats install --claude-code|--opencode`. Ставит только CLI, `~/.claude`/opencode не трогает.
Accept: на чистой машине с Node≥22 одна строка даёт рабочий `aistats --version`; symlink на месте; `~/.aistats` 700; повторный запуск обновляет in-place; node<22 → дружелюбная ошибка.
Verify: `AISTATS_TARBALL=<локальный .tgz> sh install.sh` → `aistats report --help` работает; сымитировать отсутствие/старый node → корректная ошибка; идемпотентный повтор.
Risk: rate-limit GitHub API `releases/latest` (аноним 60/ч) → пин `AISTATS_VERSION` + прямой asset URL fallback; имя default-ветки (main vs master) должно совпадать с raw-URL — выставить default branch репо и сослаться один раз.

## D. Test strategy

- Runner: `node --test` (без зависимостей), компилим `test/` тем же tsc.
- Unit: phase (синтетические `AdapterTurn[]`→фаза/блоки/эпизоды: reading-only; reading→web→research; green-edit=impl; verify→fail→edit=fix; planning-skill override; review-agent; длинный fix=1 эпизод N правок); metric-math (in-memory store); cost; git-key; store-parity (sqlite vs jsonl идентичны).
- Fixtures (committed, redacted): CC main (~30 строк)+subagent set, оставить `type/usage/model/attributionSkill/isSidechain/timestamp/tool_use.name/toolUseResult.{agentId,agentType,resolvedModel,totalTokens}`; OC — `opencode export --sanitize` JSON. Mock: `opencode export`(spawn→фикстура), git-резолв, перечень ФС через инъекцию `paths`. НЕ мокать: парсеры/фазы/метрики/рендереры.
- Golden: pipeline над фикстурами → Report → terminal render → сравнение с `golden/report-*.txt`; HTML — структурные инварианты (нет `http`, есть `<svg`, метки фаз) с нормализацией волатильного; обновление только `UPDATE_GOLDEN=1`.

## E. Risks & unknowns — cheap experiments

1. **node:sqlite** — RESOLVED: доступен по умолчанию на 22.22. JSONL-фолбэк держим для других машин (probe в `open.ts`).
2. **export↔stats reconciliation** — `session.cost` бывает 0 → $ из message/`step-finish`. Гейт P5: export последней сессии, сумма токенов==DB; сумма всех==`stats`. Whole-buffer decode (UTF-8).
3. **Phase false-split (read↔research, impl↔fix)** — эксперимент в P2: flips per session + гистограмма; при избытке — гистерезис (≥2 turns на переключение / merge singleton). Web-flag делает read-vs-research чётким; impl-vs-fix зависит от надёжного `verifyFailed` — сперва провалидировать verify/bash-классификатор на реальных `bash`.
4. **In-flight last turn** — активные сессии (WAL/свежий mtime): `open:true`, provisional `tEnd`; следующий ingest дочитывает с прошлого offset и финализирует. OC `-wal`: некоммиченное невидимо readOnly → контент через `export`.
5. **Perf перепарса** — 1303 CC + 197 OC + 358MB DB. Замерить полный `ingest --all`; инкремент offset(CC)/time-cursor(OC); батч/skip неизменённых `time_updated`. Цель: инкремент <1s (hook-safe), `--rebuild` — десятки секунд.
- Мелкие: двойной счёт токенов сабагента (сумма только children); суффикс `[1m]` (нормализовать до lookup); HTML write-guard (не писать под git-root проекта).

### Critical files
- `src/core/types.ts` — нормализованная модель + контракт адаптера (интерфейс, на который согласны все модули).
- `src/adapter/claude-code/transcript.ts` — парсер CC JSONL (источник данных MVP; turn/token/spawn).
- `src/core/phase/infer.ts` — детерминированный 7-фазный автомат (аналитическое ядро).
- `src/core/store/open.ts` — runtime probe node:sqlite + выбор JSONL-фолбэка.
- `src/core/metrics/engine.ts` — строит единый Report-model для обоих рендереров.
