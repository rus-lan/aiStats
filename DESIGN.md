# aiStats — DESIGN

Кросс-тул сборщик статистики о работе ИИ-агентов (Claude Code + Opencode): сколько времени и трудозатрат уходит на чтение проекта, ресерч, реализацию, ревью, исправления; сколько исправлений; разбивка по оркестратору / сабагентам / моделям; на уровне проекта и глобально. Вывод — в терминал и в self-contained HTML с графиками и рекомендациями по повышению эффективности.

Этот файл — источник правды по дизайну. Согласован через grilling-сессию.

## 1. Цели

- Собрать временные метрики и трудозатраты (токены/стоимость) по фазам работы ИИ.
- Разделять оркестратор, сабагентов, модели.
- Считать на уровне проекта и глобально, сравнивать Claude Code vs Opencode на одном проекте.
- Выдавать отчёт двумя способами: терминал (без файла) и HTML-файл.
- Давать ранжированные рекомендации, как сократить время и повысить эффективность.

## 2. Проверенные факты о данных (grounding)

Всё сырьё оба инструмента и так пишут на диск почти в реальном времени. Фазы (чтение/ресерч/реализация/ревью/фикс) в данных отсутствуют — выводятся. Стоимость в $ есть только у Opencode.

### 2.1 Claude Code
- Транскрипт сессии: `~/.claude/projects/<project-slug>/<sessionId>.jsonl`, где slug = `cwd` с заменой `/` на `-`.
- Одна строка = одно событие с полем `type` (`user`/`assistant`/`system`/…). У message/tool событий есть ISO-8601 `timestamp` → длительности считаются диффом.
- Токены на каждом `assistant`: `.message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`, `.message.model`. **$ не пишется** (`costUSD` отсутствует).
- Инструменты: `assistant` content blocks `tool_use` с `name`; результат — на последующем `user` как `.toolUseResult`.
- Сабагенты — отдельные файлы: `~/.claude/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` + `.meta.json` (`agentType`, `spawnDepth`, `toolUseId`). Внутри — `isSidechain:true`, `agentId`. Main-loop: `isSidechain:false`.
- Спавн: в main-транскрипте `tool_use` name `Agent`, в результате `agentId`, `resolvedModel`, `status`.
- `attributionSkill` на `assistant` строках = активный скилл/команда (прокси фазы).
- Полезное: `system` `subtype:"turn_duration"` с `durationMs`; дневной ролл-ап `~/.claude/stats-cache.json`.

### 2.2 Opencode (v1.17.x, this machine)
- Хранилище — одна SQLite-база: `~/.local/share/opencode/opencode.db` (WAL). Таблицы: `session`, `message`, `part`, `event`, `todo`, `project`.
- `session`: колонки `agent`, `model`, `cost`, `tokens_input/output/reasoning/cache_read/cache_write`, `time_created/updated`, `parent_id`, `directory`, `title`.
- `message.data` (JSON): `role`, `agent`, `mode`, `cost`, `tokens{input,output,reasoning,cache{read,write},total}`, `modelID`, `providerID`, `time{created,completed}`, `parentID` (это threading, НЕ сабагент).
- `part.data` (JSON): `type` ∈ `tool|step-start|step-finish|text|reasoning|patch|agent|…`. Tool-part: `{tool, callID, state{status,input,output,metadata,time{start,end}}}`. `step-finish` несёт `cost`+`tokens`. `patch` = `{hash, files[]}`.
- Сабагент = отдельная `session` с `parent_id`; спавн — tool-part `tool:"task"` с `input.subagent_type` и `state.metadata.{parentSessionId,sessionId}`.
- Фаза-прокси сильнее CC: `agent`/`mode` на каждом сообщении (`build`/`plan`/`explore`/`general`/кастомные).
- Готовые команды: `opencode export <sessionID>` (чистый JSON `{info, messages:[{info,parts}]}`), `opencode stats`.
- Плагин-шина: hooks `event`, `tool.execute.before/after`, событие `session.idle` (≈ Stop/SessionEnd). Durable в `event`-таблице только 4 типа; остальное — live-only через плагин.

