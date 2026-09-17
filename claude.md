# Проект: Падок (padok.bg) — общност за българските F1 фенове

## Контекст
Соло разработка, страничен проект: общностен сайт за българските фенове на Формула 1. Аз (Румен) съм единственият човек по проекта — код, съдържание, модерация, общност.

БРАНД: „Падок" (лого: Падок + червена точка), домейн padok.bg. НЕ използвай „F1" в брандови елементи (лого, име, og) — trademark на Formula One Licensing; „Формула 1"/„F1" в съдържанието като име на спорта е ОК. Старото име „F1 България" не се връща никъде.

Планът трябва да уважава това:
- Агресивно намален скоуп
- Максимална автоматизация на повтарящи се задачи
- Никакви фийчъри, изискващи real-time човешка модерация в MVP

## Стак (непроменим)
- Laravel 13 (последна стабилна)
- Inertia.js + Vue 3 (Composition API, `<script setup>`)
- Tailwind CSS v3
- Filament 4 за админ панел (v4 конвенции: nested resource директории, `Filament\Schemas`)
- MySQL 8
- Pest за тестове
- Деплой: Hetzner Cloud (Ubuntu 22.04)

ЗАБЕЛЕЖКА: Laravel Reverb / WebSockets са ИЗВЪН MVP. Real-time чат живее във външен Telegram канал засега.

## Git workflow
- НЕ изпълнявай `git commit`, `git push` или каквато и да е операция, която модифицира историята на репозиторията. Само пиши и редактирай файлове.
- Когато си готов с промени — спри, покажи `git status` + кратко обобщение, и остави Румен да commit-не/push-не сам.
- ИЗКЛЮЧЕНИЕ: разрешено е да предлагаш commit съобщения като текст (за копиране), но не ги изпълнявай.

## Конвенции
- PHP 8.4.1+ (`^8.4.1` в composer.json — config/database.php ползва `Pdo\Mysql`; локално 8.5), PSR-12, strict types където е разумно
- Използвай Laravel Boost MCP за справки по Laravel документация
- Използвай Context7 MCP за справки по библиотеки от трети страни (Inertia, Filament и т.н.) — никога не разчитай на памет за API-та на библиотеки
- Form Requests за цялата валидация
- Resource класове за API отговори
- Service класове за бизнес логика, контролерите да са тънки
- Eloquent над raw query builder, освен ако performance не го налага
- Vue компоненти: PascalCase, single-file, composables за споделена логика
- Само български език (`bg` locale), без i18n setup
- Timezone: всичко в базата UTC, показвай в Europe/Sofia

## MVP Скоуп (строго, в този ред)
1. Auth + профили (Breeze + Inertia)
2. F1 data sync от Jolpica API (`https://api.jolpi.ca/ergast/f1/`) — сезони, състезания, пилоти, конструктори, резултати
3. Публични страници: календар на състезанията, класиране (пилоти + конструктори), детайли на състезание
4. Prediction league: топ 3, pole, най-бърза обиколка, брой DNF, safety car (да/не)
5. Профилни страници със статистика на прогнозите и badges
6. Админ панел чрез Filament: CRUD на постове, модерация на потребители, ръчни корекции на данни

## ИЗРИЧНО ИЗВЪН MVP
- Live race threads / WebSockets / чат (използвай външен Telegram)
- Форум / коментари под постове
- Fantasy league
- Многоезичие
- Плащания / абонаменти
- Социален login (само email в началото)
- Мобилно приложение

## Схема на базата (първоначални миграции)
- `users` (Breeze default + `favorite_driver_id`, `favorite_constructor_id`, `bio`, `avatar_path`)
- `seasons` (year, is_current)
- `constructors` (name, slug, color_hex, season_id)
- `drivers` (first_name, last_name, slug, permanent_number, constructor_id, country_code, season_id)
- `races` (season_id, round, name, circuit, country, race_datetime_utc, qualifying_datetime_utc, sprint_datetime_utc nullable, has_sprint bool)
- `sessions` (race_id, type [fp1|fp2|fp3|qualifying|sprint_quali|sprint|race], scheduled_at_utc)
- `results` (race_id, driver_id, session_type [race|sprint], position nullable при DNF, points decimal(5,2), dnf bool, fastest_lap bool, grid_position, unique [race_id, driver_id, session_type])

===

<laravel-boost-guidelines>
=== foundation rules ===

# Laravel Boost Guidelines

