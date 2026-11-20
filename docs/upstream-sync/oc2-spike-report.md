# Spike OpenCode 2 для Loginom AI Agent (этап A3)

16.11.2026. Ветка `oc2-spike` от `v040@6adfe42cea`.
- **База:** песочница OpenCode **v2.3.0** (`a6b15d33da`, тег от 13.11.2026).
- **Модель:** сценарная OpenAI-совместимая заглушка (`spike/oc2/harness/mock-llm.ts`), без настоящей LLM и без Loginom.
- **Платформа:** только Linux x64, Bun 1.4.3; запуск из исходников, без установленных сборок.
- **Где код:** стенд, плагин-прототип и правки лежат в [`spike/oc2/`](../../spike/oc2/README.md), каждая проверка запускается одной командой.

## Итог

| # | Проверка | Итог | Коротко |
|---|---|---|---|
| S1 | Скрытый инструмент: напрямую, через CodeMode `execute`, подсессия, расписание | **PASS** | 4 из 4 вызовов без допуска отклонены, контрольный вызов с допуском выполнен |
| S2 | Аренда Host: succeeded / failed / interrupted / SIGTERM / kill -9 | **PASS** | освобождение за 21–47 мс; после kill -9 зависшая аренда найдена при следующем старте |
| S3 | Навыки из `.agents`, `.claude`, проекта, `skills[]`, `/experimental/.../skill` | **PASS** с U1+U3 | без U1 база провалена: чужие навыки видны модели, самозванец подменяет `loginom-automation` |
| S4 | Данные 0.4.x (база v040) → v2 | **FAIL** | v2.3.0 молча теряет историю сессий, хотя сообщает `completed` |
| S5 | Изоляция фоновой службы | **PASS** с U5 | без U5 вторая служба зависает на занятом порту или подхватывает чужую |
| S6 | Исходящие соединения: старт, чат, простой | **PASS** (сервер) | штатно ходит только в `models.opencode.ai`; с ключами продукта — 0 обращений; Desktop не проверялся |
| S7 | RPC/SSE, запрос `loginom.access`, допуск посреди хода | **PARTIAL** | серверная часть проходит; отрисовка в окне приложения не проверялась |
| S8 | Пакет из конфига подменяет или выключает плагин продукта | **PASS** с U1 | без U1 обе атаки срабатывают |
| S9 | Навыки Hub с id через точку, `reload`, KV, GUI-бандл | **PARTIAL** | на Linux всё работает; Windows и упоминание навыка в окне приложения не проверялись |
| S10 | Страница и пункт навигации в UI | **PASS** по размеру | 20 строк в 4 файлах upstream плюс один новый файл; typecheck чистый; в браузере не отрисовано |

**Рекомендации:**
- **Целевой тег — v2.3.0.** От v2.2.7 он отличается 192 коммитами. В API плагинов добавлены хук `session.fork` (по нему допуск можно не переносить в форк сессии) и `metadata` у сообщений запроса. Реестры GUI и маршруты те же.
- **Перенос данных 0.4.x** выносим в отдельный шаг до старта службы (подробнее в S4).

## Доказательства

Доказательства — выдержки из JSON проверок; полный вывод в `spike/oc2/.run/<проверка>.out`. Пути к реальным файлам машины в отчёте обезличены.

### S1 — шлюз инструментов (`bun s1.ts`)
Плагин скрывает `loginom_dock_prepare` (`codemode:false`) в хуке `context` и отклоняет вызов в `execute.before`, если у сессии нет допуска.

| Путь вызова | Что ответило ядро | `tool.executed` |
|---|---|---|
| Напрямую | `"loginom.product: loginom_dock_prepare requires a Loginom access grant"` | 0 |
| CodeMode `execute` → `tools.loginom_dock_codemode(...)` | `execute.before allowed:false`, во вложенном вызове `status:"error"` | 0 |
| Подсессия `subagent` из сессии с допуском | вызов ребёнка `allowed:false` | 0 |
| Расписание `schedule_create` с пробуждением через 3 с | допуск закончился на `session.execution.succeeded`, вызов при пробуждении `allowed:false` | 0 |
| Контроль: допуск через RPC `loginom.runner.start` | — | 1 |

