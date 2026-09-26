<?php

declare(strict_types=1);

namespace App\Services\Jolpica;

use App\Enums\SessionType;
use App\Models\Constructor;
use App\Models\Driver;
use App\Models\Race;
use App\Models\Season;
use App\Support\ConstructorColors;
use App\Support\Nationality;
use Carbon\CarbonImmutable;
use Carbon\CarbonInterface;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Пълен синхрон на сезон от Jolpica: сезон → конструктори → пилоти → състезания
 * (със сесии). Идемпотентен — повторно изпълнение обновява, не дублира.
 */
class SeasonSyncService
{
    /**
     * Временният номер на кръг по време на преномериране е този плюс новия.
     * Колоната е unsigned tinyint (до 255), а сезон има под 30 кръга.
     */
    private const PARKED_ROUND_OFFSET = 100;

    /** Колко изчезнали от Jolpica бъдещи кръга махаме наведнъж, преди да сметнем отговора за повреден. */
    private const MAX_REMOVED_PER_SYNC = 2;

    /** До колко може да се размине часът, за да е същото състезание, ако пистата е сменила идентификатора си. */
    private const SAME_RACE_WINDOW_SECONDS = 36 * 3600;

    /** С колко може да се премести кръг с прогнози без човешко решение (часови промени, не отлагане). */
    private const MAX_SILENT_MOVE_SECONDS = 7 * 24 * 3600;

    /**
     * Часовете, които админът може да заключи с `manual_schedule`.
     *
     * @var array<int, string>
     */
    private const SCHEDULE_ATTRIBUTES = ['race_datetime_utc', 'qualifying_datetime_utc', 'sprint_datetime_utc'];

    public function __construct(private readonly JolpicaClient $client) {}

    /**
     * @return array{constructors:int, drivers:int, races:int}
     */
    public function sync(int $year): array
    {
        $season = Season::query()->firstOrCreate(['year' => $year]);

        $constructors = $this->syncConstructors($season);
        $drivers = $this->syncDrivers($season, $constructors);
        $calendar = $this->syncCalendar($season);

        return [
            'constructors' => $constructors->count(),
            'drivers' => $drivers->count(),
            'races' => $calendar['races'],
        ];
    }

    /**
     * @return Collection<string, Constructor> индексирани по jolpica_id
     */
    private function syncConstructors(Season $season): Collection
    {
        $rows = $this->client->constructors($season->year);

        return DB::transaction(function () use ($season, $rows) {
            $byJolpicaId = collect();

            foreach ($rows as $row) {
                $jolpicaId = $row['constructorId'];

                $constructor = Constructor::query()->updateOrCreate(
                    ['season_id' => $season->id, 'jolpica_id' => $jolpicaId],
                    [
                        'name' => $row['name'],
                        'slug' => Str::slug($row['name']),
                        'color_hex' => ConstructorColors::forJolpicaId($jolpicaId),
                    ],
                );

                $byJolpicaId->put($jolpicaId, $constructor);
            }

            return $byJolpicaId;
        });
    }

    /**
     * @param  Collection<string, Constructor>  $constructors
     * @return Collection<int, Driver>
     */
    private function syncDrivers(Season $season, Collection $constructors): Collection
    {
        $rows = $this->client->drivers($season->year);
        $constructorByDriver = $this->mapDriversToConstructors($season->year);

        return DB::transaction(function () use ($season, $rows, $constructors, $constructorByDriver) {
            $drivers = collect();

            foreach ($rows as $row) {
                $jolpicaId = $row['driverId'];
                $constructorJolpicaId = $constructorByDriver[$jolpicaId] ?? null;

                $attributes = [
                    'constructor_id' => $constructorJolpicaId
                        ? $constructors->get($constructorJolpicaId)?->id
                        : null,
                    'first_name' => $row['givenName'],
                    'last_name' => $row['familyName'],
                    'slug' => Str::slug("{$row['givenName']} {$row['familyName']}"),
                    'permanent_number' => isset($row['permanentNumber'])
                        ? (int) $row['permanentNumber']
                        : null,
                    'country_code' => Nationality::toIso3($row['nationality'] ?? null),
                ];

                // Пишем кода само ако Ergast дава такъв — иначе пазим вече зададения
                // (генериран за исторически пилоти), за да не се изтрива при ре-синхрон.
                if (filled($row['code'] ?? null)) {
                    $attributes['driver_code'] = $row['code'];
                }

                $driver = Driver::query()->updateOrCreate(
                    ['season_id' => $season->id, 'jolpica_id' => $jolpicaId],
                    $attributes,
                );

                $drivers->push($driver);
            }

            return $drivers;
        });
    }

