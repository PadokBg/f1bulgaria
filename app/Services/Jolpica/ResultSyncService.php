<?php

declare(strict_types=1);

namespace App\Services\Jolpica;

use App\Enums\ResultSessionType;
use App\Enums\SessionType;
use App\Models\Constructor;
use App\Models\Driver;
use App\Models\Race;
use App\Models\Result;
use App\Models\Season;
use App\Models\SessionResult;
use App\Services\LiveTiming\SafetyCarDetector;
use App\Services\Predictions\PredictionScoringService;
use App\Support\Nationality;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * Синхрон на резултатите от едно състезание (главно + спринт, ако е спринт
 * уикенд) + определяне на pole от квалификацията и safety car от OpenF1. След
 * успешен синхрон задейства точкуването на прогнозите. Идемпотентен.
 */
class ResultSyncService
{
    public function __construct(
        private readonly JolpicaClient $client,
        private readonly PredictionScoringService $scoring,
        private readonly SafetyCarDetector $safetyCar,
    ) {}

    /**
     * @return array{results:int, sprint:int, scored:int}
     *
     * @throws JolpicaException ако кръгът в Jolpica е друго състезание
     */
    public function sync(Race $race): array
    {
        $season = $race->season;
        $year = $season->year;
        $round = $race->round;

        // Всички HTTP заявки преди транзакцията, за да не я държим по време на мрежа.
        $main = $this->client->raceData($year, $round, 'results');
        $sprint = $race->has_sprint ? $this->client->raceData($year, $round, 'sprint') : null;
        $qualifying = $this->client->raceData($year, $round, 'qualifying');

        foreach ([$main, $sprint, $qualifying] as $data) {
            $this->assertSameRace($race, $data);
        }

        $mainRows = $main['Results'] ?? [];
        $sprintRows = $sprint['SprintResults'] ?? [];
        $qualifyingRows = $qualifying['QualifyingResults'] ?? [];

        $counts = DB::transaction(function () use ($race, $season, $mainRows, $sprintRows, $qualifyingRows) {
            $main = $this->upsertResults($race, $season, $mainRows, ResultSessionType::Race);
            $sprint = $this->upsertResults($race, $season, $sprintRows, ResultSessionType::Sprint);
            $this->syncQualifying($race, $season, $qualifyingRows);

            return ['results' => $main, 'sprint' => $sprint];
        });

        if ($counts['results'] > 0) {
            $this->resolveSafetyCar($race);
        }

        $scored = 0;

        if ($counts['results'] > 0 || $counts['sprint'] > 0) {
            $scored = $this->scoring->scoreRace($race->fresh());
        }

        return [...$counts, 'scored' => $scored];
    }

    /**
     * Проверява, че нашият кръг и този в Jolpica са едно и също състезание.
     *
     * Резултатите се теглят по НОМЕР на кръга. Когато календарът се размине
     * (на 26.09.2026 Jolpica вмъкна кръг 16 в Малайзия и Сингапур стана 17-и),
     * същият номер сочи друго състезание — и без тази проверка прогнозите за
     * Сингапур щяха да се точкуват по резултатите от Малайзия.
     *
     * @param  array<string, mixed>|null  $data
     *
     * @throws JolpicaException
     */
    private function assertSameRace(Race $race, ?array $data): void
    {
        $circuitId = $data['Circuit']['circuitId'] ?? null;

        if ($circuitId === null || $race->jolpica_id === null || $circuitId === $race->jolpica_id) {
            return;
        }

        throw new JolpicaException(sprintf(
            'Кръг %d в Jolpica е на „%s", а при нас е на „%s" — календарът е разминат. Пусни f1:sync-calendar.',
            $race->round,
            $circuitId,
            $race->jolpica_id,
        ));
    }

    /**
     * Попълва safety car от OpenF1, ако още не е известен.
     *
     * Само за състезания с прогнози: полето служи единствено на точкуването,
     * а историческият синхрон минава през стотици кръгове, за които заявките
     * към OpenF1 биха били чист разход. Ръчно въведеното не се пипа. Ако
     * OpenF1 още няма окончателни данни, следващото пускане опитва пак —
     * последното състезание се пре-синхронизира на всеки 15 минути.
     */
    private function resolveSafetyCar(Race $race): void
    {
        if (! config('predictions.safety_car.autodetect')
            || $race->had_safety_car !== null
            || ! $race->predictions()->exists()) {
            return;
        }

        try {
            $detected = $this->safetyCar->detect($race);
        } catch (Throwable $e) {
            // Липсващ safety car не бива да спира точкуването на останалото.
            Log::warning("Safety car за кръг {$race->round} не се определи: {$e->getMessage()}");

            return;
        }

        if ($detected !== null) {
            $race->update(['had_safety_car' => $detected]);
        }
    }

