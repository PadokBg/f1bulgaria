<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Mcp\Concerns\FormatsSofiaTime;
use App\Models\AuthEvent;
use App\Models\User;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\JsonSchema\Types\Type;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Последните регистрации с това, което админът пита първо: върнал ли се е
 * човекът (последно влизане) и прогнозира ли.
 */
#[Name('recent-users')]
#[Description('Последно регистрираните потребители: име, имейл, кога, админ/бан, брой прогнози и последно влизане. По избор само от последните N дни.')]
#[IsReadOnly]
#[IsIdempotent]
class RecentUsersTool extends Tool
{
    use FormatsSofiaTime;

    private const DEFAULT_LIMIT = 10;

    private const MAX_LIMIT = 50;

    public function handle(Request $request): ResponseFactory
    {
        $validated = $request->validate([
            'limit' => ['nullable', 'integer', 'min:1', 'max:'.self::MAX_LIMIT],
            'days' => ['nullable', 'integer', 'min:1', 'max:3650'],
        ], [
            'limit.*' => 'limit е цяло число от 1 до '.self::MAX_LIMIT.'.',
            'days.*' => 'days е цяло число от 1 до 3650.',
        ]);

        $limit = (int) ($validated['limit'] ?? self::DEFAULT_LIMIT);
        $days = isset($validated['days']) ? (int) $validated['days'] : null;

        $lastLogin = AuthEvent::query()
            ->select('created_at')
            ->whereColumn('user_id', 'users.id')
            ->where('type', AuthEvent::TYPE_LOGIN)
            ->latest('created_at')
            ->limit(1);

        $query = User::query()
            ->withCount('predictions')
            ->addSelect(['last_login_at' => $lastLogin])
            ->latest('created_at')
            ->limit($limit);

        if ($days !== null) {
            $query->where('created_at', '>=', now()->subDays($days));
        }

        $users = $query->get()->map(fn (User $user): array => [
            'id' => $user->id,
            'name' => $user->name,
            'email' => $user->email,
            'registered_at' => $this->sofia($user->created_at),
            'is_admin' => (bool) $user->is_admin,
            'banned_at' => $this->sofia($user->banned_at),
            'predictions_count' => (int) $user->predictions_count,
            'last_login_at' => $this->sofia($user->getAttribute('last_login_at')),
        ]);

        return Response::structured([
            'filter' => ['limit' => $limit, 'days' => $days],
            'count' => $users->count(),
            'users' => $users->values()->all(),
        ]);
    }

    /**
     * @return array<string, Type>
     */
    public function schema(JsonSchema $schema): array
    {
        return [
            'limit' => $schema->integer()
                ->min(1)
                ->max(self::MAX_LIMIT)
                ->default(self::DEFAULT_LIMIT)
                ->description('Колко потребители да върне (най-новите първи).'),

            'days' => $schema->integer()
                ->min(1)
                ->description('Само регистрирани през последните толкова дни. Без стойност = без ограничение.'),
        ];
    }
}
