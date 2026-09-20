<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Resources\PredictionResource;
use App\Http\Resources\RaceResource;
use App\Models\Driver;
use App\Models\Prediction;
use App\Models\PredictionScore;
use App\Models\Race;
use App\Services\Circuits\CircuitStatsService;
use App\Services\Predictions\PredictionLockService;
use App\Services\Races\RaceClassificationProvider;
use App\Services\Races\RaceNameLocalizer;
use App\Support\BulgarianSort;
use App\Support\DriverName;
use App\Support\Seo;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Inertia\Inertia;
use Inertia\Response;

class RaceController extends Controller
{
    /**
     * Мястото на една прогноза сред точкуваните за същия кръг.
     *
     * Връща null, докато кръгът не е точкуван — картичката за споделяне няма
     * смисъл преди това.
     *
     * @return array{rank: int, total: int}|null
     */
    private function raceRank(Race $race, int $predictionId): ?array
    {
        $points = PredictionScore::query()
            ->whereIn('prediction_id', $race->predictions()->select('id'))
            ->pluck('points', 'prediction_id');

        $mine = $points->get($predictionId);

        if ($mine === null) {
            return null;
        }

        return [
            'rank' => $points->filter(fn ($value) => $value > $mine)->count() + 1,
            'total' => $points->count(),
        ];
    }

    public function show(
        Race $race,
        PredictionLockService $lock,
        RaceClassificationProvider $classifications,
        CircuitStatsService $circuits,
    ): Response {
        $race->load([
            'sessions',
            'poleDriver',
            'results' => fn ($q) => $q->where('session_type', 'race')
                ->with('driver.constructor')
                ->orderByRaw('position is null, position'),
        ]);

        $userPrediction = null;
        $userRaceRank = null;

        if ($user = request()->user()) {
            $prediction = $user->predictions()
                ->where('race_id', $race->id)
                ->with('score')
                ->first();

            $userPrediction = $prediction ? new PredictionResource($prediction) : null;
            $userRaceRank = $prediction !== null ? $this->raceRank($race, $prediction->id) : null;
        }

        // Падащото меню за прогнози е азбучно по показваното (кирилско) име,
        // затова подредбата е след map-ването, а не в SQL.
        $drivers = Driver::query()
            ->where('season_id', $race->season_id)
            ->get(['id', 'slug', 'first_name', 'last_name'])
            ->map(fn ($d) => ['id' => $d->id, 'name' => DriverName::display($d->slug, $d->fullName())])
            ->sortBy(fn (array $d) => BulgarianSort::key($d['name']))
            ->values();

        app(Seo::class)
            ->title($race->name_bg ?? $race->name)
            ->description(($race->name_bg ?? $race->name).' — програма, стартова решетка и резултати от Формула 1. Часове в българско време.')
            ->canonical(route('races.show', $race->id));

        $rows = $classifications->all($race);
        $isLocked = $lock->isLocked($race);

        return Inertia::render('Races/Show', [
            'race' => new RaceResource($race),
            'locked' => $isLocked,
            'lockDeadline' => $lock->lockDeadline($race)
                ?->setTimezone('Europe/Sofia')->format('d.m.Y H:i'),
            'userPrediction' => $userPrediction,
            // Позицията в кръга — числото, което прави картичката за споделяне
            // интересна („3-и от 21"), а не просто сбор точки.
            'userRaceRank' => $userRaceRank,
            'drivers' => $drivers,
            'classifications' => $rows,
            // Между два кръга минават 1-3 седмици — най-дългият прозорец в
            // годината, през който страницата беше заглавие плюс разписание.
            'preview' => $rows === [] ? $this->preview($race, $circuits) : null,
            // Само дали има какво да се покаже — самите графики живеят на
            // /danni/{race} и не се дублират в тази страница.
            'hasDataRecap' => config('features.data_recap')
                && $race->dataRecap()->whereNotNull('generated_at')->exists(),
            'neighbours' => $this->neighbours($race),
            'otherPredictions' => $isLocked ? $this->otherPredictions($race) : [],
        ]);
    }

