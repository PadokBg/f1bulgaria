<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * Един запис от одит лога на MCP инструментите (LogMcpToolCalls).
 *
 * @property int $id
 * @property int|null $user_id
 * @property string|null $token_name
 * @property string $server
 * @property string $tool
 * @property array<string, mixed>|null $arguments
 * @property int|null $status
 * @property bool $is_error
 * @property string|null $error
 * @property int|null $duration_ms
 * @property string|null $ip_address
 */
class McpToolCall extends Model
{
    /** @var list<string> */
    protected $fillable = [
        'user_id',
        'token_name',
        'server',
        'tool',
        'arguments',
        'status',
        'is_error',
        'error',
        'duration_ms',
        'ip_address',
    ];

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'arguments' => 'array',
            'status' => 'integer',
            'is_error' => 'boolean',
            'duration_ms' => 'integer',
        ];
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
