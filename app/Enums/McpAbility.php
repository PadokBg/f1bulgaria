<?php

declare(strict_types=1);

namespace App\Enums;

/**
 * Sanctum ability, с която се издава токен за MCP сървърите на Падок.
 *
 * Стойността се записва в personal_access_tokens.abilities и се проверява при
 * всяка заявка (EnsureMcpOpsAccess). Отделна ability за четене и за писане,
 * за да може токен за read-only сървъра никога да не отвори бъдещ write сървър.
 */
enum McpAbility: string
{
    case OpsRead = 'mcp:ops-read';

    public function label(): string
    {
        return match ($this) {
            self::OpsRead => 'Операции — само четене',
        };
    }
}
