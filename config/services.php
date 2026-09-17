<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'token' => env('POSTMARK_TOKEN'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'resend' => [
        'key' => env('RESEND_KEY'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    'jolpica' => [
        'base_url' => env('JOLPICA_BASE_URL', 'https://api.jolpi.ca/ergast/f1'),
        // Jolpica е rate-limited (без ключ: ~4 req/s, 500/час burst).
        'timeout' => (int) env('JOLPICA_TIMEOUT', 20),
        'retry_times' => (int) env('JOLPICA_RETRY_TIMES', 3),
        'retry_sleep_ms' => (int) env('JOLPICA_RETRY_SLEEP_MS', 500),
    ],

    'anthropic' => [
        'key' => env('ANTHROPIC_API_KEY'),
        'model' => env('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
        'base_url' => env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
        // По-дълъг таймаут — генерирането на дълги статии (1000+ токена) надхвърля 30s.
        'timeout' => (int) env('ANTHROPIC_TIMEOUT', 120),
    ],

    'mistral' => [
        'key' => env('MISTRAL_API_KEY'),
        'model' => env('MISTRAL_MODEL', 'mistral-large-latest'),
        'base_url' => env('MISTRAL_BASE_URL', 'https://api.mistral.ai/v1'),
        'timeout' => (int) env('MISTRAL_TIMEOUT', 120),
    ],

    'google' => [
        'client_id' => env('GOOGLE_CLIENT_ID'),
        'client_secret' => env('GOOGLE_CLIENT_SECRET'),
        'redirect' => '/auth/google/callback',
    ],

    'openf1' => [
        'base_url' => env('OPENF1_BASE_URL', 'https://api.openf1.org/v1'),
        'token_url' => env('OPENF1_TOKEN_URL', 'https://api.openf1.org/token'),
        'timeout' => (int) env('OPENF1_TIMEOUT', 10),
        // ВАЖНО: OpenF1 ограничава достъпа ПО ВРЕМЕ на живи сесии само за
        // автентикирани потребители (HTTP 401). Автентикацията е OAuth2 (password
        // grant) — нужни са потребител + парола. Без тях /live показва fallback.
        'username' => env('OPENF1_USERNAME'),
        'password' => env('OPENF1_PASSWORD'),
        // Разстояние между две заявки в милисекунди. Ограничението, което
        // реално хапе, е това за МИНУТА: 60 на платения тир, 30 на безплатния.
        // 1100 ms дава ~54/мин — под тавана с резерв. Без абонамент сложи 2100.
        'min_interval_ms' => (int) env('OPENF1_MIN_INTERVAL_MS', 1100),
    ],

    /*
    | Формула 2 — официалните резултати.
    |
    | Хостът е api.formula1.com с path scope /f2/ — това е backend-ът на
    | fiaformula2.com, не документирано публично API. Няма версия по договор:
    | имена на endpoint-и и полета могат да се сменят без предупреждение.
    |
    | Ключът НЕ се пише тук. Той е build-time константа в бандъла на сайта им
    | и се сменя при всеки техен редеплой — зашит в конфигурацията означава
    | тихо спиране някой ден. Вади се по време на работа от страницата
    | (виж F2ApiClient) и се кешира.
    |
    | Покритие: само от 2026 г. По-старите сезони връщат празни списъци —
    | за тях остава `f2:sync-wikipedia --historical`.
    */
    'f2' => [
        'base_url' => env('F2_API_BASE_URL', 'https://api.formula1.com/v2/core-fom-results/f2'),
        'key_page_url' => env('F2_API_KEY_PAGE_URL', 'https://www.fiaformula2.com/en/racing'),
        'user_agent' => env('F2_API_USER_AGENT', 'PadokBot/1.0 (+https://padok.bg)'),
        'timeout' => (int) env('F2_API_TIMEOUT', 20),
        'key_cache_hours' => (int) env('F2_API_KEY_CACHE_HOURS', 24),
    ],

    'wikipedia' => [
        'base_url' => env('WIKIPEDIA_BASE_URL', 'https://en.wikipedia.org/w/api.php'),
        'user_agent' => env('WIKIPEDIA_USER_AGENT', 'Padok/1.0 (https://padok.bg)'),
        'timeout' => (int) env('WIKIPEDIA_TIMEOUT', 15),
        'rate_limit_ms' => (int) env('WIKIPEDIA_RATE_LIMIT_MS', 1000),
    ],

    /*
    | Telegram Bot API — публикуване в канала на Падок.
    |
    | chat_id ТРЯБВА да е числовото id на канала (започва с -100…), не
    | @username: username-ът се сменя при преименуване на канала и постовете
    | спират тихо, докато id-то е непроменимо. Вади се веднъж с
    | `php artisan channel:resolve-chat-id @padokbg`.
    |
    | Лимитът, който има значение, е 1 съобщение в секунда към един и същ чат
    | (не 30/сек — това е за broadcast към различни чатове).
    |
    | @see https://core.telegram.org/bots/api#sendmessage
    */
    'telegram' => [
        'bot_token' => env('TELEGRAM_BOT_TOKEN'),
        'chat_id' => env('TELEGRAM_CHAT_ID'),
        'base_url' => env('TELEGRAM_BASE_URL', 'https://api.telegram.org'),
        'timeout' => (int) env('TELEGRAM_TIMEOUT', 15),
        /*
        | Линкът към Телеграм, който излиза във всяко бюлетинно писмо.
        | Празна стойност скрива блока изцяло.
        */
        'community_url' => env('TELEGRAM_COMMUNITY_URL'),
    ],

    /*
    | IndexNow — push уведомяване към Bing/Yandex при нова публикация.
    | Ключът е произволен низ (32-64 hex знака); същият низ трябва да е
    | достъпен като https://padok.bg/{key}.txt със съдържание самия ключ.
    */
    'indexnow' => [
        'key' => env('INDEXNOW_KEY'),
    ],

    /*
    | ElevenLabs — гласът на радиото в играта. Клиповете се генерират
    | ВЕДНЪЖ офлайн (game:generate-radio-voice) и влизат в репото; играта не
    | вика API-то и ключът не трябва на продукция.
    |
    | @see https://elevenlabs.io/docs/api-reference/text-to-speech/convert
    */
    'elevenlabs' => [
        'key' => env('ELEVENLABS_API_KEY'),
        'base_url' => env('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io'),
        // multilingual_v2 поддържа български и не е Beta (Beta услугите
        // нямат търговски лиценз); v3 е по-изразителен, но е Beta.
        'radio_model' => env('ELEVENLABS_RADIO_MODEL', 'eleven_multilingual_v2'),
    ],

];
