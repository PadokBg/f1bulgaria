<?php

declare(strict_types=1);

use App\Enums\F2SessionType;
use App\Models\F2Driver;
use App\Models\F2Race;
use App\Models\F2RaceSession;
use App\Models\F2Season;
use Inertia\Testing\AssertableInertia as Assert;

/*
 * „Цоловметърът" на началната страница. Страницата /tsolov съществуваше и
 * досега, но до нея се стигаше само през менюто — а единственото уникално
 * българско нещо на сайта не бива да чака някой да отвори менюто.
 */

beforeEach(function () {
    config(['features.tsolov' => true]);
});

function f2Season(): F2Season
{
    return F2Season::create(['year' => 2026, 'is_current' => true]);
}

function f2Driver(F2Season $season, string $slug, string $first, string $last, int $position, float $points): F2Driver
{
    return F2Driver::create([
        'f2_season_id' => $season->id,
        'first_name' => $first,
        'last_name' => $last,
        'slug' => $slug,
        'position' => $position,
        'points' => $points,
    ]);
}

it('не показва блока при изключен флаг', function () {
    config(['features.tsolov' => false]);
    $season = f2Season();
    f2Driver($season, 'nikola-tsolov', 'Nikola', 'Tsolov', 1, 177);

    $this->get('/')->assertInertia(fn (Assert $page) => $page->where('tsolov', null));
});

it('не показва блока без синхронизиран сезон', function () {
    $this->get('/')->assertInertia(fn (Assert $page) => $page->where('tsolov', null));
});

it('показва аванса когато Цолов води', function () {
    $season = f2Season();
    f2Driver($season, 'nikola-tsolov', 'Nikola', 'Tsolov', 1, 177);
    f2Driver($season, 'rafael-camara', 'Rafael', 'Câmara', 2, 170);

    $this->get('/')->assertInertia(fn (Assert $page) => $page
        ->where('tsolov.position', 1)
        ->where('tsolov.points', 177)
        ->where('tsolov.leads', true)
        ->where('tsolov.rival.gap', 7));
});

it('показва изоставането когато Цолов гони', function () {
    $season = f2Season();
    f2Driver($season, 'nikola-tsolov', 'Nikola', 'Tsolov', 3, 153);
    f2Driver($season, 'rafael-camara', 'Rafael', 'Câmara', 2, 170);

    $this->get('/')->assertInertia(fn (Assert $page) => $page
        ->where('tsolov.leads', false)
        ->where('tsolov.rival.gap', 17));
});

it('не се обърква от дублиран пилот на същата позиция', function () {
    // Синхронизацията вече е правила два реда за един пилот (Alexander/Alex
    // Dunne). Съперникът трябва да е редът с повече точки, а не случаен.
    $season = f2Season();
    f2Driver($season, 'nikola-tsolov', 'Nikola', 'Tsolov', 2, 150);
    f2Driver($season, 'alex-dunne', 'Alex', 'Dunne', 1, 108);
    f2Driver($season, 'alexander-dunne', 'Alexander', 'Dunne', 1, 170);

    $this->get('/')->assertInertia(fn (Assert $page) => $page
        ->where('tsolov.rival.name', 'Александър Дън')
        ->where('tsolov.rival.gap', 20));
});

it('брои до следващата сесия с точки, а не до тренировка', function () {
    $season = f2Season();
    f2Driver($season, 'nikola-tsolov', 'Nikola', 'Tsolov', 1, 177);

    $race = F2Race::create([
        'f2_season_id' => $season->id,
        'location_name' => 'Baku',
        'country_name' => 'Azerbaijan',
        'round' => 12,
        'slug' => 'baku-2026',
    ]);

    F2RaceSession::create([
        'f2_race_id' => $race->id,
        'session_type' => F2SessionType::Practice,
        'date' => now()->addDay()->toDateString(),
        'scheduled_at_utc' => now()->addDay(),
    ]);
    F2RaceSession::create([
        'f2_race_id' => $race->id,
        'session_type' => F2SessionType::SprintRace,
        'date' => now()->addDays(2)->toDateString(),
        'scheduled_at_utc' => now()->addDays(2),
    ]);

    $this->get('/')->assertInertia(fn (Assert $page) => $page
        ->where('tsolov.next.label', 'Спринт')
        ->where('tsolov.next.location', 'Baku')
        ->where('tsolov.next.round', 12));
});

it('брои оставащите кръгове по главните състезания напред', function () {
    $season = f2Season();
    f2Driver($season, 'nikola-tsolov', 'Nikola', 'Tsolov', 1, 177);

    foreach ([['минал', now()->subWeek()], ['идващ', now()->addWeek()], ['последен', now()->addMonth()]] as $i => [$slug, $at]) {
        $race = F2Race::create([
            'f2_season_id' => $season->id,
            'location_name' => "Писта {$slug}",
            'round' => $i + 1,
            'slug' => "pista-{$i}",
        ]);

        F2RaceSession::create([
            'f2_race_id' => $race->id,
            'session_type' => F2SessionType::FeatureRace,
            'date' => $at->toDateString(),
            'scheduled_at_utc' => $at,
        ]);
    }

    $this->get('/')->assertInertia(fn (Assert $page) => $page->where('tsolov.rounds_left', 2));
});
