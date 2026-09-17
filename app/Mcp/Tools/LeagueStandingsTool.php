<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Models\Season;
use App\Services\Predictions\LeaderboardService;
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
 * Класацията на лигата с прогнози — същата, която сайтът показва на
 * /klasirane, през LeaderboardService (няма отделна таблица, сумата е жива).
 */
#[Name('league-standings')]
#[Description('Класация на prediction лигата за сезон (по подразбиране текущия): позиция, потребител, точки, брой прогнози.')]
#[IsReadOnly]
#[IsIdempotent]
class LeagueStandingsTool extends Tool
{
    private const DEFAULT_LIMIT = 20;

    private const MAX_LIMIT = 100;

    public function handle(Request $request, LeaderboardService $leaderboard): ResponseFactory|Response
    {
        $validated = $request->validate([
            'limit' => ['nullable', 'integer', 'min:1', 'max:'.self::MAX_LIMIT],
            'year' => ['nullable', 'integer', 'min:1950', 'max:2100'],
        ], [
            'limit.*' => 'limit е цяло число от 1 до '.self::MAX_LIMIT.'.',
            'year.*' => 'year е година на сезон, напр. 2026.',
        ]);

        $limit = (int) ($validated['limit'] ?? self::DEFAULT_LIMIT);

        $season = isset($validated['year'])
            ? Season::query()->where('year', (int) $validated['year'])->first()
            : Season::current();

        if ($season === null) {
            return Response::error(isset($validated['year'])
                ? "Няма сезон {$validated['year']} в базата."
                : 'Няма текущ сезон (seasons.is_current) — синхронизирай с f1:sync-season.');
        }

        $rows = $leaderboard->forSeason($season);

        return Response::structured([
            'season' => $season->year,
            'participants' => $rows->count(),
            'standings' => $rows->take($limit)->map(fn (array $row): array => [
                'position' => $row['position'],
                'user_id' => $row['user']->id,
                'name' => $row['user']->name,
                'points' => $row['points'],
                'predictions' => $row['predictions'],
            ])->values()->all(),
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
                ->description('Колко позиции от върха да върне.'),

            'year' => $schema->integer()
                ->description('Година на сезона. Без стойност = текущият сезон.'),
        ];
    }
}
