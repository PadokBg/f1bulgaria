<?php

declare(strict_types=1);

use App\Models\GameLapRecord;
use App\Models\User;

/*
 * Фунията на госта: кара → вижда каква позиция е времето му → влиза → времето
 * влиза в класацията само.
 *
 * Регресията, която това пази: /game/lap е зад 'auth', а клиентът дори не
 * опитваше да изпрати бега на гост. Резултат — 172 посещения на играта и нула
 * реда в game_lap_records на прод.
 */

beforeEach(function () {
    config(['features.game' => true]);
});

it('връща 404 за преглед на време когато флагът е изключен', function () {
    config(['features.game' => false]);

    $this->postJson('/game/lap/preview', ['track' => 'monza', 'lap_ms' => 90000])
        ->assertNotFound();
});

it('казва на гост каква позиция би било времето му', function () {
    $faster = User::factory()->create();
    $slower = User::factory()->create();

    GameLapRecord::factory()->for($faster)->create([
        'track_slug' => 'monza',
        'lap_ms' => 80000,
        'verify_status' => 'verified',
    ]);
    GameLapRecord::factory()->for($slower)->create([
        'track_slug' => 'monza',
        'lap_ms' => 95000,
        'verify_status' => 'verified',
    ]);

    $this->postJson('/game/lap/preview', ['track' => 'monza', 'lap_ms' => 90000])
        ->assertOk()
        ->assertJson([
            'rank' => 2,
            'ranked_users' => 2,
            'leader_ms' => 80000,
            'gap_ms' => 10000,
            'purple_lap' => false,
        ]);
});

it('отчита рекордно време на гост като лилаво', function () {
    GameLapRecord::factory()->for(User::factory())->create([
        'track_slug' => 'monza',
        'lap_ms' => 95000,
        'verify_status' => 'verified',
    ]);

    $this->postJson('/game/lap/preview', ['track' => 'monza', 'lap_ms' => 90000])
        ->assertOk()
        ->assertJson(['rank' => 1, 'purple_lap' => true, 'gap_ms' => -5000]);
});

it('дава първа позиция на празна класация', function () {
    $this->postJson('/game/lap/preview', ['track' => 'monza', 'lap_ms' => 90000])
        ->assertOk()
        ->assertJson(['rank' => 1, 'ranked_users' => 0, 'leader_ms' => null, 'gap_ms' => null, 'purple_lap' => true]);
});

it('не брои отхвърлени и стари обиколки в позицията на госта', function () {
    GameLapRecord::factory()->for(User::factory())->create([
        'track_slug' => 'monza',
        'lap_ms' => 70000,
        'verify_status' => 'rejected',
    ]);
    GameLapRecord::factory()->for(User::factory())->create([
        'track_slug' => 'monza',
        'lap_ms' => 70000,
        'sim_version' => 2,
        'verify_status' => 'verified',
    ]);

    $this->postJson('/game/lap/preview', ['track' => 'monza', 'lap_ms' => 90000])
        ->assertOk()
        ->assertJson(['rank' => 1, 'ranked_users' => 0]);
});

it('брои само най-доброто време на всеки потребител', function () {
    $rival = User::factory()->create();

    foreach ([85000, 88000, 92000] as $lap) {
        GameLapRecord::factory()->for($rival)->create([
            'track_slug' => 'monza',
            'lap_ms' => $lap,
            'verify_status' => 'verified',
        ]);
    }

    $this->postJson('/game/lap/preview', ['track' => 'monza', 'lap_ms' => 90000])
        ->assertOk()
        ->assertJson(['rank' => 2, 'ranked_users' => 1]);
});

it('не записва нищо при преглед', function () {
    $this->postJson('/game/lap/preview', ['track' => 'monza', 'lap_ms' => 90000])->assertOk();

    expect(GameLapRecord::query()->count())->toBe(0);
});

it('отхвърля преглед за непозната писта и неправдоподобно време', function () {
    $this->postJson('/game/lap/preview', ['track' => 'nonsense', 'lap_ms' => 90000])
        ->assertJsonValidationErrors('track');

    $this->postJson('/game/lap/preview', ['track' => 'monza', 'lap_ms' => 10])
        ->assertJsonValidationErrors('lap_ms');
});

it('праща госта към вход и го връща в играта след това', function () {
    $this->get('/game/save-lap')->assertRedirect('/login');

    expect(session('url.intended'))->toContain('/game/save-lap');

    $this->actingAs(User::factory()->create())
        ->get('/game/save-lap')
        ->assertRedirect('/game');
});

it('връща новорегистрирания там, откъдето е тръгнал', function () {
    $this->get('/game/save-lap')->assertRedirect('/login');

    $this->post('/register', [
        'name' => 'Нов фен',
        'email' => 'nov@padok.bg',
        'password' => 'parola-dostatychno-dylga',
        'password_confirmation' => 'parola-dostatychno-dylga',
    ])->assertRedirect('/game/save-lap');

    $this->assertAuthenticated();
});

it('праща новорегистрирания при прогнозите когато не идва отнякъде', function () {
    $this->post('/register', [
        'name' => 'Друг фен',
        'email' => 'drug@padok.bg',
        'password' => 'parola-dostatychno-dylga',
        'password_confirmation' => 'parola-dostatychno-dylga',
    ])->assertRedirect();

    $this->assertAuthenticated();
});