**Находка.** Инструмент с `codemode:true` (по умолчанию) виден в каталоге CodeMode в системном промпте даже без допуска. Вызвать его нельзя, но модель его видит. Поэтому все инструменты Loginom регистрируем с `codemode:false` (уровень L1).

### S2 — аренда Host (`bun s2.ts`)

| Случай | Причина освобождения | Задержка |
|---|---|---|
| Успех | `session.execution.succeeded` | 47 мс после последнего ответа модели |
| Ошибка провайдера (HTTP 400) | `session.execution.failed` | — |
| Прерывание во время ответа модели | `session.execution.interrupted` | 21 мс |
| Прерывание во время инструмента | `session.execution.interrupted` | 27 мс |
| SIGTERM | `plugin.dispose` (очистка из `setup`) | 34 мс, процесс завершился через 123 мс |
| kill -9 | файл аренды остался; после рестарта `lease.requires-recovery`, возраст 7196 мс | — |

Финализатор хода в ядро добавлять не нужно: хватает событий `session.execution.*` и очистки при выгрузке плагина.

**Оговорка.** Проверка зависших аренд срабатывает только при активации плагина в location, то есть лениво. В продукте её нужно делать при старте службы.

### S3 — источники навыков (`bun s3.ts`)
В песочнице разложены навыки в `~/.agents`, `~/.claude`, в проектных `.agents`, `.claude`, `.opencode`, в `skills[]` конфига, плюс самозванец `~/.agents/skills/loginom-automation`.

| | База (плагин из конфига, без швов) | Цель (U1 + U3) |
|---|---|---|
| `GET /api/skill` | 23 навыка, среди них все чужие и реальные `~/.claude/skills` машины | `loginom-automation` (из встроенного каталога) и `hub.community-review` |
| `loginom-automation` | самозванец из `~/.agents` | встроенный |
| Чужие навыки в системном промпте | 6 из 6 | 0 |
| `/experimental/session/:id/skill` для навыка сообщества во время допуска | 204 (обход) | 500, отказ по правам |
| То же для удалённого навыка | 204 | 404 `SkillNotFoundError` |

**Находки:**
1. Без U1 плагин продукта не управляет навыками. `ConfigSkillPlugin` и `BrowserPlugin` стоят в `post`, добавляют навыки после нашего `transform` и перезаписывают id.
2. Каталоги навыков ищутся от домашнего каталога ОС, а не от `HOME`. Поэтому в песочнице подхватились реальные `~/.claude/skills` пользователя, и фильтр продукта обязателен.
3. U3 сейчас отвечает HTTP 500, а нужна типизированная ошибка, например 403.

### S4 — данные 0.4.x → v2 (`bun s4.ts`)
1. CLI форка v040 (`packages/opencode`, backend v1) создал профиль: `loginom-ai-agent.db`, `session` 1, `message` 2, `part` 1.
2. Сервер v2.3.0 открыл копию через `OPENCODE_DB`.
3. Результат: `GET /api/experimental/migration/v1` ответил `{"status":"completed"}`, `GET /api/session` вернул `[]`. После повторного старта то же самое.
4. В базе после v2: таблиц `session`, `message`, `part` нет, `session_v2` пуста (0 строк), в `migration` 59 записей.

Почему так: в базе форка уже есть своя таблица `migration` (38 записей линии v1.19.5) и нет маркера `20260730195856_optional_session_title`. Миграция v2 `20260804233008_loose_psylocke` идёт по ветке «переиграть сквош V1» и удаляет старые таблицы. Потом `V1Migration` не находит таблицу `session` и считает перенос завершённым.

**Запасной вариант (принят):**
- отдельная команда `loginom-ai-agent migrate`, только под Bun;
- запускается до старта службы;
- читает базу 0.4.x как источник только для чтения, оригинал оставляет резервной копией;
- пишет новую базу v2 через `V1Migration.transformSession`;
- ловит ошибку и останавливается, а не сообщает `completed`.

Обязательная проверка этапа B: профили 0.3.9 и 0.4.x на Windows и Linux. Ни там, ни там она не запускалась.

### S5 — фоновая служба (`bun s5.ts`)

