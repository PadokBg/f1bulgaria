<?php

declare(strict_types=1);

use App\Enums\F2SessionType;
use App\Models\F2Driver;
use App\Models\F2Race;
use App\Models\F2RaceSession;
use App\Models\F2Result;
use App\Models\F2Season;
use App\Models\F2Team;
use Inertia\Testing\AssertableInertia as Assert;

function seedTsolovF2(): void
{
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);
    $team = F2Team::create(['f2_season_id' => $season->id, 'name' => 'Campos Racing', 'slug' => 'campos-racing']);
    $tsolov = F2Driver::create([
        'f2_season_id' => $season->id, 'f2_team_id' => $team->id, 'first_name' => 'Nikola', 'last_name' => 'Tsolov',
        'slug' => 'nikola-tsolov', 'car_number' => 6, 'country_code' => 'BUL', 'points' => 75, 'position' => 3,
    ]);
    $race = F2Race::create(['f2_season_id' => $season->id, 'location_name' => 'Melbourne', 'round' => 1, 'slug' => '2026-melbourne']);
    $feature = F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => F2SessionType::FeatureRace]);
    F2Result::create(['f2_race_session_id' => $feature->id, 'f2_driver_id' => $tsolov->id, 'position' => 1, 'points' => 25]);
}

it('/tsolov показва профила от config (единствен източник)', function () {
    // Страницата ползва само config/tsolov.php — за да не се разминават банерът
    // и класирането (F2 auto-sync е непълен и изключен в V1).
    $this->get('/tsolov')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Tsolov')
            ->where('profile.current_team', 'Campos Racing')
            ->has('profile.season_stats')
            ->has('profile.standings'));
});

it('/tsolov рендерира независимо от F2 данните (config-driven)', function () {
    // Без никакъв F2 seed — страницата пак работи изцяло от config.
    $this->get('/tsolov')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Tsolov')
            ->has('profile'));
});

it('/tsolov брои победите от всички състезания, но не от тренировката', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);
    $tsolov = F2Driver::create([
        'f2_season_id' => $season->id, 'first_name' => 'Nikola', 'last_name' => 'Tsolov',
        'slug' => 'nikola-tsolov', 'country_code' => 'BUL', 'points' => 200, 'position' => 2,
    ]);
    F2Driver::create([
        'f2_season_id' => $season->id, 'first_name' => 'Rafael', 'last_name' => 'Câmara',
        'slug' => 'rafael-camara', 'points' => 207, 'position' => 1,
    ]);
    $race = F2Race::create(['f2_season_id' => $season->id, 'location_name' => 'Baku', 'round' => 12, 'slug' => '2026-baku']);

    // Второто главно (Баку 2026) е състезание като всяко друго.
    foreach ([F2SessionType::Practice, F2SessionType::FeatureRace, F2SessionType::SecondFeatureRace] as $type) {
        $session = F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => $type]);
        F2Result::create(['f2_race_session_id' => $session->id, 'f2_driver_id' => $tsolov->id, 'position' => 1]);
    }

    $this->get('/tsolov')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('profile.season_stats.wins', 2)
            ->where('profile.season_stats.championship_position', 2));
});

it('/tsolov не брои кръга в бележката, докато няма резултат от състезание', function () {
    $season = F2Season::create(['year' => 2026, 'is_current' => true]);
    $tsolov = F2Driver::create([
        'f2_season_id' => $season->id, 'first_name' => 'Nikola', 'last_name' => 'Tsolov',
        'slug' => 'nikola-tsolov', 'points' => 200, 'position' => 1,
    ]);

    // Кръг 12 е изкаран; в кръг 13 е минала само тренировката (петък).
    foreach ([12 => F2SessionType::FeatureRace, 13 => F2SessionType::Practice] as $round => $type) {
        $race = F2Race::create(['f2_season_id' => $season->id, 'location_name' => "R{$round}", 'round' => $round, 'slug' => "2026-r{$round}"]);
        $session = F2RaceSession::create(['f2_race_id' => $race->id, 'session_type' => $type]);
        F2Result::create(['f2_race_session_id' => $session->id, 'f2_driver_id' => $tsolov->id, 'position' => 1]);
    }

    $this->get('/tsolov')
        ->assertInertia(fn (Assert $page) => $page
            ->where('profile.standings_note', 'Класиране след 1 от 2 кръга · fiaformula2.com'));
});

it('/f2 показва spotlight за българския състезател', function () {
    seedTsolovF2();

    $this->get('/f2')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            // Име на пилота за екрана през DriverName::display — кирилица.
            // Името на отбора НЕ се локализира.
            ->where('bulgarianSpotlight.name', 'Никола Цолов')
            ->where('bulgarianSpotlight.team', 'Campos Racing'));
});
