# Spike: OpenCode 2 для Loginom AI Agent (этап A3)

Одноразовый стенд для проверки критериев S1–S10 и интерфейса. Это не код продукта. Итоги и доказательства лежат
в [`docs/upstream-sync/oc2-spike-report.md`](../../docs/upstream-sync/oc2-spike-report.md) и
[`docs/upstream-sync/oc2-spike-ui-report.md`](../../docs/upstream-sync/oc2-spike-ui-report.md) (часть 2, интерфейс).

## Состав

| Путь | Что |
|---|---|
| `setup.sh [тег]` | Создаёт песочницу `opencode/` (detached worktree тега, по умолчанию `v2.3.0`), ставит зависимости, делает ссылки на плагины и накладывает `patches/*.patch` |
| `patches/` | Швы в файлах OpenCode: U1 (плагин продукта последним и под защитой), U3 (права при прямой активации навыка), U5 (своя служба на продукт и профиль), реестр страниц и пункт навигации в UI, отрисовка инструментов (`ui-tool-registry.patch`) и пример отрисовщика Loginom (`ui-tool-renderer-loginom.patch`). Сторона U5 в Desktop (`u5-desktop-service-file.patch`, B0.4): окно ищет службу в том же файле `service-<identity>.json` |
| `plugin/loginom-product/` | Прототип серверного плагина: шлюз инструментов (`context` + `execute.before`), источник навыков, допуск через RPC и `loginom.access`, имитация аренды Host, журнал действий (`LOGINOM_SPIKE_JOURNAL`, S11) |
| `plugin/impostor/`, `plugin/gui-probe/` | Самозванец для S8 и пакет с GUI-бандлом для S9 |
| `plugin/loginom-ui-demo/` | Демонстрационные инструменты Loginom для части 2: шаги, сохранение с разрешением, правка пакета с `metadata.changes`, сбой. GUI-часть `gui.cjs` (B0.1): страница с пунктом навигации и RPC из окна |
| `harness/` | Сценарная модель (OpenAI-совместимая заглушка), обвязка сервера, проверки `s1.ts` … `s9.ts`, `s11.ts`, сервер для веб-приложения `ui.ts` (часть 2), окно Desktop `desktop.ts` (B0.1), установленная сборка `installed.ts` с конфигом упаковки `electron-builder.spike.ts` и набором для NSIS `nsis-kit.ts` (B0.4) |
| `run-server.sh` | Запуск сервера песочницы с изолированными каталогами XDG |
| `setup-windows.sh`, `setup-windows.ps1` | Песочница на стенде Windows по SSH: архив тега с правками, переносной Bun, зависимости, запуск проверок и уборка |
| `build-installed.sh` | B0.4: установщик песочницы штатными скриптами upstream — AppImage для Linux; для Windows распакованное приложение и набор для NSIS |
| `installed-windows.sh`, `installed-windows.ps1` | B0.4: NSIS-установщик и проверка установленной сборки на стенде Windows, снимки до и после, уборка |

Каталоги `opencode/` и `.run/` и ссылки `node_modules` в Git не входят.

## Запуск

```sh
spike/oc2/setup.sh                         # один раз
cd spike/oc2/harness
bun s1.ts   # скрытый инструмент: напрямую, CodeMode, подсессия, расписание
bun s2.ts   # аренда Host: успех, ошибка, прерывание, SIGTERM, kill -9
bun s3.ts   # источники навыков: базовый режим и U1+U3
bun s4.ts   # данные v040 → v2 (нужен `npm ci` в packages/loginom-runtime/client)
bun s5.ts   # изоляция фоновой службы: база и U5
sudo bun s6.ts 600   # аудит исходящих соединений в network namespace (strace)
bun s7.ts   # RPC, события SSE, запрос loginom.access
bun s8.ts   # подмена id плагина продукта: база и U1
bun s9.ts   # навыки Hub с id через точку, reload, KV, GUI-бандл
bun s11.ts  # журнал действий: инструмент напрямую, CodeMode, подсессия, расписание, каждый запрос к модели (~1,5 мин)
bun ui.ts   # часть 2: сервер :4096 для веб-приложения, сценарии в .run/ui/prompts.json
bun desktop.ts   # B0.1: окно Desktop под Xvfb со своей службой, снимки и report.json в .run/b0-window/ (~22 с)
```

