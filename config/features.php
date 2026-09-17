<?php

declare(strict_types=1);

/*
|--------------------------------------------------------------------------
| Feature flags (V1 launch scope)
|--------------------------------------------------------------------------
|
| V1 показва: пилоти, отбори, календар, новини, класиране, прогнози,
| терминология, Цолов. Останалите модули са завършени, но скрити за V2+ — кодът
| остава, само се изключва. Включи отново чрез .env (напр. FEATURE_F2=true)
| без code change. Изключена функция → навигацията я крие и рутът връща 404.
|
*/

return [
    'compare' => env('FEATURE_COMPARE', false),
    'rivalries' => env('FEATURE_RIVALRIES', false),
    'circuits' => env('FEATURE_CIRCUITS', false),
    'tsolov' => env('FEATURE_TSOLOV', false), // V1 — включва се през .env (FEATURE_TSOLOV=true)
    'history' => env('FEATURE_HISTORY', false),
    'f2' => env('FEATURE_F2', false),
    'live_timing' => env('FEATURE_LIVE_TIMING', false),
    'this_day' => env('FEATURE_THIS_DAY', false),
    'quiz' => env('FEATURE_QUIZ', false),
    'game' => env('FEATURE_GAME', false),

    // „Данни“ (/danni) — рекапът след всяко състезание от OpenF1, със
    // собствени графики. Виж App\Services\RaceData.
    'data_recap' => env('FEATURE_DATA_RECAP', false),

    // „Инженерство“ (/inzhenerstvo) — обяснителната рубрика за техниката.
    // Съдържанието е в config/engineering-content.php.
    'engineering' => env('FEATURE_ENGINEERING', false),

    // Оперативният MCP сървър (/mcp/ops) за админа — виж config/ops.php.
    // Изключен → рутът връща 404, както скрития /admin.
    'mcp_ops' => env('FEATURE_MCP_OPS', false),
];