    /**
     * Връща карта driverId => constructorId на база класирането на пилотите.
     *
     * @return array<string, string>
     */
    private function mapDriversToConstructors(int $year): array
    {
        $standings = $this->client->driverStandings($year);
        $map = [];

        foreach ($standings as $standing) {
            $driverId = $standing['Driver']['driverId'] ?? null;
            $constructors = $standing['Constructors'] ?? [];
            $lastConstructor = end($constructors);

            if ($driverId && $lastConstructor) {
                $map[$driverId] = $lastConstructor['constructorId'];
            }
        }

        return $map;
    }

    /**
     * Календарът на сезона — само състезанията и сесиите им.
     *
     * Съществуващо състезание се намира по ПИСТАТА, а не по номера на кръга.
     * Номерът не е идентичност: когато Jolpica добави или махне кръг, всички
     * след него се изместват. На 26.09.2026 се вмъкна кръг 16 в Малайзия —
     * съпоставяне по номер щеше да превърне нашия Сингапур в Малайзия заедно
     * с прогнозите за него, а после да размести всеки следващ кръг.
     *
     * Синхронът спира, без да пипне нищо, когато промяната иска човешко
     * решение: изчезнал кръг с прогнози или резултати, повече от два изчезнали
     * кръга наведнъж, или кръг с прогнози, който би се преместил с дни.
     * Изчезнал бъдещ кръг, по който няма нищо, просто се маха.
     *
     * Състезание с `manual_schedule` пази часовете си — админът ги е поправил
     * преди Jolpica и синхронът само отбелязва разликата.
     *
     * @return array{races:int, created:array<int, string>, renumbered:array<int, string>, removed:array<int, string>, rescheduled:array<int, string>, kept_manual:array<int, string>}
     *
     * @throws JolpicaException при празен или подозрителен календар
     */
    public function syncCalendar(Season $season): array
    {
        $rows = array_values($this->client->races($season->year));
        $existing = $season->races()->get();

        $report = [
            'races' => count($rows),
            'created' => [],
            'renumbered' => [],
            'removed' => [],
            'rescheduled' => [],
            'kept_manual' => [],
        ];

        if ($rows === []) {
            if ($existing->isNotEmpty()) {
                throw new JolpicaException(
                    "Jolpica върна празен календар за {$season->year}, а в базата има {$existing->count()} състезания — нищо не пипам.",
                );
            }

            return $report;
        }

        $matches = $this->matchExistingRaces($rows, $existing);
        $matchedIds = collect($matches)->filter()->map(fn (Race $race): int => $race->id);
        $orphans = $existing->reject(fn (Race $race): bool => $matchedIds->contains($race->id))->values();

        $this->guardOrphans($season, $orphans);
        $this->guardMovedRaces($season, $rows, $matches);

        DB::transaction(function () use ($season, $rows, $matches, $orphans, &$report) {
            foreach ($orphans as $orphan) {
                $report['removed'][] = "кръг {$orphan->round} {$orphan->name}";
                $orphan->delete();
            }

            // Уникалният индекс (season_id, round) не позволява два кръга с
            // един номер дори за миг. Затова преместваните първо отиват на
            // временен номер извън сезона и чак после на новия си.
            foreach ($matches as $index => $race) {
                $newRound = (int) $rows[$index]['round'];

                if ($race !== null && $race->round !== $newRound) {
                    $report['renumbered'][] = "{$race->name}: кръг {$race->round} → {$newRound}";
                    $race->update(['round' => self::PARKED_ROUND_OFFSET + $newRound]);
                }
            }

            foreach ($rows as $index => $row) {
                $attributes = $this->raceAttributes($row);
                $race = $matches[$index];

                if ($race === null) {
                    $race = $season->races()->create($attributes);
                    $report['created'][] = "кръг {$race->round} {$race->name}";
                    $this->syncSessions($race, $row);

                    continue;
                }

                $timeChanges = $this->describeTimeChanges($race, $attributes);

                if ($race->manual_schedule) {
                    if ($timeChanges !== []) {
                        $report['kept_manual'][] = "{$race->name}: Jolpica дава ".implode(', ', $timeChanges).' — пазя ръчните часове';
                    }

                    $race->update(array_diff_key($attributes, array_flip(self::SCHEDULE_ATTRIBUTES)));

                    continue;
                }

                if ($timeChanges !== []) {
                    $report['rescheduled'][] = "{$race->name}: ".implode(', ', $timeChanges);
                }

                $race->update($attributes);
                $this->syncSessions($race, $row);
            }
        });

        return $report;
    }

    /**
     * Има ли Jolpica вече календар за дадена година (за напомнянето при
     * смяна на сезона — самата смяна остава ръчна).
     */
    public function calendarIsPublished(int $year): bool
    {
        return $this->client->races($year) !== [];
    }