### 2.3 Чего нет ни там, ни там
- Явной метки фазы. Выводим.
- $ у Claude Code. Считаем по прайс-таблице.
- Нативного OTel (не включён).

## 3. Архитектура

Единое ядро + два тонких адаптера. Ядро считает единую Report-model → два рендерера.

### 3.1 Компоненты
- **core** — нормализованная модель, инкрементальный ingest, разметка фаз, метрики, rule-engine рекомендаций.
- **adapter/claude-code** — читалка JSONL (ретро) + разбор сабагент-файлов.
- **adapter/opencode** — читалка через `opencode export` / SQLite (ретро).
- **render/terminal** — текстовый рендер (таблицы, ASCII-бары, спарклайны, цвет).
- **render/html** — self-contained HTML, инлайн-SVG графики.
- **cli** — `aistats` (ingest, report, rebuild, install).
- **integration (шимы)**: CC хуки + скилл `/aistats`; Opencode плагин. Дёргают `aistats ingest`.

### 3.2 Поток данных
Сырьё (live на диске) → adapter нормализует → инкрементальный ingest в store `~/.aistats/` → метрики+фазы+рекомендации → Report-model → терминал и/или HTML. Хуки/плагин лишь триггерят ingest сразу после хода.

## 4. Нормализованная модель данных

Общая схема, в которую мёржатся оба инструмента (грануляция: run → turn → toolcall):
- **run** (сессия): `id`, `tool` (cc|opencode), `project_key`, `agent_type`, `is_subagent`, `parent_run_id`, `model`, `t_start`, `t_end`, токены-итоги, `cost`.
- **turn** (assistant message / step): `run_id`, `t_start`, `t_end`, `tokens{input,output,cache_read,cache_write,reasoning}`, `model`, `phase` (выведенная), активный `skill`.
- **toolcall**: `turn_id`, `name`, `t_start`, `t_end`, `status`, `is_edit`, `file`.

Store — производный кэш, пересобираемый из сырья (`--rebuild`). Схему можно менять свободно.

## 5. Определение фаз (7, детерминированно)

Reading · Research · Planning · Implementation · Review · Verify · Fix.

Приоритет сигналов при разметке хода: явный тип агента / активный скилл → набор инструментов хода (tool-mix) → дефолт. Соседние ходы с одной фазой склеиваются в блок; время фазы = сумма длительностей блоков.

- **Reading** — локальное чтение репо (`Read/Grep/Glob`, агент `Explore`/`explore`), без веба.
- **Research** — веб/доки (`WebSearch/WebFetch/Context7/desearch`), ресерч-агенты.
- **Planning** — планирование в main-loop, спавн `Task`/`Agent`, plan-mode, `grilling`, `todowrite`.
- **Implementation** — `Edit/Write` в «зелёном» потоке, dev-агенты (`build`/`react-dev`/`go-dev`/`rust-dev`/…).
- **Review** — скиллы `code-review`/`security-review`, ревьюер-агенты.
- **Verify** — прогон тестов/линта/сборки через `Bash`.
- **Fix** — правки после упавшего Verify или замечаний ревью; fix-скиллы (`feedhub-fix`, `autoresearch-fix`).

Трудные пары: read-vs-research делим по «нет веба / есть веб»; impl-vs-fix — «в зелёном потоке» vs «после упавшего verify/ревью».

LLM-разметка спорных сегментов — отложена (за флагом).

## 6. Метрики и оси

Оси нарезки каждой метрики: инструмент (cc/opencode) · проект / глобально · фаза · актор (оркестратор / тип сабагента) · модель · окно времени (дни).

