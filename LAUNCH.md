# F1 България — Launch Guide

Pre-launch checklist + deploy/operations за production (Hetzner Cloud, Ubuntu).
V1 scope: пилоти, отбори, календар, новини, класиране, прогнози, терминология.
V2 модули са скрити зад feature flags (виж [config/features.php](config/features.php)).

---

## 1. Pre-launch checklist

**Сървър / среда**
- [ ] PHP 8.4+ (препоръчително 8.5, както на dev машината — [config/database.php](config/database.php) ползва `Pdo\Mysql`, наличен от 8.4), MySQL 8 (или 5.7), Nginx, Composer, Node 20+ инсталирани
- [ ] `.env` създаден от `.env.example` и попълнен за production: `APP_DEBUG=false`, `APP_ENV=production`, `APP_URL=https://padok.bg`, `SESSION_SECURE_COOKIE=true`, database драйвери за session/queue/cache
- [ ] `php artisan key:generate` (ако `APP_KEY` е празен)
- [ ] `APP_URL=https://padok.bg` и реален SMTP за поща (newsletter/верификация)
- [ ] Всички `FEATURE_*` са `false` (V1 scope)

**База данни**
- [ ] `php artisan migrate --force`
- [ ] Backfill на F1 данните: `php artisan f1:sync-history 1950 2025` (минали сезони; бавно — пусни в nohup/screen) + `php artisan f1:sync-season` (текущ)
- [ ] СЛЕД всеки sync на нови сезони: `php artisan constructors:backfill-canonical && php artisan drivers:backfill-canonical` — иначе профилите на новите пилоти/отбори връщат 404 (канонични записи)
- [ ] (по избор) F2 данни: `php artisan f2:sync-wikipedia --year=all` — само ако `FEATURE_F2=true`
- [ ] Поне един админ: потребител с `is_admin=true` (виж раздел 9)

**Assets / кешове**
- [ ] `npm ci && npm run build`
- [ ] `php artisan config:cache route:cache view:cache event:cache`
- [ ] `php artisan sitemap:generate` → `public/sitemap.xml`
- [ ] Warmup на тежките кешове (раздел 6)

**Cron / scheduler** (критично — виж раздел 5)
- [ ] `* * * * * php artisan schedule:run` в crontab на deploy потребителя

