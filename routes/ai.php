<?php

declare(strict_types=1);

use App\Enums\McpAbility;
use App\Http\Middleware\EnsureMcpOpsAccess;
use App\Http\Middleware\LogMcpToolCalls;
use App\Mcp\Servers\OpsReadServer;
use Illuminate\Support\Facades\Route;
use Laravel\Mcp\Facades\Mcp;

/*
|--------------------------------------------------------------------------
| MCP сървъри
|--------------------------------------------------------------------------
|
| Зареждат се от McpServiceProvider, извън `web` групата: без сесия, без
| CSRF — само Bearer токен (padok:mcp-token).
|
| Feature флагът е на групата, а не на POST рута: Mcp::web() регистрира и
| GET/DELETE (405 Allow: POST) без middleware, а на POST слага своите
| преди нашите. Само групата скрива и трите глагола зад 404 (както /admin)
| и пуска флага преди валидацията на MCP хедърите. Нататък: Sanctum, порта
| за админ + ability, throttle по потребител, накрая одитът.
|
*/

Route::middleware('feature:mcp_ops')->group(function (): void {
    Mcp::web('/mcp/ops', OpsReadServer::class)
        ->middleware([
            'auth:sanctum',
            EnsureMcpOpsAccess::using(McpAbility::OpsRead),
            'throttle:60,1,mcp-ops',
            LogMcpToolCalls::using('ops-read'),
        ]);
});