    /**
     * @param  array<int, array<string, mixed>>  $rows
     */
    private function upsertResults(Race $race, Season $season, array $rows, ResultSessionType $type): int
    {
        $count = 0;

        foreach ($rows as $row) {
            $driver = $this->resolveDriver($season, $row['Driver'], $row['Constructor'] ?? null);

            Result::query()->updateOrCreate(
                [
                    'race_id' => $race->id,
                    'driver_id' => $driver->id,
                    'session_type' => $type->value,
                ],
                [
                    'jolpica_id' => $row['Driver']['driverId'].'@'.$race->round.'@'.$type->value,
                    'position' => $this->parsePosition($row['positionText'] ?? null),
                    'points' => (float) ($row['points'] ?? 0),
                    'dnf' => $this->isDnf($row['status'] ?? ''),
                    'fastest_lap' => ($row['FastestLap']['rank'] ?? null) === '1',
                    'grid_position' => isset($row['grid']) ? (int) $row['grid'] : null,
                ],
            );

            $count++;
        }

        return $count;
    }

    /**
     * Пълната класация от квалификацията плюс pole позицията.
     *
     * Jolpica я връща цялата и досега ползвахме само първия ред. Класацията
     * трябва и на канала, и на страницата на състезанието.
     *
     * @param  array<int, array<string, mixed>>  $qualifying
     */
    private function syncQualifying(Race $race, Season $season, array $qualifying): void
    {
        foreach ($qualifying as $row) {
            $driver = $this->resolveDriver($season, $row['Driver'], $row['Constructor'] ?? null);
            $position = (int) ($row['position'] ?? 0);

            // Пълната класация отива в `session_results`, а НЕ в `results`:
            // там редовете без точки биха се броели като старт и подиум
            // от статистиките, които не филтрират по session_type.
            SessionResult::query()->updateOrCreate(
                [
                    'race_id' => $race->id,
                    'session_type' => SessionType::Qualifying->value,
                    'driver_id' => $driver->id,
                ],
                [
                    'position' => $position > 0 ? $position : null,
                    'q1' => $row['Q1'] ?? null,
                    'q2' => $row['Q2'] ?? null,
                    'q3' => $row['Q3'] ?? null,
                    'source' => 'jolpica',
                ],
            );

            if ($position === 1) {
                $race->update(['pole_driver_id' => $driver->id]);
            }
        }
    }

    /**
     * Намира пилота за сезона по jolpica_id, а ако липсва — го създава от
     * данните в резултата (напр. резервен пилот, нает извън стартовия списък).
     *
     * @param  array<string, mixed>  $driverData
     * @param  array<string, mixed>|null  $constructorData
     */
    private function resolveDriver(Season $season, array $driverData, ?array $constructorData): Driver
    {
        $constructorId = null;

        if ($constructorData !== null) {
            $constructor = Constructor::query()->updateOrCreate(
                ['season_id' => $season->id, 'jolpica_id' => $constructorData['constructorId']],
                [
                    'name' => $constructorData['name'] ?? $constructorData['constructorId'],
                    'slug' => Str::slug($constructorData['name'] ?? $constructorData['constructorId']),
                ],
            );
            $constructorId = $constructor->id;
        }

        $attributes = [
            'constructor_id' => $constructorId,
            'first_name' => $driverData['givenName'],
            'last_name' => $driverData['familyName'],
            'slug' => Str::slug("{$driverData['givenName']} {$driverData['familyName']}"),
            'permanent_number' => isset($driverData['permanentNumber'])
                ? (int) $driverData['permanentNumber']
                : null,
            'country_code' => Nationality::toIso3($driverData['nationality'] ?? null),
        ];

        // Пишем кода само ако Ergast дава такъв — иначе пазим вече зададения
        // (генериран за исторически пилоти), за да не се изтрива при ре-синхрон.
        if (filled($driverData['code'] ?? null)) {
            $attributes['driver_code'] = $driverData['code'];
        }

        return Driver::query()->updateOrCreate(
            ['season_id' => $season->id, 'jolpica_id' => $driverData['driverId']],
            $attributes,
        );
    }

    private function parsePosition(?string $positionText): ?int
    {
        // Числова позиция = класиран. "R", "D", "W", "N", "F" → null.
        return is_numeric($positionText) ? (int) $positionText : null;
    }

    private function isDnf(string $status): bool
    {
        // Класиран = "Finished" или "+N Lap(s)". Всичко друго (Accident, Engine,
        // Retired, Disqualified, ...) се брои за DNF.
        if ($status === 'Finished') {
            return false;
        }

        return ! Str::contains($status, 'Lap');
    }
}