**Сигурност**
- [ ] HTTPS активен (Let's Encrypt), HTTP→HTTPS redirect
- [ ] `SESSION_SECURE_COOKIE=true`
- [ ] `.env` с права 600, собственост на deploy потребителя
- [ ] `/admin` достъпен само за `is_admin` (вече е gated в кода)

**Съдържание (виж раздел 11)**
- [x] og:image социален банер — генериран (`public/images/og-default.png` + мета тагове в app.blade.php)
- [ ] Телефон/имейл в страницата Контакт; текст на Поверителност и Условия
- [ ] Telegram линк (в момента сочи към `#` във футъра — добави реалния URL)

**Финална проверка**
- [ ] `php artisan test` — зелено (381 теста)
- [ ] Ръчно: V1 страниците връщат 200; V2 (`/f2`, `/circuits`, `/tsolov`, `/live`, `/istoria`, `/rivalries`, `/compare`) връщат 404
- [ ] `/up` връща 200 (health)

---

## 2. Първоначален деплой

```bash
git clone <repo> /var/www/f1bulgaria && cd /var/www/f1bulgaria
cp .env.example .env                       # после попълни тайните и production стойностите (раздел 1)
composer install --no-dev --optimize-autoloader
npm ci && npm run build
php artisan key:generate                   # ако APP_KEY е празен
php artisan storage:link
php artisan migrate --force
php artisan f1:sync-history 1950 2025       # backfill минали сезони (бавно; nohup/screen)
php artisan f1:sync-season                  # текущ сезон
php artisan sitemap:generate
php artisan config:cache route:cache view:cache event:cache
```

Nginx сочи към `public/`; задай crontab (раздел 5) и `queue` worker (раздел 7).

## 3. Рутинен деплой (нова версия)

```bash
cd /var/www/f1bulgaria && sudo bash deploy.sh
```

> **Само това.** НЕ пускай `git pull` преди скрипта — той пулва сам, като
> `www-data`. Ръчен `git pull` като root връща файловете в root-owned
> състояние и следващият деплой гърми с „dubious ownership".

Скриптът ([deploy.sh](deploy.sh)) прави всичко в правилния ред и **като `www-data`** —
git pull, composer, `npm run build` (клиентски + SSR bundle), миграции, кешове,
рестарт на SSR демона и queue worker-а и проверки накрая.

> **Никога не пускай artisan като root.** Оставя root-owned файлове в `storage/`
> и `bootstrap/cache/`; php-fpm не може да пише в тях и сайтът връща 500 **без
> нищо в лога** (защото и логърът не може да пише). Ако се случи:
> `chown -R www-data:www-data storage bootstrap/cache && sudo -u www-data php artisan optimize:clear`

> След промяна на routes/config ВИНАГИ `route:cache`/`config:cache` отново — иначе старите кеширани routes се сервират (вкл. feature middleware-а).

## 3б. Queue worker

`QUEUE_CONNECTION=database`, а `ValidateGameLapJob` преиграва подадените
обиколки през Node. **Без работещ worker записите остават `pending`: няма
авторитетна сървърна проверка, записан сървърен дух или значки от обиколката.**

Управлява се от **systemd** (не supervisor — там е само SSR демонът):

```bash
sudo cp docs/systemd-padok-queue.service /etc/systemd/system/padok-queue.service
sudo systemctl daemon-reload
sudo systemctl enable --now padok-queue
systemctl status padok-queue
```

Това е еднократната инсталация на versioned unit-а. Ако `command -v php` не
връща `/usr/bin/php`, коригирай `ExecStart` в копирания unit. Node трябва да е
системно достъпен за `www-data`; за нестандартен път задай абсолютна стойност
на `GAME_NODE_BINARY` в `.env` и пусни `php artisan config:cache` като `www-data`.

> `ExecStart` съдържа `--max-time=3600`, тоест процесът излиза сам след час.
> Затова unit-ът ТРЯБВА да е с `Restart=always` — при `on-failure` изходът
> по max-time се брои за успешен и worker-ът остава мъртъв.
> Провери: `systemctl show padok-queue -p Restart`

Проверка, че реално дренира (не просто че процесът е жив):

```bash
sudo -u www-data php artisan tinker --execute 'echo DB::table("jobs")->count();'
```

Число, което расте между два прогона, значи спрял worker. `deploy.sh` пуска
`queue:restart` — това вдига флаг в кеша и worker-ът се самозатваря, за да
подхване новия код (systemd го рестартира).

## 3а. Inertia SSR (сървърно рендериране)

Ботовете (Google на първата вълна, Facebook, Telegram, Viber, GPTBot) получават
пълния HTML, вместо празен `<div id="app">`. Изисква Node демон.

**Еднократна настройка:**

```bash
sudo cp docs/supervisor-padok-ssr.conf /etc/supervisor/conf.d/padok-ssr.conf
sudo supervisorctl reread && sudo supervisorctl update && sudo supervisorctl start padok-ssr
sudo -u www-data php artisan inertia:check-ssr    # → "Inertia SSR server is running."
```

Плюс `INERTIA_SSR_ENABLED=true` в `.env` (стойността по подразбиране е `true`,
т.е. достатъчно е да НЕ я задаваш на false), после `config:cache`.

**Как да не пада:**

| Механизъм | Какво прави |
|---|---|
| `autorestart=true` в supervisor | Вдига демона при всяко падане |
| `startretries=3` | Ако падне 3 пъти за 10 сек, спира — значи bundle-ът е счупен, не е временно |
| Grateful fallback в Inertia | Ако демонът не отговаря, страницата се рендира клиентски — **сайтът не гърми**, само губи SSR |
| Рестарт в `deploy.sh` | Демонът зарежда bundle-а веднъж при старт; без рестарт сервира стар Vue срещу нов клиентски bundle |

**Проверка, че наистина работи** (не просто че процесът е жив):

```bash
curl -s https://padok.bg/news | grep -c "<article"
```

Число > 0 значи SSR рендира. `0` значи, че се сервира клиентски — виж
`storage/logs/ssr.log` и `supervisorctl status padok-ssr`.

## 4. Включване на V2 модул след launch

Без code change — само `.env` + рекеширане:

```bash
# напр. пускане на Формула 2:
sed -i 's/FEATURE_F2=false/FEATURE_F2=true/' .env
php artisan config:cache route:cache
php artisan sitemap:generate    # вече включва F2 URL-ите
```

Навигацията, sitemap-ът и рутовете автоматично се съобразяват с флага.

## 5. Scheduler (cron) — задължително

Без това прогнозите не се заключват, резултатите не се синхронизират и новините спират.

```cron
* * * * * cd /var/www/f1bulgaria && php artisan schedule:run >> /dev/null 2>&1
```

Текущи задачи ([routes/console.php](routes/console.php)):

**F1 данни и прогнози**
- `f1:lock-predictions` — всяка минута (заключва прогнозите преди квалификация)
- `f1:sync-results` — на 15 мин (резултати + точкуване + значки)
- `f1:sync-sessions` — на 15 мин (разписание на сесиите + класации от тренировки/спринт квалификация)
- `f2:sync` — на 15 мин (Ф2 от официалния API)

**Имейли** (всички в софийско време, с вътрешни guard-ове)
- `f1:weekly-digest` — неделя 20:00 (рекап; само при кръг през последните 7 дни)
- `f1:race-preview` — петък 09:00 (preview на уикенда; само при кръг до 7 дни напред)
- `f1:offseason-pulse` — сряда 18:00 (пулс през паузите; guard-ове + 21-дневен интервал го пускат само в дълги паузи)

**Новини и канал**
- `news:fetch` — :00/:30 всеки час (RSS емисии)
- `news:enrich --limit=25` — :05/:35 всеки час (LLM превод/класификация)
- `news:publish-pending` — :20 всеки час (осигурителна публикация на висящи)
- `news:generate-articles --limit=10` — :25 всеки час (дописване на пълни статии)
- `channel:enqueue-news` — :08/:23/:38/:53 (важните новини към опашката за канала)
- `channel:post` — на 5 мин (изпразва опашката към Telegram канала)

**Друго**
- `sitemap:generate` — :45 всеки час (свеж sitemap за Google)
- `report:daily-activity` — 23:55 (дневен отчет за активността към админ имейла)

## 6. Cache warmup

Тежките stat-кешове (driver/circuit) се пълнят при първо посещение → първият посетител е бавен (~1s). Загрей след деплой:

```bash
php artisan sitemap:generate >/dev/null
# „удари" ключовите страници, за да напълниш кеша преди трафика:
for u in / /standings /teams /drivers/lewis-hamilton; do curl -s -o /dev/null "$APP_URL$u"; done
```

(Алтернатива за бъдеще: dedicated `cache:warm` команда. Засега горното е достатъчно.)

## 7. Опашка (queue)

`QUEUE_CONNECTION=database`. Пусни worker (systemd):

```bash
php artisan queue:work --tries=3 --max-time=3600
```

Worker-ът изпълнява сървърното replay валидиране на обиколките. Node трябва
да е достъпен през `GAME_NODE_BINARY` (по подразбиране `node`).

## 8. DNS / HTTPS

- A/AAAA запис `padok.bg` → IP на сървъра (+ `www` CNAME → apex или redirect)
- Let's Encrypt (`certbot --nginx`), auto-renew (cron на certbot)
- Принудителен HTTPS redirect в Nginx; HSTS header
- След смяна на домейн → обнови `APP_URL`, [public/robots.txt](public/robots.txt) (Sitemap ред) и регенерирай sitemap

## 8а. Вход с Google (Socialite)

1. [Google Cloud Console](https://console.cloud.google.com/) → нов проект „Padok" →
   **APIs & Services → OAuth consent screen**: External, име „Падок", домейн padok.bg
2. **Credentials → Create OAuth client ID** → Web application:
   - Authorized JavaScript origins: `https://padok.bg`
   - Authorized redirect URIs: `https://padok.bg/auth/google/callback`
3. В `.env`:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   ```
4. `php artisan config:cache` — бутонът „Продължи с Google" на login/register проработва.

Забележки: Google акаунтите се създават с потвърден имейл (без наш верификационен
мейл); при съществуващ акаунт със същия имейл Google се свързва към него (без дубликат).

## 9. Админ достъп

Задай `ADMIN_EMAIL` и `ADMIN_PASSWORD` в `.env` и пусни:

```bash
php artisan padok:sync-admin
```

Командата създава/обновява акаунта (парола като hash, `is_admin=true`, потвърден имейл).
Пускай я след всяка промяна на креденшълите. Логваш се на `/admin` с тях.

По избор: `ADMIN_ACCESS_KEY` активира „скрита врата" — без `?key=` панелът връща 404
(празна стойност = изключена). Ръчно промотиране на друг акаунт:

```bash
php artisan tinker --execute 'App\Models\User::where("email","ti@padok.bg")->update(["is_admin"=>true]);'
```

## 9а. Оперативен MCP сървър (`/mcp/ops`, само четене)

Read-only достъп до прод за админа през MCP клиент (Claude Code, claude.ai) — без SSH:
`site-overview`, `recent-users`, `queue-health`, `recent-logs`, `race-predictions`,
`league-standings`, `sql-query` (само SELECT). Всяко извикване се записва в `mcp_tool_calls`.
Код: `routes/ai.php`, `app/Mcp/`, `config/ops.php`.

Включване (всичко като `www-data`, после `config:cache` — конфигът е кеширан):

1. MySQL потребител САМО със SELECT (истинската гаранция на `sql-query`):
   ```sql
   CREATE USER 'padok_ro'@'localhost' IDENTIFIED BY '<парола>';
   GRANT SELECT ON f1bulgaria.* TO 'padok_ro'@'localhost';
   ```
   и в `.env`: `DB_READONLY_USERNAME=padok_ro`, `DB_READONLY_PASSWORD=...`. Без тях
   инструментът `sql-query` просто не се регистрира — останалите работят.
2. `FEATURE_MCP_OPS=true` в `.env` (изключен → 404, както скрития `/admin`).
3. `sudo -u www-data php artisan config:cache`
4. Токен (показва се веднъж; същото име = ротация; `--revoke` отменя):
   ```bash
   sudo -u www-data php artisan padok:mcp-token --name=claude-code --days=90
   ```
   Издава се само на действащ админ (`is_admin` + без бан) и портата го проверява пак
   при всяка заявка — бан или свалени права = токенът спира да работи веднага.

Клиент (токенът през променлива — вписан в командата остава в историята на терминала):
```bash
read -s PADOK_MCP_TOKEN   # постави токена, Enter; PowerShell: $env:PADOK_MCP_TOKEN = Read-Host
claude mcp add --transport http padok-ops https://padok.bg/mcp/ops --header "Authorization: Bearer $PADOK_MCP_TOKEN"
```
Локална проверка: `php artisan mcp:inspector mcp/ops`. Отказани извиквания (напр. опит за
DELETE през `sql-query`) са с `is_error = 1` в `mcp_tool_calls` — HTTP статусът им е 200.

## 10. Backup стратегия

- **БД**: дневен `mysqldump` (cron), retention 14–30 дни, off-server копие (S3/друг хост):
  ```cron
  30 3 * * * mysqldump --single-transaction f1bulgaria | gzip > /backups/db-$(date +\%F).sql.gz
  ```
- **Качени файлове**: `storage/app/public` (аватари/изображения) — седмичен rsync към off-server.
- `.env` — съхранявай тайните в password manager (НЕ в git).
- Тествай възстановяване поне веднъж преди launch.

## 11. Мониторинг

- **Health**: `GET /up` (Laravel) връща 200 — вържи към uptime monitor (UptimeRobot / Better Uptime), алерт по имейл/Telegram.
- **Грешки**: препоръчва се Sentry. Без нова зависимост засега; при нужда `composer require sentry/sentry-laravel` и `SENTRY_LARAVEL_DSN` в `.env`. Дотогава — следи `storage/logs` (daily channel, `LOG_LEVEL=warning`).
- **Uptime цели**: monitor на `/` и `/up` на 1–5 мин; алерт при 2 поредни fail-а.

## 12. Изоставащи задачи преди launch (съдържание, не код)

Маркирани в [AUDIT.md](AUDIT.md):
- [x] og:image социален банер (1200×630) + `<meta property="og:image">` в [app.blade.php](resources/views/app.blade.php) — готово
- [ ] Реален текст за Поверителност / Условия / Контакт ([StaticPageController](app/Http/Controllers/StaticPageController.php) + [Static/Page.vue](resources/js/Pages/Static/Page.vue))
- [ ] Telegram URL във футъра (виж [PublicLayout.vue](resources/js/Layouts/PublicLayout.vue))
