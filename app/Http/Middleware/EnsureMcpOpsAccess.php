<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Enums\McpAbility;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Laravel\Sanctum\PersonalAccessToken;
use Symfony\Component\HttpFoundation\Response;

/**
 * Портата към MCP сървърите на Падок. Върви СЛЕД auth:sanctum и изисква:
 *
 *  1. истински Bearer токен — не сесия. Sanctum guard-ът приема и логнат
 *     браузър (TransientToken); тук това се отхвърля, за да не може отворен
 *     таб на сайта да послужи като MCP достъп;
 *  2. токенът да носи нужната ability (отделна за четене и за писане);
 *  3. потребителят да е действащ админ В МОМЕНТА — токенът остава в базата
 *     и след бан/сваляне на правата, затова правилото се проверява на всяка
 *     заявка, не само при издаването.
 *
 * Употреба в рут: EnsureMcpOpsAccess::using(McpAbility::OpsRead).
 */
class EnsureMcpOpsAccess
{
    public static function using(McpAbility $ability): string
    {
        return static::class.':'.$ability->value;
    }

    public function handle(Request $request, Closure $next, string $ability): Response
    {
        $user = $request->user();

        if (! $user instanceof User) {
            abort(401, 'Липсва автентикация.');
        }

        if (! $user->currentAccessToken() instanceof PersonalAccessToken) {
            abort(403, 'MCP достъпът изисква Bearer токен (padok:mcp-token), не сесия.');
        }

        if (! $user->tokenCan($ability)) {
            abort(403, "Токенът няма право „{$ability}“.");
        }

        if (! $user->isActiveAdmin()) {
            abort(403, 'Само действащ админ има MCP достъп.');
        }

        return $next($request);
    }
}