The Laravel Boost guidelines are specifically curated by Laravel maintainers for this application. These guidelines should be followed closely to ensure the best experience when building Laravel applications.

## Foundational Context

This application is a Laravel application and its main Laravel ecosystems package & versions are below. You are an expert with them all. Ensure you abide by these specific packages & versions.

- php - 8.3
- filament/filament (FILAMENT) - v4
- inertiajs/inertia-laravel (INERTIA_LARAVEL) - v2
- laravel/framework (LARAVEL) - v13
- laravel/prompts (PROMPTS) - v0
- laravel/sanctum (SANCTUM) - v4
- livewire/livewire (LIVEWIRE) - v3
- tightenco/ziggy (ZIGGY) - v2
- laravel/boost (BOOST) - v2
- laravel/breeze (BREEZE) - v2
- laravel/mcp (MCP) - v0
- laravel/pail (PAIL) - v1
- laravel/pint (PINT) - v1
- laravel/sail (SAIL) - v1
- pestphp/pest (PEST) - v4
- phpunit/phpunit (PHPUNIT) - v12
- rector/rector (RECTOR) - v2
- @inertiajs/vue3 (INERTIA_VUE) - v2
- tailwindcss (TAILWINDCSS) - v3
- vue (VUE) - v3

## Skills Activation

This project has domain-specific skills available in `**/skills/**`. You MUST activate the relevant skill whenever you work in that domain—don't wait until you're stuck.

## Conventions

- You must follow all existing code conventions used in this application. When creating or editing a file, check sibling files for the correct structure, approach, and naming.
- Use descriptive names for variables and methods. For example, `isRegisteredForDiscounts`, not `discount()`.
- Check for existing components to reuse before writing a new one.

## Verification Scripts

- Do not create verification scripts or tinker when tests cover that functionality and prove they work. Unit and feature tests are more important.

## Application Structure & Architecture

- Stick to existing directory structure; don't create new base folders without approval.
- Do not change the application's dependencies without approval.

## Frontend Bundling

- If the user doesn't see a frontend change reflected in the UI, it could mean they need to run `npm run build`, `npm run dev`, or `composer run dev`. Ask them.

## Documentation Files

- You must only create documentation files if explicitly requested by the user.

## Replies

- Be concise in your explanations - focus on what's important rather than explaining obvious details.

=== boost rules ===

# Laravel Boost

## Tools

- Laravel Boost is an MCP server with tools designed specifically for this application. Prefer Boost tools over manual alternatives like shell commands or file reads.
- Use `database-query` to run read-only queries against the database instead of writing raw SQL in tinker.
- Use `database-schema` to inspect table structure before writing migrations or models.
- Use `get-absolute-url` to resolve the correct scheme, domain, and port for project URLs. Always use this before sharing a URL with the user.
- Use `browser-logs` to read browser logs, errors, and exceptions. Only recent logs are useful, ignore old entries.

## Searching Documentation (IMPORTANT)

- Always use `search-docs` before making code changes. Do not skip this step. It returns version-specific docs based on installed packages automatically.
- Pass a `packages` array to scope results when you know which packages are relevant.
- Use multiple broad, topic-based queries: `['rate limiting', 'routing rate limiting', 'routing']`. Expect the most relevant results first.
- Do not add package names to queries because package info is already shared. Use `test resource table`, not `filament 4 test resource table`.

### Search Syntax

1. Use words for auto-stemmed AND logic: `rate limit` matches both "rate" AND "limit".
2. Use `"quoted phrases"` for exact position matching: `"infinite scroll"` requires adjacent words in order.
3. Combine words and phrases for mixed queries: `middleware "rate limit"`.
4. Use multiple queries for OR logic: `queries=["authentication", "middleware"]`.

## Artisan

- Run Artisan commands directly via the command line (e.g., `php artisan route:list`). Use `php artisan list` to discover available commands and `php artisan [command] --help` to check parameters.
- Inspect routes with `php artisan route:list`. Filter with: `--method=GET`, `--name=users`, `--path=api`, `--except-vendor`, `--only-vendor`.
- Read configuration values using dot notation: `php artisan config:show app.name`, `php artisan config:show database.default`. Or read config files directly from the `config/` directory.

## Tinker

- Execute PHP in app context for debugging and testing code. Do not create models without user approval, prefer tests with factories instead. Prefer existing Artisan commands over custom tinker code.
- Always use single quotes to prevent shell expansion: `php artisan tinker --execute 'Your::code();'`
  - Double quotes for PHP strings inside: `php artisan tinker --execute 'User::where("active", true)->count();'`

