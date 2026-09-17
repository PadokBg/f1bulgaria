<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Enums\ResultSessionType;
use App\Mcp\Concerns\FormatsSofiaTime;
use App\Models\Driver;
use App\Models\Prediction;
use App\Models\Race;
use App\Models\User;
use App\Services\Predictions\PredictionLockService;
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
 * Прогнозите за един кръг — кой какво е заложил и колко е взел. Без race_id
 * взима кръга, за който прогнозите са отворени в момента; ако няма такъв,
 * последния изминал.
 */
#[Name('race-predictions')]
#[Description('Прогнозите за едно състезание: кой е прогнозирал (топ 3, pole, най-бърза обиколка, DNF, safety car), заключени ли са, точки след оценяване. Без race_id = кръгът с отворени прогнози, иначе последният изминал.')]
#[IsReadOnly]
#[IsIdempotent]
class RacePredictionsTool extends Tool
{
    use FormatsSofiaTime;

    public function handle(Request $request, PredictionLockService $locks): ResponseFactory|Response
    {
        $validated = $request->validate([
            'race_id' => ['nullable', 'integer', 'min:1'],
        ], [
            'race_id.*' => 'race_id е цяло положително число (races.id).',
        ]);

        $race = isset($validated['race_id'])
            ? Race::query()->find((int) $validated['race_id'])
            : $this->defaultRace($locks);

        if ($race === null) {
            return Response::error(isset($validated['race_id'])
                ? "Няма състезание с id {$validated['race_id']}."
                : 'Няма състезания в базата.');
        }

        $predictions = $race->predictions()
            ->with(['user', 'score', 'p1Driver', 'p2Driver', 'p3Driver', 'poleDriver', 'fastestLapDriver'])
            ->get();

        $deadline = $locks->lockDeadline($race);
        $eligibleUsers = User::query()->whereNull('banned_at')->count();

        return Response::structured([
            'race' => [
                'id' => $race->id,
                'round' => $race->round,
                'name' => $race->name_bg,
                'race_at' => $this->sofia($race->race_datetime_utc),
                'qualifying_at' => $this->sofia($race->qualifying_datetime_utc),
                'predictions_lock_at' => $this->sofia($deadline),
                'predictions_locked' => $locks->isLocked($race),
                'has_race_results' => $race->results()->where('session_type', ResultSessionType::Race->value)->exists(),
                'pole_driver' => $this->driver($race->poleDriver),
                'had_safety_car' => $race->had_safety_car,
            ],
            'counts' => [
                'predictions' => $predictions->count(),
                'scored' => $predictions->filter(fn (Prediction $prediction): bool => $prediction->score !== null)->count(),
                'eligible_users' => $eligibleUsers,
                'users_without_prediction' => max(0, $eligibleUsers - $predictions->count()),
            ],
            'predictions' => $predictions
                ->sortByDesc(fn (Prediction $prediction): int => $prediction->score?->points ?? -1)
                ->map(fn (Prediction $prediction): array => [
                    'user_id' => $prediction->user_id,
                    'user' => $prediction->user?->name,
                    'p1' => $this->driver($prediction->p1Driver),
                    'p2' => $this->driver($prediction->p2Driver),
                    'p3' => $this->driver($prediction->p3Driver),
                    'pole' => $this->driver($prediction->poleDriver),
                    'fastest_lap' => $this->driver($prediction->fastestLapDriver),
                    'dnf_count' => $prediction->dnf_count,
                    'safety_car' => $prediction->safety_car,
                    'locked_at' => $this->sofia($prediction->locked_at),
                    'points' => $prediction->score?->points,
                    'breakdown' => $prediction->score?->breakdown_json,
                ])
                ->values()
                ->all(),
        ]);
    }

    /**
     * Кръгът с отворени прогнози (по срока за заключване), иначе последният
     * изминал по време на състезанието.
     */
    private function defaultRace(PredictionLockService $locks): ?Race
    {
        $open = Race::query()
            ->whereNotNull('qualifying_datetime_utc')
            ->where('qualifying_datetime_utc', '>=', now())
            ->orderBy('qualifying_datetime_utc')
            ->limit(5)
            ->get()
            ->first(fn (Race $candidate): bool => $locks->lockDeadline($candidate)?->isFuture() === true);

        if ($open !== null) {
            return $open;
        }

        return Race::query()
            ->whereNotNull('race_datetime_utc')
            ->where('race_datetime_utc', '<=', now())
            ->orderByDesc('race_datetime_utc')
            ->first();
    }

    private function driver(?Driver $driver): ?string
    {
        if ($driver === null) {
            return null;
        }

        $code = $driver->driver_code;

        return $code !== null && $code !== '' ? "{$driver->fullName()} ({$code})" : $driver->fullName();
    }

    /**
     * @return array<string, Type>
     */
    public function schema(JsonSchema $schema): array
    {
        return [
            'race_id' => $schema->integer()
                ->min(1)
                ->description('races.id на състезанието. Без стойност = кръгът с отворени прогнози или последният изминал.'),
        ];
    }
}