    /**
     * Кое от вече записаните състезания отговаря на всеки ред от Jolpica.
     *
     * Първо по писта, после — за редовете без съвпадение — по дата, ако
     * Jolpica смени идентификатора на пистата (два Гран при в един и същи ден
     * няма). И в двата прохода двойките се подреждат ГЛОБАЛНО по разстояние
     * във времето. Алчно съпоставяне ред по ред дава съществуващото
     * състезание на ПЪРВИЯ ред със същата писта: кръг, вмъкнат по-рано в
     * сезона на вече заета писта, би откраднал състезанието заедно с
     * прогнозите му.
     *
     * @param  array<int, array<string, mixed>>  $rows
     * @param  Collection<int, Race>  $existing
     * @return array<int, Race|null> по индекса на реда
     */
    private function matchExistingRaces(array $rows, Collection $existing): array
    {
        $matches = array_fill(0, count($rows), null);
        $taken = [];
        $rowTimes = array_map(
            fn (array $row): ?CarbonImmutable => $this->combineUtc($row['date'] ?? null, $row['time'] ?? null),
            $rows,
        );

        $passes = [
            fn (array $row, Race $race, int $distance): bool => ($row['Circuit']['circuitId'] ?? null) !== null
                && $race->jolpica_id === $row['Circuit']['circuitId'],
            fn (array $row, Race $race, int $distance): bool => $distance <= self::SAME_RACE_WINDOW_SECONDS,
        ];

        foreach ($passes as $isCandidate) {
            $pairs = [];

            foreach ($rows as $index => $row) {
                if ($matches[$index] !== null) {
                    continue;
                }

                foreach ($existing as $race) {
                    if (isset($taken[$race->id])) {
                        continue;
                    }

                    $distance = $this->secondsBetween($race, $rowTimes[$index]);

                    if ($isCandidate($row, $race, $distance)) {
                        $pairs[] = ['distance' => $distance, 'index' => $index, 'race' => $race];
                    }
                }
            }

            usort($pairs, fn (array $a, array $b): int => [$a['distance'], $a['index']] <=> [$b['distance'], $b['index']]);

            foreach ($pairs as $pair) {
                if ($matches[$pair['index']] !== null || isset($taken[$pair['race']->id])) {
                    continue;
                }

                $matches[$pair['index']] = $pair['race'];
                $taken[$pair['race']->id] = true;
            }
        }

        return $matches;
    }

    /**
     * Спира синхрона, ако махането на липсващите състезания би изтрило нещо
     * ценно или изглежда като повреден отговор от Jolpica.
     *
     * @param  Collection<int, Race>  $orphans
     *
     * @throws JolpicaException
     */
    private function guardOrphans(Season $season, Collection $orphans): void
    {
        if ($orphans->isEmpty()) {
            return;
        }

        $blocking = $orphans->filter(fn (Race $race): bool => $race->race_datetime_utc === null
            || $race->race_datetime_utc->isPast()
            || $race->predictions()->exists()
            || $race->results()->exists());

        if ($blocking->isNotEmpty()) {
            throw new JolpicaException(sprintf(
                'Календарът за %d не е обновен: в Jolpica вече няма %s, а те са минали или по тях има прогнози или резултати. Реши ръчно във Filament и пусни синхрона пак.',
                $season->year,
                $blocking->map(fn (Race $race): string => $this->label($race))->implode(', '),
            ));
        }

        if ($orphans->count() > self::MAX_REMOVED_PER_SYNC) {
            throw new JolpicaException(sprintf(
                'Календарът за %d не е обновен: Jolpica би махнал %d състезания наведнъж (%s) — прилича на повреден отговор.',
                $season->year,
                $orphans->count(),
                $orphans->map(fn (Race $race): string => $this->label($race))->implode(', '),
            ));
        }
    }