| Сценарий | Первая служба | Вторая служба |
|---|---|---|
| База: два продукта, разные каталоги, штатный порт `49375` | слушает | жива, но молчит 12 с: порт занят |
| База: два профиля в общих каталогах | слушает | подхватила первую и вышла с кодом 0 |
| U5: `loginom-ai-agent-desktop` и `loginom-ai-agent-cli-work` | `31643` | `53590` |
| U5 в общих каталогах | `31643` | `53590`, свои файлы `service-<identity>.json` |

Переименование каталогов (`apply-identity`) разводит файлы регистрации, но не порт. Правка U5 нужна.

### S6 — исходящие соединения (`sudo bun s6.ts 600`)
**Как запускалось:**
- сервер песочницы под `strace -f` (`connect`, `sendto`, `sendmsg`) в network namespace, где есть только loopback (`unshare -n`);
- сценарий: старт → прогрев → чат с вызовом `todowrite` → простой;
- простой длился около 19 минут (фактический прогон; по плану было 30) — это примерно 4 цикла обновления каталога моделей (раз в 5 минут).

| Конфигурация | Попытки соединения вне loopback | DNS-запросы |
|---|---|---|
| Штатная (`OPENCODE_DISABLE_MODELS_FETCH` не задан) | 0 | `models.opencode.ai` × 48 |
| Продукт: встроенный плагин, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_FREE_MODELS=1`, `OPENCODE_DISABLE_CLAUDE_CODE=1` | 0 | 0 |

Вывод: в штатном режиме сервер сам ходит в сеть только за каталогом моделей, и известные переключатели это закрывают. Ни npm, ни обновлений, ни телеметрии в этом сценарии не было.

**Чего проверка не покрывает:**
- **Обращения, которые включают функции,** а не сам сервер: `webfetch`, `websearch`, LSP, форматтеры, npm-SDK провайдеров, удалённые MCP, суточная проверка обновлений плагинов. Их перекрывают политика и transforms (таблица контура в плане).
- **Desktop:** Electron, GUI-плагин обновлений, словари проверки орфографии.
- **Сколько бы было обращений при живом DNS.** Здесь DNS недоступен, поэтому видны только имена, а не сами соединения.

Итог для критерия: **PASS для сервера**. Desktop и функции, включаемые моделью, проверяются на установленных сборках на этапе F.

### S7 — RPC, SSE и доступ (`bun s7.ts`)
- **RPC до первой работы в location:** `400 rpc.unavailable: loginom.runner`. RPC и `GET /api/skill` (он отдаёт пустой список) появляются только после ленивой активации плагинов location. GUI должен прогревать location, например созданием сессии, и повторять запрос.
- **После прогрева:**
  - RPC `start` → `200 {"granted":true}`, в SSE пришло событие `rpc.loginom.runner.stage`.
  - Модель вызывает `loginom_request_access`: клиент видит `permission.asked` с `action:"loginom.access"` и `metadata.reason:"open sales.lgp"`.
  - Ответ `once` → `grant.minted`, следующий запрос к модели уже предлагает `loginom_dock_prepare`, вызов выполняется.
- **Отказ (`reject`):** допуска нет, инструмент не выполнен.
- **Ответ `always`:** в новой сессии запрос всё равно задаётся снова, потому что хук `evaluate` выставляет `ask`.
- **Не проверено:** окно приложения (GUI-плагин, отрисовка запроса).

### S8 — подмена плагина продукта (`bun s8.ts`)

| | База (встроен, последним в `post`, без защиты) | U1 |
|---|---|---|
| Пакет из конфига с `id: "loginom.product"` | самозванец `active`, встроенный `failed: Duplicate plugin ID` | встроенный `active`, пакет `failed: Plugin ID is reserved by a built-in plugin` |
| `plugins: ["-loginom.product"]` | плагин продукта выключен, шлюза нет | плагин продукта активен, шлюз работает |
| Вызов `loginom_dock_prepare` без допуска | «No tool named …» (шлюза нет, инструмента нет) | отказ шлюза |

### S9 — Hub (`bun s9.ts`)
- **Навык `hub.community-review` (id через точку):**
  - через инструмент `skill` — `completed`, содержимое пришло;
  - вложение в подсказку `skills:[{id}]` — 200, текст навыка есть в сессии;
  - правило `{"action":"skill","resource":"hub.*","effect":"deny"}` — `Permission denied: skill`.
- **`ctx.skill.reload()`:** навык, добавленный в каталог Hub после старта, появляется после reload и исчезает после удаления и повторного reload.
- **KV (`ctx.storage`, один процесс, Linux):**

  | Нагрузка | Запись | Чтение |
  |---|---|---|
  | 1 МБ | 4 мс | 0,9 мс |
  | 10 МБ | 62 мс | 11,6 мс |
  | 1000 ключей | 127 мс | scan 0,8 мс |

  Отдельная `hub.db` не нужна.
- **GUI-бандл:** пакет из конфига с `./gui-experimental` виден как `features.gui: true`, `GET /api/plugin/gui?id=…` отвечает 200.
- **Не проверено:** Windows; упоминание навыка в поле ввода окна приложения.

### S10 — страницы и навигация в UI
- **Что сделано:**
  - общий реестр `Page` в `@opencode/plugin/gui`;
  - маршрут `/page/:plugin/:page`;
  - тип маршрута в `currentRoute`;
  - `PluginPageNav` в вертикальной боковой панели.
- **Проверка:** `tsc -b` в `packages/app` и `tsc --noEmit` в `packages/plugin` прошли. Что `tsc` действительно проверяет исходники, подтвердила пробная ошибка, вставленная в один файл.
- **Не проверено:** отрисовка в браузере и Desktop; поведение вкладок для страниц (`shell/tabs/schema.ts`).

## Правки в файлах OpenCode (держим в форке, каждую — в `catalog.json`)

| Шов | Файл | Строк | Проверено |
|---|---|---|---|
| U1 | `core/src/plugin/internal.ts` | +8 −1 | S3, S8 |
| U1 | `core/src/plugin/supervisor.ts` | +10 | S8 |
| U1 | `core/src/plugin/product.ts` (новый файл форка) | +12 | S1–S9 |
| U3 | `core/src/session/skill.ts` | +10 | S3 |
| U5 | `cli/src/services/service-config.ts` | +6 | S5 |
| UI | `plugin/src/gui/registries.ts` | +13 | S10 |
| UI | `app/src/shell/routes/routes.tsx` | +2 | S10 |
| UI | `app/src/shell/state/layout.tsx` | +3 | S10 |
| UI | `app/src/shell/titlebar/titlebar.tsx` | +2 | S10 |
| UI | `app/src/runtime/plugin/pages.tsx` (новый файл) | +44 | S10 |

**Итого в существующих файлах upstream: 56 добавленных строк и 1 удалённая.**

Спайковые переключатели `LOGINOM_SPIKE_*` в продукте заменяются постоянной сборкой, объём от этого почти не меняется.

**Не мерились, но известны из исследования:**
- регистрация встроенных GUI-плагинов (`gui-plugins/src/{renderer,main}.ts`, +2);
- `tabLayout` по умолчанию (+1);
- `defaultTheme` и бренд;
- экспорт `ToolRegistry` из `session-ui`;
- preflight политики (U2, `cli/src/server-process.ts`);
- встроенный конфиг продукта (U4);
- лента обновлений;
- шов `installationNode`.

## Пересчёт этапа B

В `opencode-2-migration.md` §6 оценка 37–62 агенто-дня (середина около 50). После spike предлагаю **30–49, середина около 40**, критический путь около 20–30. Это сумма столбца «Стало» в таблице ниже; первая версия отчёта ошибочно давала 28–45. Снижение почти целиком — перенос работы: фазу 0 сделал spike, фаза 5 ушла в этап C.

| Фаза §6 | Было | Стало | Почему |
|---|---|---|---|
| 0 Прототип | 2–3 | 0 | сделан этим spike |
| 1 База v2.3.0 + пакеты форка + идентичность | 4–6 | 3–5 | швы найдены и малы, конфликтов в ядре меньше |
| 2 Плагин Loginom | 8–14 | 7–11 | механика допуска, шлюза, навыков, аренды и RPC подтверждена; остаётся перенос 5,2 тыс. строк инструментов и CLI `standalone` |
| 3 Данные 0.4 → 0.5 | 3–5 | 4–6 | S4 показал потерю данных, нужна своя команда `migrate` |
| 4 Desktop | 8–14 | 8–14 | не проверялось: DPAPI, прокси, политика обновлений, onboarding |
| 5 App/UI | 4–7 | 0 | переходит в этап C (новый интерфейс) |
| 6 CI и выпуск | 3–5 | 3–5 | без изменений |
| 7 Паритет | 5–8 | 5–8 | без изменений: приёмка узлов, чек-лист Windows |

**Главные риски:**
1. **Перенос данных** (S4): потеря истории без ошибки. Без своей команды `migrate` выпускать нельзя.
2. **Ленивая активация location:** RPC, список навыков и восстановление аренды требуют прогрева или глобального шага при старте.
3. **Windows не проверялся:** пути, порты, KV, служба.
4. **Bun:** v2.3.0 закреплён на 1.4.4, форк — на 1.3.14 (решение владельца №3). В песочнице 1.4.3 не знает `bun check --no-script`, поэтому typecheck шёл через `tsc`.
5. **Экспериментальные части API** (`experimental.*`, хук `context` над `tools`): нужны контрактные тесты на каждый используемый хук.

## Этап B: ранние проверки

### B1.1 Точка отсечения

20.11.2026.
- **База:** `v040` форка, `6adfe42cea`.
- **Точка отсечения:** `a080f7725c` (`upstream/v040`, слияние PR #1243), на 237 коммитов впереди базы (из них 73 слияния, 10–20.11.2026). Внутри — функция «дашборды узлов».
- **Стенд:** Linux x64, запуск от root, 11 ГБ ОЗУ, Bun 1.4.3, Node 24.19.0 (сумма совпадает с `nodeSha256` из `loginom-release.json`).
- **Команды:** раздел «Как запускать» в `guarantees.md`, файл одинаков на обоих SHA. Каждый SHA гонялся в чистом дереве (база — в новом detached-дереве, точка отсечения — после `git clean -fdx`) с `bun install --frozen-lockfile`.

| Набор | База | Точка отсечения, подготовка по документам | Точка отсечения + `npm ci` шаблона dashboard (как unit CI) |
|---|---|---|---|
| `product` | 55 / 0 | 61 / 0 | 61 / 0 |
| `core` (`flag-identity`) | 2 / 0 | 2 / 0 | 2 / 0 |
| `opencode` (7 каталогов) | 1777 / 6, 15 пропущено | 1842 / **23**, 15 пропущено | 1859 / 6, 15 пропущено |
| `loginom-host` | 502 / 2, 12 пропущено | 534 / 2, 12 пропущено | 534 / 2, 12 пропущено |
| `desktop` | 254 / 1, 6 пропущено | 268 / 1, 6 пропущено | 268 / 1, 6 пропущено |
| `selftest.sh` | PASS | PASS | PASS |

Формат ячеек: прошло / упало. Тесты сравнивались по паре «файл + имя» (JUnit).

**Новые падения: 17 при подготовке по документам, 0 при подготовке как в CI.**
- **Где:** все 17 — в новых тестах, на базе этих файлов нет. 16 в `test/tool/dashboard.test.ts`:
  - `a changed server version requires new confirmation and preserves edited sources`;
  - `a publication confirmation cannot send the old draft after recreation`;
  - `dashboard_draft limits the complete diagnostic output to whole UTF-8 code points`;
  - `delete keeps sources and live preview after {denied, invalid, invalid count, unknown}`;
  - `host failure preserves the draft and its specific reason without retry: {DASHBOARD_ACCESS_DENIED, DASHBOARD_VERSION_EXISTS, DASHBOARD_WRITE_UNKNOWN, LOGINOM_RUNTIME_CLEANUP_FAILED}`;
  - `interruption joins an active publication build before removing its operation`;
  - `publication limits the complete model output to whole UTF-8 code points`;
  - `publishing with a global allow still asks once for the bound node and package: {abort, once, reject}`.

  Ещё одно — в `test/cli/standalone-dashboard.test.ts`: `standalone dashboard starts from the snapshot and preserves explicit publication approval`.
- **Повтор в одиночку:** оба файла падают так же (13/16 и 7/1).
- **Причина у всех одна:** `DASHBOARD_RESOURCES_MISSING: в установке нет компонентов dashboard`. Тестовые ресурсы ссылаются на `packages/dashboard/template`, а его `node_modules` ставится отдельным `npm ci`.
  - Задание `unit` в `.github/workflows/test.yml` делает этот шаг, «Как запускать» в `guarantees.md` и шаг `install` в `procedure.md` — нет.
  - После `npm ci --ignore-scripts` в `packages/dashboard/template`, как в CI, оба файла проходят в одиночку (29/0 и 8/0), а полный прогон даёт третий столбец.
- **Тесты с базы:** ни один не покраснел, ни один не пропал.
  - 8 тестов `loginom-host`, которых нет на точке отсечения, переименованы, и под новыми именами проходят:
    - `file-reference`, случай `bytes`: переименован и изменён, тест теперь сам сдвигает mtime;
    - 6 случаев `saved-package-shutdown` «private CLI policies reach …»;
    - полная сборка `stage-resources`, пропущенная на обеих сторонах.
  - Число пропущенных тестов не выросло.
- **Предложение владельцу:** добавить `npm ci` шаблона в «Как запускать» и в шаг `install`. Здесь документы не правились.

**Базовые падения стенда — одни и те же на базе и в обоих прогонах точки отсечения** (сверены имена и блоки ошибок; отличается только номер строки в `managed-work-entry`):
- **Отказ доступа, который не срабатывает под root.**
  - В `opencode` 5 тестов:
    - `standalone-file-errors` (`denied`);
    - `loginom-local-file` (denied);
    - `package-docs` (OS read refusal);
    - `write` (OS denies write access);
    - `file-snapshot` (OS denial).
  - В `loginom-host` — `managed-work-entry`: «Expected refusal», по коду теста это случай `denied` через `chmod 0`.
  - В `desktop` — `log-retention` (`cannot be deleted`).
- **`cli-manifest` «archive verification preserves manifest modes under a private umask»** — падение, уже известное по разделу «Базовые падения стенда».
- **`opencode` `test/cli/standalone.test.ts` «provider management uses the CLI profile without Loginom configuration or bundle»** (охранный тест G2): в корне появляется лишний каталог `desktop-cache`. Это `XDG_CACHE_HOME` теста, в него пишет dconf (`desktop-cache/dconf/user`), а на стенде установлен `dconf-gsettings-backend`.
  - С переносным Bun 1.3.14 на базе этот файл падает так же, то есть дело не в версии Bun.
  - На обеих сторонах падение одинаковое. Но два утверждения после упавшего (профиль без `.writer`, пустой `profile/loginom`) не выполнялись ни на базе, ни на точке отсечения.

**Отступления от буквальных команд — одинаковые для обеих сторон:**
1. Шаг `install` из `procedure.md`: `npm ci --ignore-scripts --omit=dev --no-audit --fund=false --workspaces=false` в `packages/loginom-runtime/client`. Без него `product` 54/1: в `automation-routing` нет `acorn`.
2. `LOGINOM_AI_AGENT_TEST_NODE` и `LOGINOM_AI_AGENT_NODE_SOURCE` заданы для всех наборов, как в задании `unit` CI. В «Как запускать» переменная есть только у `loginom-host`, а без неё у `opencode` на базе 66 падений вместо 6. Это второй пробел в командах.
3. Node 24.19.0 стоит первым в `PATH`, как `node-version-file` в CI. Системный Node — другой версии.
4. Chromium ревизии 1246 на стенде нет, поэтому браузерные переменные не заданы.
5. Bun 1.4.3 вместо закреплённого 1.3.14. Из 9 базовых падений 7 — отказ доступа под root, 1 — известное umask, 1 — dconf; последнее повторено на Bun 1.3.14. Полные наборы на 1.3.14 не гонялись.

**Объём для ручного переноса** (`git diff --shortstat 6adfe42cea a080f7725c`):

| Часть | Файлов | Строк |
|---|---|---|
| `packages/opencode` | 46 | +3549 −170 |
| `packages/dashboard` (новый пакет) | 111 | +15612 |
| остальное | 368 | +23357 −1357 |
| всего | 525 | +42518 −1527 |

**Что в «остальном»:**
- 108 файлов `docs` (+10851 −264);
- `packages/loginom-runtime`: 85 файлов (+3609 −352);
- `packages/app`: 40 файлов (+1714 −255);
- `packages/desktop`: 29 файлов (+1437 −192);
- `packages/loginom-host`: 26 файлов (+913 −117);
- `packages/product`: 17 файлов (+328 −96);
- `deploy`, `dashboard`, `scripts`, `.gitleaksignore` и мелочь.

**В `packages/opencode`:**
- **Объём:**
  - `src` — 26 файлов, +779 −108, из них 3 новых;
  - `test` — 18 файлов, +2761 −62, из них 5 новых;
  - `AGENTS.md` и `package.json` — +9.
- **Швы гарантий:** изменены `product/{tool-policy,tool-contributor,turn-lifecycle}.ts` и `session/{prompt,tools,task-scope}.ts`. Их охранные тесты на точке отсечения зелёные, но при переносе на v2 эти правки придётся учесть.

| Файл (`packages/opencode/`) | Статус | Строк |
|---|---|---|
| `AGENTS.md` | изменён | +8 −0 |
| `package.json` | изменён | +1 −0 |
| `src/cli/cmd/import.ts` | изменён | +35 −9 |
| `src/cli/cmd/run.ts` | изменён | +64 −10 |
| `src/cli/cmd/run/runtime.stdin.ts` | изменён | +44 −0 |
| `src/cli/cmd/run/tool.ts` | изменён | +3 −0 |
| `src/cli/standalone-dashboard.ts` | новый | +20 −0 |
| `src/cli/standalone-run.ts` | изменён | +63 −6 |
| `src/command/index.ts` | изменён | +3 −1 |
| `src/format/index.ts` | изменён | +2 −1 |
| `src/lsp/lsp.ts` | изменён | +2 −1 |
| `src/permission/index.ts` | изменён | +10 −6 |
| `src/product/dashboard-session.ts` | новый | +71 −0 |
| `src/product/tool-contributor.ts` | изменён | +11 −0 |
| `src/product/tool-policy.ts` | изменён | +17 −3 |
| `src/product/turn-lifecycle.ts` | изменён | +21 −15 |
| `src/session/prompt.ts` | изменён | +27 −6 |
| `src/session/session.ts` | изменён | +44 −2 |
| `src/session/task-scope.ts` | изменён | +2 −1 |
| `src/session/tools.ts` | изменён | +20 −3 |
| `src/tool/apply_patch.ts` | изменён | +10 −13 |
| `src/tool/dashboard.ts` | новый | +226 −0 |
| `src/tool/edit.ts` | изменён | +7 −6 |
| `src/tool/external-directory.ts` | изменён | +51 −2 |
| `src/tool/glob.ts` | изменён | +10 −9 |
| `src/tool/grep.ts` | изменён | +10 −10 |
| `src/tool/tool.ts` | изменён | +1 −0 |
| `src/tool/write.ts` | изменён | +5 −4 |
| `test/cli/bundled-skills.test.ts` | изменён | +5 −5 |
| `test/cli/import.test.ts` | изменён | +68 −0 |
| `test/cli/standalone-dashboard-pty.py` | новый | +72 −0 |
| `test/cli/standalone-dashboard.test.ts` | новый | +498 −0 |
| `test/fixture/standalone.ts` | изменён | +41 −30 |
| `test/product/dashboard-session.test.ts` | новый | +134 −0 |
| `test/product/tool-policy.test.ts` | изменён | +31 −0 |
| `test/product/turn-lifecycle.test.ts` | изменён | +30 −1 |
| `test/server/httpapi-sync.test.ts` | изменён | +44 −0 |
| `test/session/profile-tools.test.ts` | изменён | +96 −4 |
| `test/session/prompt.test.ts` | изменён | +375 −14 |
| `test/session/session.test.ts` | изменён | +9 −2 |
| `test/session/task-scope.test.ts` | изменён | +29 −0 |
| `test/session/tools.test.ts` | изменён | +10 −2 |
| `test/skill/bundled-skills.test.ts` | изменён | +3 −3 |
| `test/tool/dashboard-guard.test.ts` | новый | +523 −0 |
| `test/tool/dashboard.test.ts` | новый | +792 −0 |
| `test/tool/external-directory.test.ts` | изменён | +1 −1 |

**Не прогонялось:**
- живые сценарии Desktop/CLI;
- `test/server` в `opencode`: там изменён `httpapi-sync.test.ts`, но в командах гарантий его нет;
- typecheck;
- полная сборка ресурсов `stage-resources` — нужен Chromium 1246;
- `desktop` `draft-store.test.ts` — исключён самой командой.
