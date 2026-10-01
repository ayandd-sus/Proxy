# SillyTavern ↔ AITUNNEL: Claude proxy с prompt caching

Инструкция сверена **1 октября 2026 года**. Прокси поддерживает оба способа подключения SillyTavern, но основная инструкция ниже рассчитана на ваш вариант: **Anthropic-модель через Custom (OpenAI-compatible) Chat Completion**.

## Что делает прокси

- Для OpenAI-compatible клиента принимает `POST /v1/chat/completions`, добавляет cache-параметры AITUNNEL и пересылает запрос на тот же маршрут AITUNNEL. Внутри этого маршрута формат Anthropic↔OpenAI преобразует сам AITUNNEL, не локальный прокси.
- Для встроенного источника SillyTavern **Claude** принимает нативный `POST /v1/messages`, преобразует локальный `x-api-key` в документированный AITUNNEL `Authorization: Bearer` и сохраняет формат Anthropic Messages.
- Для Claude добавляет верхнеуровневый `cache_control`, если клиент ещё не прислал явные cache-маркеры; сохраняет уже выставленные маркеры.
- По умолчанию добавляет непрозрачный HMAC `session_id` для привязки повторных запросов диалога к провайдеру AITUNNEL.
- Передаёт SSE-стрим без преобразования событий и выводит cache read/write-счётчики, если AITUNNEL вернул их.

Промпт не сохраняется и не пишется в логи. Чтобы добавить поля к JSON, прокси буферизует запрос в памяти, затем отправляет его в AITUNNEL.

## 1. Запустить прокси

Нужен **Node.js 20+**. Сторонние npm-пакеты не нужны.

1. Скопируйте `.env.example` в `.env`.
2. Впишите ключ AITUNNEL. Создайте отдельный локальный ключ для SillyTavern:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Пример `.env`:

   ```dotenv
   AITUNNEL_API_KEY=sk-aitunnel-ВАШ_КЛЮЧ
   PROXY_API_KEY=СЮДА_СЛУЧАЙНАЯ_СТРОКА_ИЗ_КОМАНДЫ
   AITUNNEL_BASE_URL=https://api.aitunnel.ru/v1
   PROXY_HOST=127.0.0.1
   PROXY_PORT=8787
   CACHE_MODE=auto
   CACHE_TTL=5m
   SESSION_AFFINITY=on
   ```

   `AITUNNEL_API_KEY` остаётся в `.env`; в поле API key SillyTavern нужно ввести **`PROXY_API_KEY`**, а не ключ провайдера.

3. Запустите сервис из каталога репозитория:

   ```bash
   npm start
   ```

   Проверка запуска: `http://127.0.0.1:8787/healthz` должна вернуть `{"status":"ok"}`. Тесты: `npm test`.

## 2. Подключить AITUNNEL в вашем режиме OpenAI-compatible

В SillyTavern:

1. Откройте **API Connections** и выберите именно **Chat Completion**, не Text Completion.
2. Источник: **Custom (OpenAI-compatible)**.
3. Укажите:
   - **Custom Endpoint / Base URL:** `http://127.0.0.1:8787/v1`
   - **API Key:** значение `PROXY_API_KEY` из `.env`
   - **Model:** точный ID Claude из каталога AITUNNEL, например `claude-sonnet-4.6`.
4. Нажмите **Connect**. Если модель не появилась в списке, введите её ID вручную.

Не добавляйте в URL `/chat/completions` и не ставьте завершающий `/`: SillyTavern добавляет маршрут сам. В этом режиме **не** включайте `Use a reverse proxy` из источника Claude — это настройка другого API-подключения.

Если SillyTavern работает в Docker, адрес `127.0.0.1` внутри контейнера указывает на сам контейнер. Используйте адрес хоста, доступный из контейнера (часто `host.docker.internal`), или общий Docker network. Чтобы прокси слушал не только loopback, задайте `PROXY_HOST=0.0.0.0`; не публикуйте его в интернет без TLS и firewall.

### Если решите переключиться на нативный Claude connector

Прокси также поддерживает его: выберите **Chat Completion → Claude**, включите **Use a reverse proxy**, задайте URL `http://127.0.0.1:8787/v1` и Proxy Password `PROXY_API_KEY`. ST сам добавит `/messages`. Эта инструкция приведена как запасной вариант; для вашей текущей OpenAI-compatible схемы используйте предыдущий раздел.

## 3. Как поставить и включить Freaky Frankenstein

