<?php

declare(strict_types=1);

namespace App\Services\Races;

use App\Enums\ResultSessionType;
use App\Enums\SessionType;
use App\Models\Race;
use App\Models\Result;
use App\Models\SessionResult;
use App\Support\DriverName;
use Illuminate\Support\Collection;
use Illuminate\Support\Str;

/**
 * Единственото място, което решава ОТКЪДЕ се показва класацията на сесия.
 *
 * Два източника с различни силни страни:
 *
 * - Jolpica (`results`) е авторитетен — от него идват точките, класирането в
 *   шампионата и точкуването на прогнозите. Но публикува с часове закъснение.
 * - OpenF1 (`session_results`) е бърз — минути след финала. Покрива и
 *   тренировките, които Jolpica изобщо няма. Но е от 2023 г. нататък и е
 *   с некомерсиален лиценз.
 *
 * Затова: за състезание и спринт показваме Jolpica, щом е налице, а дотогава
 * OpenF1 — маркирано като временно. За останалите сесии има само едно.
 *
 * ВАЖНО: това е слой само за ПОКАЗВАНЕ. Нищо тук не влиза в точките и в
 * класирането — те четат `results` директно и остават непокътнати.
 */
class RaceClassificationProvider
{
    public function __construct(
        private readonly RaceNameLocalizer $raceNames,
    ) {}

    /**
     * Класациите от всички сесии на уикенда, в реда на провеждането им.
     *
     * @return array<int, array{type:string, label:string, provisional:bool, rows:array<int, array<string, mixed>>}>
     */
    public function all(Race $race): array
    {
        $sections = [];

        foreach (SessionType::cases() as $type) {
            $section = $this->for($race, $type);

            if ($section !== null) {
                $sections[] = $section;
            }
        }

        usort(
            $sections,
            fn (array $a, array $b): int => SessionType::from($a['type'])->order() <=> SessionType::from($b['type'])->order(),
        );

        return $sections;
    }

    /**
     * @return array{type:string, label:string, provisional:bool, rows:array<int, array<string, mixed>>}|null
     */
    public function for(Race $race, SessionType $type): ?array
    {
        // Авторитетният източник води. Само ако още го няма, минаваме на бързия.
        $authoritative = $type->isRace()
            ? $this->authoritativeRows($race, $type)
            : collect();

        $rows = $authoritative->isNotEmpty()
            ? $this->normalise($authoritative, withPoints: true)
            : $this->normalise($this->fastRows($race, $type), withPoints: false);

        if ($rows === []) {
            return null;
        }

        return [
            'type' => $type->value,
            'label' => $type->label(),
            // Временна е само класация на състезание, дошла по бързия път —
            // тя няма точки и подлежи на промяна от стюардите.
            'provisional' => $type->isRace() && $authoritative->isEmpty(),
            'rows' => $rows,
        ];
    }

    public function raceName(Race $race): string
    {
        return $this->raceNames->forRace($race);
    }

    /**
     * @return Collection<int, Result>
     */
    private function authoritativeRows(Race $race, SessionType $type): Collection
    {
        $sessionType = $type === SessionType::Sprint
            ? ResultSessionType::Sprint
            : ResultSessionType::Race;

        return Result::query()
            ->where('race_id', $race->id)
            ->where('session_type', $sessionType->value)
            ->with('driver.constructor')
            ->get();
    }

    /**
     * @return Collection<int, SessionResult>
     */
    private function fastRows(Race $race, SessionType $type): Collection
    {
        return SessionResult::query()
            ->where('race_id', $race->id)
            ->where('session_type', $type->value)
            ->with('driver.constructor')
            ->get();
    }

    /**
     * Привежда двата източника към една форма, за да не се налага на
     * потребителите им да знаят откъде идва редът.
     *
     * @param  Collection<int, Result|SessionResult>  $rows
     * @return array<int, array<string, mixed>>
     */
    private function normalise(Collection $rows, bool $withPoints): array
    {
        return $rows
            // Некласираните отиват най-долу — null иначе се подрежда най-горе.
            ->sortBy(fn ($row): int => $row->position ?? 999)
            ->values()
            ->map(fn ($row): array => [
                'position' => $row->position,
                'driver' => $this->driverName($row),
                // Без пилот от ростъра няма и страница, към която да водим.
                'slug' => $row->driver?->slug,
                // Кой е пилотът и когато е извън ростъра — за съпоставяне
                // (кого постът да допише под първите десет), не за линк.
                'name_slug' => $this->nameSlug($row),
                'team' => $row->driver?->constructor?->name
                    ?? ($row instanceof SessionResult ? $row->team_name : null),
                'time' => $row instanceof SessionResult ? $row->bestQualifyingTime() : null,
                'gap' => $row instanceof SessionResult ? $row->gap : null,
                'points' => $withPoints ? (float) $row->points : null,
                'dnf' => (bool) $row->dnf,
                'fastest_lap' => $row instanceof Result ? (bool) $row->fastest_lap : false,
            ])
            ->all();
    }

    /**
     * Пилот извън ростъра (новак във FP1) няма ред в `drivers` — името му идва
     * от самата класация. Кирилицата се търси по същия slug като за всички.
     */
    private function driverName(Result|SessionResult $row): ?string
    {
        if ($row->driver !== null) {
            return DriverName::display($row->driver->slug, $row->driver->fullName());
        }

        if ($row instanceof SessionResult && filled($row->driver_name)) {
            return DriverName::display($this->nameSlug($row), $row->driver_name);
        }

        return null;
    }

    /**
     * Slug-ът на пилота: от ростъра, а извън него — от името в класацията.
     *
     * Ростърът пише slug-а като пълното име през тире („alexander-albon"),
     * така че новак и титуляр със същото име дават един и същ ключ.
     */
    private function nameSlug(Result|SessionResult $row): ?string
    {
        if ($row->driver !== null) {
            return $row->driver->slug;
        }

        return $row instanceof SessionResult && filled($row->driver_name)
            ? Str::slug($row->driver_name)
            : null;
    }
}