    /**
     * Спира синхрона, ако кръг с прогнози или резултати би се преместил с
     * повече от седмица.
     *
     * Отложено състезание е рядкост и иска човешко решение: прогнозите са
     * правени за друг уикенд. А ако съпоставянето по писта сгреши, това е
     * последната преграда пред тихото прехвърляне на прогнози към чуждо
     * състезание. Ако преместването е истинско, смени датата във Filament и
     * синхронът продължава.
     *
     * @param  array<int, array<string, mixed>>  $rows
     * @param  array<int, Race|null>  $matches
     *
     * @throws JolpicaException
     */
    private function guardMovedRaces(Season $season, array $rows, array $matches): void
    {
        $moved = [];

        foreach ($matches as $index => $race) {
            if ($race === null || $race->manual_schedule) {
                continue;
            }

            $raceAt = $this->combineUtc($rows[$index]['date'] ?? null, $rows[$index]['time'] ?? null);

            if ($raceAt === null
                || $race->race_datetime_utc === null
                || $this->secondsBetween($race, $raceAt) <= self::MAX_SILENT_MOVE_SECONDS) {
                continue;
            }

            if ($race->predictions()->exists() || $race->results()->exists()) {
                $moved[] = sprintf(
                    '%s: %s → %s',
                    $this->label($race),
                    $race->race_datetime_utc->format('d.m.Y'),
                    $raceAt->format('d.m.Y'),
                );
            }
        }

        if ($moved !== []) {
            throw new JolpicaException(sprintf(
                'Календарът за %d не е обновен: кръг с прогнози или резултати би се преместил с повече от седмица (%s). Ако е вярно, смени датата във Filament и пусни синхрона пак.',
                $season->year,
                implode(', ', $moved),
            ));
        }
    }

    /**
     * Разликите в часовете между базата и Jolpica, за отчета.
     *
     * @param  array<string, mixed>  $attributes
     * @return array<int, string>
     */
    private function describeTimeChanges(Race $race, array $attributes): array
    {
        $labels = [
            'race_datetime_utc' => 'старт',
            'qualifying_datetime_utc' => 'квалификация',
            'sprint_datetime_utc' => 'спринт',
        ];

        $format = fn (?CarbonInterface $at): string => $at?->format('d.m H:i') ?? '—';
        $changes = [];

        foreach ($labels as $attribute => $label) {
            $current = $race->{$attribute};
            $incoming = $attributes[$attribute];

            if ($current?->getTimestamp() !== $incoming?->getTimestamp()) {
                $changes[] = "{$label} {$format($current)} → {$format($incoming)} UTC";
            }
        }

        return $changes;
    }

    private function label(Race $race): string
    {
        return "кръг {$race->round} {$race->name} (id {$race->id})";
    }

    /**
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    private function raceAttributes(array $row): array
    {
        return [
            'round' => (int) $row['round'],
            'jolpica_id' => $row['Circuit']['circuitId'] ?? null,
            'name' => $row['raceName'],
            'circuit' => $row['Circuit']['circuitName'] ?? '',
            'country' => $row['Circuit']['Location']['country'] ?? '',
            'race_datetime_utc' => $this->combineUtc($row['date'] ?? null, $row['time'] ?? null),
            'qualifying_datetime_utc' => $this->sessionUtc($row, 'Qualifying'),
            'sprint_datetime_utc' => $this->sessionUtc($row, 'Sprint'),
            'has_sprint' => isset($row['Sprint']),
        ];
    }

    private function secondsBetween(Race $race, ?CarbonImmutable $raceAt): int
    {
        if ($race->race_datetime_utc === null || $raceAt === null) {
            return PHP_INT_MAX;
        }

        return (int) abs($race->race_datetime_utc->diffInSeconds($raceAt));
    }

    /**
     * @param  array<string, mixed>  $row
     */
    private function syncSessions(Race $race, array $row): void
    {
        $sprintQualiKey = isset($row['SprintQualifying']) ? 'SprintQualifying' : 'SprintShootout';

        $sessions = [
            SessionType::FP1->value => $this->sessionUtc($row, 'FirstPractice'),
            SessionType::FP2->value => $this->sessionUtc($row, 'SecondPractice'),
            SessionType::FP3->value => $this->sessionUtc($row, 'ThirdPractice'),
            SessionType::Qualifying->value => $this->sessionUtc($row, 'Qualifying'),
            SessionType::SprintQuali->value => $this->sessionUtc($row, $sprintQualiKey),
            SessionType::Sprint->value => $this->sessionUtc($row, 'Sprint'),
            SessionType::Race->value => $this->combineUtc($row['date'] ?? null, $row['time'] ?? null),
        ];

        foreach ($sessions as $type => $scheduledAt) {
            if ($scheduledAt === null) {
                continue;
            }

            $race->sessions()->updateOrCreate(
                ['type' => $type],
                ['scheduled_at_utc' => $scheduledAt],
            );
        }
    }

    /**
     * @param  array<string, mixed>  $row
     */
    private function sessionUtc(array $row, string $key): ?CarbonImmutable
    {
        $session = $row[$key] ?? null;

        if (! is_array($session)) {
            return null;
        }

        return $this->combineUtc($session['date'] ?? null, $session['time'] ?? null);
    }

    private function combineUtc(?string $date, ?string $time): ?CarbonImmutable
    {
        if ($date === null) {
            return null;
        }

        $time = $time !== null ? rtrim($time, 'Z') : '00:00:00';

        return CarbonImmutable::parse("{$date} {$time}", 'UTC');
    }
}