Похоже, ваша ссылка ведёт к посту об **FF5.4 Internal States**. Короткую Reddit-ссылку в этой среде открыть не удалось (Reddit вернул 403), поэтому ниже опираюсь на [официальный архив](https://rentry.org/freaky-frankenstein-presets) и [объявление FF5.4](https://www.reddit.com/r/SillyTavernAI/comments/1w49lyx/preset_update_freaky_frankenstein_54_the_second/). На 01.10.2026 архив указывает FF5.4 как опубликованную версию; FF6 Micro там всё ещё помечен **Coming Soon**.

1. В архиве выберите **Freaky Frankenstein 5.4 → Internal States** — стандартный вариант для SillyTavern. Не берите вариант **Marinara Engine Agentic**, он предназначен для другого frontend. Вариант **FR / Hapuppy Forced Reasoning** нужен не для обычного Claude-подключения.
2. Включите Chat Completion в API Connections.
3. Откройте панель **AI Response Configuration** (иконка ползунков, первая слева), нажмите **Import preset** и выберите скачанный JSON. После импорта выберите FF5.4 в списке активных пресетов. Если импорт сообщает, что подходящих секций нет, проверьте, что вы не в Text Completion и открыли именно панель Chat Completion Presets.
4. В **API Connections → Chat Completion → Prompt Post-Processing** выберите **Semi-strict (alternating roles; no tools)** — автор FF5.4 рекомендует полустрогое чередование ролей без tools.
5. В панели **Advanced Formatting** (иконка `A`) снимите **Trim incomplete sentences**. Автор предупреждает, что эта настройка может обрезать внутренние XML-теги FF.
6. Сначала оставьте импортированные параметры и переключатели как есть. FF5.4 по умолчанию ориентирован на **BOLT**. Не включайте одновременно разные режимы Chain of Thought (например, BOLT, Micro и MAX) и не включайте все дополнительные модули разом. В самом пресете есть подсказки/README у переключателей — откройте их перед изменением.
7. Проверьте **Extensions → Regex**. Для FF5 требуется **FF5 Regex 3.0**; архив пишет, что он обычно включён/поставляется с пресетом и даёт отдельную ссылку на резервную загрузку. Если профиль не появился или правила не импортировались, скачайте Regex 3.0 из [официального архива](https://rentry.org/freaky-frankenstein-presets) и импортируйте его. Не импортируйте один и тот же набор повторно: дубли правил могут испортить форматирование.
8. Начните новый тестовый чат с персонажем. Карточка персонажа и пресет — разные вещи: пресет задаёт инструкции/параметры, а карточку импортируют отдельно.

Если ответы слишком долгие или модель теряет персонажа, не включайте дополнительные блоки наугад: FF5.4 сам предупреждает, что меньшим моделям нужно меньше Internal States. Сначала выключайте необязательные модули по одному или выберите более лёгкий режим из README пресета.

## 4. Кэширование именно при OpenAI-compatible подключении

В вашем режиме SillyTavern отправляет OpenAI-compatible Chat Completion, поэтому встроенные параметры **`claude.enableSystemPromptCache`** и **`claude.cachingAtDepth`** SillyTavern не управляют этим запросом. Прокси делает нужное автоматически: для Claude добавляет `cache_control` верхнего уровня на `/v1/chat/completions`. Ничего дополнительно добавлять в Custom Body Fields не нужно.

- По умолчанию `CACHE_MODE=auto`, `CACHE_TTL=5m`.
- `CACHE_TTL=1h` задаёт более долгий TTL; запись часового кэша у AITUNNEL дороже.
- `CACHE_MODE=off` выключает только маркер, добавляемый прокси. Уже имеющийся явный маркер он не удаляет.
- `SESSION_AFFINITY=on` добавляет стабильный непрозрачный `session_id`; можно выключить через `SESSION_AFFINITY=off`.

После двух достаточно длинных последовательных запросов смотрите терминал прокси: при наличии счётчиков будет строка `cache usage model=... read=... write=...`. Обычно первая отправка пишет кэш (`write`), следующая может читать его (`read`). Порог зависит от модели; короткий промпт, изменившийся префикс или истёкший TTL могут не дать cache hit.

FF5.4 Regex может удалять старые блоки Internal States из истории, экономя контекст. Но заявление автора о сокращении количества токенов **не равно** гарантированному cache hit: для чтения кэша AITUNNEL важны точное совпадение префикса, размер кэшируемого участка и время между запросами.

## Маршруты, безопасность и отладка

Прокси принимает только нужные маршруты:

- `GET /v1/models`;
- `POST /v1/chat/completions` — ваш OpenAI-compatible вариант;
- `POST /v1/messages` и `POST /v1/messages/count_tokens` — нативный Claude connector;
- `GET /healthz` — локальная проверка.

`401` на локальном прокси обычно означает, что в SillyTavern введён не тот `PROXY_API_KEY`. Если локальный запрос проходит, но AITUNNEL отвечает `401`, проверьте `AITUNNEL_API_KEY` в `.env`. Для Docker проверьте, что SillyTavern может достучаться до адреса и порта прокси. Остальные пути намеренно возвращают `404`.

По умолчанию прокси слушает только `127.0.0.1`, ограничивает тело запроса 128 MiB и не сохраняет историю промптов. Не коммитьте `.env` и не отправляйте его содержимое в чат.

## Источники

- [AITUNNEL: справочник API](https://aitunnel.ru/docs/api-reference)
- [AITUNNEL: prompt caching, TTL, пороги и usage](https://aitunnel.ru/docs/caching)
- [AITUNNEL: API-ключи](https://aitunnel.ru/docs/keys)
- [AITUNNEL: каталог моделей](https://aitunnel.ru/docs/models)
- [SillyTavern: Chat Completions и Prompt Post-Processing](https://docs.sillytavern.app/usage/api-connections/openai/)
- [SillyTavern: реализация Claude connector в `release`](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/backends/chat-completions.js)
- [Freaky Frankenstein: официальный архив](https://rentry.org/freaky-frankenstein-presets)
- [Пост автора FF5.4 от 1 сентября 2026 года](https://www.reddit.com/r/SillyTavernAI/comments/1w49lyx/preset_update_freaky_frankenstein_54_the_second/)