=== php rules ===

# PHP

- Always use curly braces for control structures, even for single-line bodies.
- Use PHP 8 constructor property promotion: `public function __construct(public GitHub $github) { }`. Do not leave empty zero-parameter `__construct()` methods unless the constructor is private.
- Use explicit return type declarations and type hints for all method parameters: `function isAccessible(User $user, ?string $path = null): bool`
- Use TitleCase for Enum keys: `FavoritePerson`, `BestLake`, `Monthly`.
- Prefer PHPDoc blocks over inline comments. Only add inline comments for exceptionally complex logic.
- Use array shape type definitions in PHPDoc blocks.

=== deployments rules ===

# Deployment

- Laravel can be deployed using [Laravel Cloud](https://cloud.laravel.com/), which is the fastest way to deploy and scale production Laravel applications.

=== tests rules ===

# Test Enforcement

- Every change must be programmatically tested. Write a new test or update an existing test, then run the affected tests to make sure they pass.
- Run the minimum number of tests needed to ensure code quality and speed. Use `php artisan test --compact` with a specific filename or filter.

=== inertia-laravel/core rules ===

# Inertia

- Inertia creates fully client-side rendered SPAs without modern SPA complexity, leveraging existing server-side patterns.
- Components live in `resources/js/Pages` (unless specified in `vite.config.js`). Use `Inertia::render()` for server-side routing instead of Blade views.
- ALWAYS use `search-docs` tool for version-specific Inertia documentation and updated code examples.
- IMPORTANT: Activate `inertia-vue-development` when working with Inertia Vue client-side patterns.

# Inertia v2

- Use all Inertia features from v1 and v2. Check the documentation before making changes to ensure the correct approach.
- New features: deferred props, infinite scroll, merging props, polling, prefetching, once props, flash data.
- When using deferred props, add an empty state with a pulsing or animated skeleton.

=== laravel/core rules ===

# Do Things the Laravel Way

- Use `php artisan make:` commands to create new files (i.e. migrations, controllers, models, etc.). You can list available Artisan commands using `php artisan list` and check their parameters with `php artisan [command] --help`.
- If you're creating a generic PHP class, use `php artisan make:class`.
- Pass `--no-interaction` to all Artisan commands to ensure they work without user input. You should also pass the correct `--options` to ensure correct behavior.

### Model Creation

- When creating new models, create useful factories and seeders for them too. Ask the user if they need any other things, using `php artisan make:model --help` to check the available options.

## APIs & Eloquent Resources

- For APIs, default to using Eloquent API Resources and API versioning unless existing API routes do not, then you should follow existing application convention.

## URL Generation

- When generating links to other pages, prefer named routes and the `route()` function.

## Testing

- When creating models for tests, use the factories for the models. Check if the factory has custom states that can be used before manually setting up the model.
- Faker: Use methods such as `$this->faker->word()` or `fake()->randomDigit()`. Follow existing conventions whether to use `$this->faker` or `fake()`.
- When creating tests, make use of `php artisan make:test [options] {name}` to create a feature test, and pass `--unit` to create a unit test. Most tests should be feature tests.

## Vite Error

- If you receive an "Illuminate\Foundation\ViteException: Unable to locate file in Vite manifest" error, you can run `npm run build` or ask the user to run `npm run dev` or `composer run dev`.

=== pint/core rules ===

# Laravel Pint Code Formatter

- If you have modified any PHP files, you must run `vendor/bin/pint --dirty --format agent` before finalizing changes to ensure your code matches the project's expected style.
- Do not run `vendor/bin/pint --test --format agent`, simply run `vendor/bin/pint --format agent` to fix any formatting issues.

=== pest/core rules ===

## Pest

- This project uses Pest for testing. Create tests: `php artisan make:test --pest {name}`.
- The `{name}` argument should not include the test suite directory. Use `php artisan make:test --pest SomeFeatureTest` instead of `php artisan make:test --pest Feature/SomeFeatureTest`.
- Run tests: `php artisan test --compact` or filter: `php artisan test --compact --filter=testName`.
- Do NOT delete tests without approval.

=== inertia-vue/core rules ===

# Inertia + Vue

Vue components must have a single root element.
- IMPORTANT: Activate `inertia-vue-development` when working with Inertia Vue client-side patterns.

</laravel-boost-guidelines>
