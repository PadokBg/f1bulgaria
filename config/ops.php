<?php

declare(strict_types=1);

/*
|--------------------------------------------------------------------------
| Оперативен MCP сървър (routes/ai.php → /mcp/ops)
|--------------------------------------------------------------------------
|
| Read-only инструменти за админа на Падок, достъпни през MCP клиент
| (Claude Code, claude.ai) с Sanctum токен (padok:mcp-token). Рутът се пуска
| с FEATURE_MCP_OPS=true (config/features.php).
|
*/

return [

    'mcp' => [

        /*
        | Връзка към базата за инструмента sql-query. Продукция: mysql_readonly
        | (config/database.php) — отделен MySQL потребител САМО със SELECT.
        | Това е истинската гаранция срещу писане; проверките в PHP са втори
        | пояс. В тестовете сочи към sqlite (една и съща in-memory база).
        */
        'query_connection' => env('OPS_QUERY_CONNECTION', 'mysql_readonly'),

        /* Таван на редовете, които sql-query връща на един разговор. */
        'query_max_rows' => 200,

        /* Таван (ms) за една SELECT заявка на MySQL — пази прод от runaway. */
        'query_timeout_ms' => 5000,

        /* Таблици, които sql-query отказва да чете (сесии, токени, кеш). */
        'query_denied_tables' => [
            'personal_access_tokens',
            'password_reset_tokens',
            'sessions',
            'cache',
            'cache_locks',
        ],

        /* Колони, които се режат от резултата, независимо от заявката. */
        'query_denied_columns' => [
            'password',
            'remember_token',
            'token',
            'unsubscribe_token',
            'google_id',
        ],

        /* Таван на редовете, които recent-logs връща от края на файла. */
        'log_max_lines' => 500,

    ],

];
