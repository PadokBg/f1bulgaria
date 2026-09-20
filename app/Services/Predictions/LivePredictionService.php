<?php

declare(strict_types=1);

namespace App\Services\Predictions;

use App\Models\Driver;
use App\Models\Prediction;
use App\Models\Race;
use App\Services\LiveTiming\OpenF1Client;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;

/**
 * Точкуване на прогнозите ПО ВРЕМЕ на състезанието.
 *
 * Прогнозата досега беше формуляр, който човек попълва в петък и отваря пак
 * чак във вторник, когато точките са начислени. Между двете няма причина да
 * се върне — а неделя следобед е единственият момент, в който всички гледат
 * едно и също нещо. Затова същите правила се прилагат върху текущите позиции
 * от OpenF1 и дават временно класиране, което се мени с всяко изпреварване.
 *
 * Временно значи временно: подиумът се точкува на живо, а най-бърза обиколка,
 * DNF и safety car остават неизвестни до края и не носят точки нито в едната,
 * нито в другата посока.
 */
class LivePredictionService
{
    /**
     * Кешът е 15 секунди: OpenF1 така или иначе кешира позициите за 5, а
     * панелът се пита от всеки отворен браузър поотделно. При 30 души онлайн
     * разликата е 30 заявки към OpenF1 на минута срещу 4.
     */
    private const CACHE_SECONDS = 15;

    public function __construct(
        private readonly OpenF1Client $openF1,
        private readonly PredictionScoringService $scoring,
    ) {}

    /**
     * Временното класиране за състезание, което тече в момента.
     *
     * null означава „няма какво да се показва" — състезанието не е в ефир,
     * няма прогнози или OpenF1 още не дава позиции.
     *
     * @return array{podium: array<int, array<string, mixed>>, standings: array<int, array<string, mixed>>, predictors: int, updated_at: string}|null
     */
    public function standings(Race $race): ?array
    {
        return Cache::remember(
            "live-predictions:{$race->id}",
            now()->addSeconds(self::CACHE_SECONDS),
            fn (): ?array => $this->build($race),
        );
    }

    /**
     * @return array<string, mixed>|null
     */
    private function build(Race $race): ?array
    {
        $session = $this->openF1->getLiveSession();

        // Точкуваме само ГЛАВНОТО състезание — прогнозите се отнасят за него.
        if ($session === null || ! $this->isRaceSession($session)) {
            return null;
        }

        $podium = $this->livePodium($race, (int) $session['key']);

        if ($podium === []) {
            return null;
        }

        $predictions = $race->predictions()->with('user:id,name,avatar_path')->get();

        if ($predictions->isEmpty()) {
            return null;
        }

        $actual = [
            'p1' => $podium[0]['driver_id'] ?? null,
            'p2' => $podium[1]['driver_id'] ?? null,
            'p3' => $podium[2]['driver_id'] ?? null,
            'podium' => array_values(array_filter(array_column($podium, 'driver_id'))),
            // Полът е известен още от събота и се точкува нормално.
            'pole' => $race->pole_driver_id,
            // Останалите се решават чак на финала.
            'fastest_lap' => null,
            'dnf_count' => null,
            'safety_car' => null,
        ];

        $standings = $predictions
            ->map(function (Prediction $prediction) use ($actual): array {
                $breakdown = $this->scoring->scorePrediction($prediction, $actual);

                return [
                    'user_id' => $prediction->user_id,
                    'name' => $prediction->user?->name ?? 'Изтрит профил',
                    'avatar' => $prediction->user?->avatar_path,
                    'points' => array_sum($breakdown),
                    'breakdown' => $breakdown,
                ];
            })
            ->sortByDesc('points')
            ->values();

        return [
            'podium' => $podium,
            'standings' => $standings->map(fn (array $row, int $i): array => [
                ...$row,
                'position' => $i + 1,
            ])->all(),
            'predictors' => $standings->count(),
            'updated_at' => now()->toIso8601String(),
        ];
    }

    /**
     * @param  array<string, mixed>  $session
     */
    private function isRaceSession(array $session): bool
    {
        return strtolower((string) ($session['type'] ?? '')) === 'race';
    }

    /**
     * Челната тройка в момента, преведена към пилотите в нашата база.
     *
     * OpenF1 записва ред само при ПРОМЯНА на позицията, затова за текущата
     * подредба взимаме последния запис на всеки пилот.
     *
     * @return array<int, array{position: int, driver_id: int|null, name: string, code: string|null}>
     */
    private function livePodium(Race $race, int $sessionKey): array
    {
        $latest = $this->openF1->getPositions($sessionKey)
            ->sortBy('date')
            ->keyBy('driver_number')
            ->filter(fn ($row) => (int) ($row['position'] ?? 0) >= 1 && (int) $row['position'] <= 3)
            ->sortBy('position');

        if ($latest->isEmpty()) {
            return [];
        }

        $drivers = $this->seasonDrivers($race);
        $meta = $this->openF1->getSessionDrivers($sessionKey)->keyBy('driver_number');

        return $latest->map(function (array $row) use ($drivers, $meta): array {
            $number = (int) $row['driver_number'];
            $driver = $drivers->get($number);
            $fallback = $meta->get($number);

            return [
                'position' => (int) $row['position'],
                'driver_id' => $driver?->id,
                'name' => $driver !== null
                    ? trim("{$driver->first_name} {$driver->last_name}")
                    : (string) ($fallback['full_name'] ?? "№{$number}"),
                'code' => $driver->driver_code ?? $fallback['name_acronym'] ?? null,
            ];
        })->values()->all();
    }

    /**
     * Пилотите от сезона по състезателен номер.
     *
     * @return Collection<int, Driver>
     */
    private function seasonDrivers(Race $race): Collection
    {
        return Driver::query()
            ->where('season_id', $race->season_id)
            ->whereNotNull('permanent_number')
            ->get(['id', 'first_name', 'last_name', 'driver_code', 'permanent_number'])
            ->keyBy('permanent_number');
    }
}
