<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Enums\F2SessionType;
use App\Models\F2Race;
use App\Models\F2Season;
use App\Support\CountryFlag;
use App\Support\DriverName;
use Illuminate\Support\Collection;
use Inertia\Inertia;
use Inertia\Response;

class F2CalendarController extends Controller
{
    public function index(?int $year = null): Response
    {
        $season = $year !== null
            ? F2Season::query()->where('year', $year)->first()
            : F2Season::current();

        abort_if($year !== null && $season === null, 404);

        return Inertia::render('F2/Calendar', [
            'season' => $season?->year,
            'seasons' => F2Season::query()->orderByDesc('year')->pluck('year')->map(fn ($y) => (int) $y),
            'rounds' => $season ? $this->rounds($season) : collect(),
        ]);
    }

    /**
     * @return Collection<int, array<string, mixed>>
     */
    private function rounds(F2Season $season): Collection
    {
        return $season->races()
            ->with(['sessions.results' => fn ($q) => $q->where('position', '<=', 3)->with('driver')])
            ->orderBy('round')
            ->get()
            ->map(fn (F2Race $race) => [
                'round' => $race->round,
                'location' => $race->location_name,
                'circuit_jolpica_id' => $race->circuit_jolpica_id,
                'slug' => $race->slug,
                'sprint' => $this->sessionSummary($race, F2SessionType::SprintRace),
                'feature' => $this->sessionSummary($race, F2SessionType::FeatureRace),
                // Само Баку 2026; другаде е null и картата не се показва.
                'feature_2' => $this->sessionSummary($race, F2SessionType::SecondFeatureRace),
            ]);
    }

    /**
     * @return array{date:?string, podium:Collection<int,array<string,mixed>>}|null
     */
    private function sessionSummary(F2Race $race, F2SessionType $type): ?array
    {
        $session = $race->sessions->firstWhere('session_type', $type);

        if ($session === null) {
            return null;
        }

        return [
            'date' => $session->date?->format('d.m.Y'),
            'podium' => $session->results
                ->sortBy('position')
                ->take(3)
                ->map(fn ($r) => [
                    'position' => $r->position,
                    'driver' => $r->driver ? DriverName::display($r->driver->slug, $r->driver->fullName()) : null,
                    'slug' => $r->driver?->slug,
                    'flag' => CountryFlag::iso2($r->driver?->country_code),
                ])->values(),
        ];
    }
}