Веб-приложение для части 2: `cd opencode/packages/app && VITE_OPENCODE_SERVER_PORT=4096 bun dev` (порт 5173).

Окно Desktop для B0.1 собирается один раз, без упаковки (около 25 с, пик памяти 2,6 ГБ):
`cd opencode/packages/desktop && mkdir -p ../../../.run/cache/electron && electron_config_cache=$(cd ../../../.run/cache/electron && pwd) bun run install-electron && bun ./script/copy-icons.ts dev && OPENCODE_CHANNEL=local bunx electron-vite build`.

### Установленная сборка (B0.4)

```sh
spike/oc2/build-installed.sh linux      # ~2 мин: CLI, out/, AppImage в .run/b0-installed/dist-linux/
cd spike/oc2/harness && bun installed.ts linux ../.run/b0-installed/dist-linux/opencode-desktop-linux-x86_64.AppImage   # ~4 мин
B0_U5_DESKTOP=0 bun installed.ts linux ../.run/b0-installed/dist-linux/opencode-desktop-linux-x86_64.AppImage   # U5 только в CLI, ~2,5 мин
spike/oc2/build-installed.sh windows    # ~2 мин: CLI под bun-windows-x64-baseline, out/, win-unpacked и nsis-kit
spike/oc2/installed-windows.sh winstand # копирование, Bun на стенде, NSIS, проверка, забор журналов
spike/oc2/installed-windows.sh winstand clean
```

`build-installed.sh` качает Bun 1.4.4 в `.run/cache`: скрипты сборки upstream не идут на 1.4.3. Канал CLI — `latest`, канал Desktop — `prod`,
версия `2.3.0-b04`. Лента обновлений направлена на закрытый порт `127.0.0.1:9`. Сборка перезаписывает `opencode/packages/desktop/out`,
поэтому перед `desktop.ts` (B0.1) окно собирают заново командой выше. `installed.ts` включает правки окружением запуска:
`LOGINOM_SPIKE_BUILTIN`, `LOGINOM_SPIKE_U3`, `LOGINOM_SPIKE_U5_IDENTITY`. Итог и доказательства — в `.run/b0-installed/<os>/run/report.json`
и `shots/`, на Windows — в `.run/b0-installed/windows/stand/`.

### Windows (S5, S9)

На стенде нужны только штатный Windows PowerShell 5.1, `tar.exe`, `curl.exe` и доступ к GitHub и npm. Git, Node и Bun
не нужны. Архив тега с наложенными `patches/*.patch` собирается на Linux. `setup-windows.ps1` распаковывает его
в `C:\lab\b0-windows`, качает переносной Bun 1.4.4, сверяет SHA-256 и ставит зависимости. На процессоре без AVX2
берётся сборка `baseline`. Кэши Bun, OpenCode и Electron, `TEMP` и домашний каталог тоже лежат в этой папке, в систему
ничего не ставится.

```sh
spike/oc2/setup-windows.sh winstand        # один раз: архив, копирование по scp, Bun, bun install
ssh winstand powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\lab\b0-windows\setup-windows.ps1' -Action run -Check smoke
ssh winstand powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\lab\b0-windows\setup-windows.ps1' -Action run -Check s5
ssh winstand powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\lab\b0-windows\setup-windows.ps1' -Action run -Check s9
ssh winstand powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\lab\b0-windows\setup-windows.ps1' -Action clean
```

Первый `s5` после установки может не успеть поднять службы в базовых сценариях за паузы 6 и 12 с. Тогда его
повторяют, строки U5 от этого не меняются. JSON печатается в SSH-сессию. Журналы лежат в `C:\lab\b0-windows\oc2\.run\`,
их забирают по scp до `clean`.
На Windows `env.ts` запускает сервер без `run-server.sh` и задаёт `USERPROFILE` рядом с `HOME`.
S1–S4 и S6–S8 на Windows не запускались.

Каждая проверка печатает JSON с итогом `PASS`/`PARTIAL`/`FAIL` и доказательствами. Журналы лежат
в `.run/<проверка>/`. Встроенный режим плагина включает `LOGINOM_SPIKE_BUILTIN=1`, правку U3 — `LOGINOM_SPIKE_U3=1`.
Базовый режим без защиты U1 включает `LOGINOM_SPIKE_U1_GUARD=0`, а U5 задаётся через `LOGINOM_SPIKE_U5_IDENTITY`.
