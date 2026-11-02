<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Enums\F2SessionType;
use App\Models\F2Driver;
use App\Models\F2Result;
use App\Models\F2Season;
use App\Models\F2Team;
use App\Support\CountryFlag;
use App\Support\DriverName;
use Illuminate\Support\Collection;
use Inertia\Inertia;
use Inertia\Response;

class F2TeamsController extends Controller
{
    public function index(): Response
    {
        $season = F2Season::current();

        $teams = $season
            ? $season->teams()->with('drivers')->get()
                ->map(fn (F2Team $t) => [
                    'slug' => $t->slug,
                    'name' => $t->name,
                    'drivers' => $t->drivers->count(),
                    'points' => (float) $t->drivers->sum('points'),
                ])
                ->sortByDesc('points')->values()
            : collect();

        return Inertia::render('F2/TeamIndex', [
            'season' => $season?->year,
            'teams' => $teams,
        ]);
    }

    public function show(string $slug): Response
    {
        $entries = F2Team::query()->where('slug', $slug)->with(['season', 'drivers.season'])->get();

        abort_if($entries->isEmpty(), 404);

        $latest = $entries->sortByDesc(fn (F2Team $t) => $t->season?->year)->first();
        $driverIds = $entries->flatMap(fn (F2Team $t) => $t->drivers->pluck('id'));
        $allDrivers = $entries->flatMap->drivers;

        // Само състезания — класациите от тренировките и квалификациите (API
        // синхронът ги пази от 2026) не са победи и подиуми.
        $raceResults = F2Result::query()
            ->whereIn('f2_driver_id', $driverIds)
            ->whereHas('session', fn ($query) => $query->whereIn('session_type', F2SessionType::races()));

        return Inertia::render('F2/TeamShow', [
            'team' => [
                'slug' => $slug,
                'name' => $latest->name,
            ],
            'stats' => [
                'seasons' => $entries->count(),
                'wins' => (clone $raceResults)->where('position', 1)->count(),
                'podiums' => (clone $raceResults)->whereNotNull('position')->where('position', '<=', 3)->count(),
                'championships' => $allDrivers->where('is_champion', true)->count(),
            ],
            'currentDrivers' => $latest->drivers->map(fn ($d) => [
                'slug' => $d->slug,
                'name' => DriverName::display($d->slug, $d->fullName()),
                'flag' => CountryFlag::iso2($d->country_code),
                'is_bulgarian' => $d->country_code === 'BUL',
            ])->values(),
            'alumni' => $this->alumni($allDrivers),
        ]);
    }

    /**
     * Уникални пилоти през сезоните на отбора (с годините).
     *
     * @param  Collection<int, F2Driver>  $drivers
     * @return Collection<int, array<string, mixed>>
     */
    private function alumni(Collection $drivers): Collection
    {
        return $drivers
            ->groupBy('slug')
            ->map(fn (Collection $rows) => [
                'slug' => $rows->first()->slug,
                'name' => DriverName::display($rows->first()->slug, $rows->first()->fullName()),
                'flag' => CountryFlag::iso2($rows->first()->country_code),
                'years' => $rows->map(fn ($d) => $d->season?->year)->filter()->unique()->sort()->values(),
            ])
            ->values();
    }
}