- **Время**: по фазам (абсолют и %), активное время сессии, оркестратор vs сумма сабагентов, time-to-first-edit, cycle time (research→impl→review→done).
- **Токены/стоимость**: input/output/cache/reasoning по фазе/актору/модели; cache-hit ratio; $ (Opencode реальный, CC по таблице); оркестратор vs сабагенты.
- **Счётчики**: сессии, ходы, вызовы инструментов по типам, спавны сабагентов, число исправлений, число проходов ревью, rework (повторные правки правленого файла).
- **Коэффициенты**: fix-to-impl, tokens-per-fix, research-to-impl, rework-loops на задачу, параллелизм сабагентов.

**Число исправлений = fix-эпизоды** (непрерывный блок fix-фазы, вызванный упавшим verify/ревью/fix-скиллом = 1). Отдельно — число fix-правок (`Edit/Write` внутри эпизодов).

## 7. Идентичность проекта

Ключ проекта = корень git-репо (`git rev-parse --show-toplevel` от `cwd`), фолбэк — нормализованный абсолютный `cwd`, если каталог не git/удалён. Имя = basename корня. Сессии CC и Opencode с одинаковым ключом мёржатся в один проект; ось «инструмент» всегда сохраняется для сравнения. Глобально = все проекты.

## 8. Хранилище

- Расположение: `~/.aistats/` (store, `reports/`, `config`). Права `700`.
- Формат store: `node:sqlite` (без нативной сборки); фолбэк — JSONL-лог + JSON-роллапы, если `node:sqlite` недоступен в рантайме.
- Инкрементальный ingest: идемпотентно по `session_id` + offset (CC JSONL) / курсор по времени сообщения (Opencode). Полный пересбор — `--rebuild`.
- Незакрытый последний ход активной сессии помечается `provisional`.

## 9. Вывод: терминал и HTML

Единая Report-model → два рендерера.
- **Терминал** — по умолчанию, файл не создаётся. Таблицы, ASCII-бары, спарклайны, цвет. `--full` — расширенная детализация.
- **HTML** — по `--html [path]`. Self-contained один файл (инлайн CSS/JS, без CDN). Графики — инлайн-SVG, генерятся в TS (bar/line/donut/heatmap); чуть vanilla-JS для тултипов/переключателей. Тема light/dark. По умолчанию пишется в `~/.aistats/reports/aistats-<scope>-<timestamp>.html`, override `--out`. В дерево проекта не пишем.
- Срез: `--project [path]` (по умолчанию проект текущего `cwd`) либо `--global`; `--tool cc|opencode|all`; `--days N`; окно по умолчанию — всё время.

## 10. Рекомендации (rule-engine)

Детерминированный движок правил над метриками/коэффициентами. Каждое правило: условие+порог → текст + доказательство (числа) + оценка эффекта; вывод ранжирован по импакту. Дефолты порогов захардкожены, override в `~/.aistats/config`. Примеры:
- высокий fix-to-impl → усилить ревью/тесты до реализации, tests-first;
- много rework-loops → полнее спека/контекст заранее;
- длинный research vs impl / большой time-to-first-edit → ограничить ресерч, кэшировать доки;
- низкий cache-hit → реже сбрасывать контекст/компакт;
- перекос оркестратор vs сабагенты → больше параллелизма;
- дорогая модель на дешёвой фазе → Fable/Haiku на разведку;
- ревью ловит много поздно → ревьюить инкрементально.

LLM-нарратив поверх правил — отложен (за флагом). В терминале — топ-N, в HTML — все с раскрытием.

## 11. Приватность

В store и отчёт — только агрегаты/метаданные; тел сообщений и кода нет никогда. По умолчанию настоящие имена проектов и заголовки. Флаг `--redact` хеширует имена проектов и убирает заголовки (для шаринга HTML). Store с правами `700`.

## 12. Стоимость $

Первичная метрика трудозатрат — токены (точна для обоих). $ — best-effort: зашитая прайс-таблица Anthropic (input/output/cache-read/cache-write по id модели), override в конфиге; модель не в таблице → только токены, `n/a` по $. Opencode $ берём как есть из данных (flat-rate `zai-coding-plan` — реальный $0).

## 13. Раскладка файлов и установка