    /**
     * Историята на пистата, докато няма класация от този уикенд. Данните идват
     * от CircuitStatsService — без нов източник, само вече събраните резултати.
     *
     * @return array<string, mixed>|null
     */
    private function preview(Race $race, CircuitStatsService $circuits): ?array
    {
        $slug = $race->jolpica_id;

        if ($slug === null) {
            return null;
        }

        // Кеш за ден: getRecords() и getLastWinners() НЕ са кеширани сами по
        // себе си и правят по няколко заявки. Това е рендер пътят на
        // страницата, която се отваря най-много в състезателна седмица —
        // историята на пистата се мени само след кръг там.
        return Cache::remember("race-preview:{$slug}", now()->addDay(), function () use ($slug, $circuits) {
            $records = $circuits->getRecords($slug);

            return [
                'circuit_slug' => $slug,
                'last_winners' => $circuits->getLastWinners($slug, 5)->values(),
                'all_time' => $circuits->getAllTimeDriverStandings($slug)->take(5)->values(),
                'most_wins' => $records['most_wins'] ?? null,
                'avg_winner_grid' => $records['avg_winner_starting_position'] ?? null,
                'pole_to_win' => $records['pole_to_win_conversion_rate'] ?? null,
            ];
        });
    }

    /**
     * Предишният и следващият кръг от същия сезон — най-евтиният
     * многостраничен цикъл в сайта.
     *
     * @return array{prev: array<string, mixed>|null, next: array<string, mixed>|null}
     */
    private function neighbours(Race $race): array
    {
        if ($race->round === null) {
            return ['prev' => null, 'next' => null];
        }

        $siblings = Race::query()
            ->where('season_id', $race->season_id)
            ->whereIn('round', [$race->round - 1, $race->round + 1])
            // race_datetime_utc пътува заради годината: тя решава дали кръгът
            // попада в изключение по сезон (виж RaceNameLocalizer::forRace).
            ->get(['id', 'round', 'name', 'jolpica_id', 'race_datetime_utc'])
            ->keyBy('round');

        $shape = fn (?Race $r) => $r === null ? null : [
            'id' => $r->id,
            'round' => $r->round,
            'name' => app(RaceNameLocalizer::class)->forRace($r),
        ];

        return [
            'prev' => $shape($siblings->get($race->round - 1)),
            'next' => $shape($siblings->get($race->round + 1)),
        ];
    }

    /**
     * Чуждите прогнози — само СЛЕД заключване, иначе би било подсказка.
     *
     * Причината да съществува: лига без видими чужди прогнози е формуляр, а не
     * игра. При малцина играчи двете-три чужди решения са цялото социално
     * съдържание на фийчъра.
     *
     * @return Collection<int, array<string, mixed>>
     */
    private function otherPredictions(Race $race): Collection
    {
        $userId = request()->user()?->id;

        $names = Driver::query()
            ->where('season_id', $race->season_id)
            ->get(['id', 'slug', 'first_name', 'last_name'])
            ->mapWithKeys(fn (Driver $d) => [$d->id => DriverName::display($d->slug, $d->fullName())]);

        return Prediction::query()
            ->where('race_id', $race->id)
            ->when($userId !== null, fn ($q) => $q->where('user_id', '!=', $userId))
            ->with(['user:id,name', 'score'])
            ->get()
            ->map(fn (Prediction $p) => [
                'user_id' => $p->user?->id,
                'user' => $p->user?->name,
                'podium' => collect([$p->p1_driver_id, $p->p2_driver_id, $p->p3_driver_id])
                    ->map(fn (?int $id) => $id === null ? null : $names->get($id))
                    ->all(),
                'points' => $p->score?->points,
            ])
            ->sortByDesc(fn (array $row) => $row['points'] ?? -1)
            ->values();
    }
}