- **Исходники**: этот репозиторий `/home/ruslan/public/rus-lan/monitoring/aiStats/`. TS-пакет, CLI `aistats`.
- **Данные рантайма**: `~/.aistats/`.
- **Интеграция Claude Code** (скилл `/aistats` + хуки `PostToolUse`/`SubagentStop`/`Stop`): авторится в `~/claude-config/`, раскатывается `/config-apply`. Прямо в `~/.claude/` не писать.
- **Интеграция Opencode** (плагин `aistats.js`): `~/.config/opencode/plugins/`.
- Хуки/плагин — тонкие шимы: дёргают `aistats ingest --session <path>`; вся логика в CLI.

## 14. CLI-поверхность (черновик)

- `aistats report [--project <path> | --global] [--tool cc|opencode|all] [--days N] [--full] [--html [path] | --out <path>] [--redact]` — по умолчанию терминал.
- `aistats ingest [--session <path>] [--all]` — инкрементальный сбор (зовётся хуками/плагином или вручную).
- `aistats rebuild` — полный пересбор store из сырья.
- `aistats install [--claude-code | --opencode]` — вывести/подготовить интеграцию (CC-часть через claude-config).
- `aistats --version` — печатает версию из package.json; `aistats --help` — список команд.

## 15. Отложено

- MCP-слой (запрос статистики агентом прямо в работе).
- LLM-разметка спорных фаз.
- LLM-нарратив рекомендаций.
- Дублирование store в проект.

## 16. Стек

TypeScript на Node 22, strict, без нативных зависимостей. Opencode-ретро через `opencode export` (SQLite напрямую — только фолбэк). API ядра держим Node-совместимым, чтобы тот же код грузился в Bun-рантайме Opencode-плагина.

## 17. Дистрибуция и установка (`curl | sh`)

- **Репозиторий**: `git@github.com:rus-lan/aiStats.git` (public), remote `origin`.
- **Артефакт релиза**: prebuilt тарбол `aistats-<version>.tgz` = `dist/` + `bin/` + `package.json` (без `src/`, без `node_modules` — нативных/рантайм-зависимостей нет). Прикладывается к GitHub Release с тегом `vX.Y.Z`.
- **Инсталлятор**: `install.sh` в корне репо, отдаётся как `https://raw.githubusercontent.com/rus-lan/aiStats/<default-branch>/install.sh`. Ставит только CLI, не трогает `~/.claude`/`~/.config/opencode`.
- **Одна строка**: `curl -fsSL https://raw.githubusercontent.com/rus-lan/aiStats/main/install.sh | sh`
- **Что делает install.sh** (POSIX sh; Linux/macOS):
  1. Проверка `node` есть и `>=22` (парс `node -v`); иначе — понятная ошибка и выход.
  2. Узнать последний релиз через GitHub API (`/repos/rus-lan/aiStats/releases/latest`), скачать тарбол-ассет. Override: `AISTATS_VERSION` (пин версии) / `AISTATS_TARBALL` (прямой URL или локальный файл — для тестов и офлайна).
  3. Установить в `~/.local/lib/aistats` (снести прошлую копию, распаковать `dist+bin+package.json`).
  4. Симлинк `~/.local/lib/aistats/bin/aistats.js` → `~/.local/bin/aistats`, `chmod +x`.
  5. `mkdir -p ~/.aistats && chmod 700 ~/.aistats`.
  6. Если `~/.local/bin` не в `$PATH` — предупредить и показать строку `export`.
  7. Подсказать следующий шаг: `aistats install --claude-code` (затем `/config-apply`) и `aistats install --opencode`.
- **Обновление**: повторный запуск той же строки — идемпотентно заменяет `~/.local/lib/aistats`.
- **Удаление**: `install.sh --uninstall` (снять symlink + `~/.local/lib/aistats`; данные `~/.aistats` не трогать без `--purge`).
- **Сборка релиза (dev-сторона)**: `npm run build` (tsc → `dist/`) → `scripts/release.sh` тарит `dist bin package.json`, ставит тег `vX.Y.Z`, `gh release create`. Windows вне scope `curl|sh`.
