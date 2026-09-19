<?php

declare(strict_types=1);

use App\Jobs\ValidateGameRaceJob;
use App\Models\GameLapRecord;
use App\Models\GameRaceRecord;
use App\Models\User;
use Illuminate\Support\Facades\Queue;

beforeEach(function () {
    config(['features.game' => true]);

    // На sync опашката job-ът би тръгнал инлайн и би викал node срещу
    // фиктивните трейсове — e2e валидацията е в ValidateGameRaceJobTest.
    Queue::fake();
});

/**
 * @return array<string, mixed>
 */
function racePayload(array $overrides = []): array
{
    return array_merge([
        'track' => 'monza',
        'race_ms' => 360000,
        'penalties' => 2,
        'position' => 3,
        'trace' => '{"v":3,"rv":2,"opponents":5,"inputs":"AAAA"}',
        'sim_version' => 3,
        'race_version' => (int) config('game.race_version'),
    ], $overrides);
}

it('пази правилата на състезанието еднакви в браузъра и на сървъра', function (string $constant, string $configKey) {
    $source = (string) file_get_contents(resource_path('js/game/race.js'));
    preg_match('/export const '.$constant.'\s*=\s*(\d+)\s*;/', $source, $matches);

    expect($matches[1] ?? null)->not->toBeNull()
        ->and((int) $matches[1])->toBe((int) config($configKey));
})->with([
    ['RACE_VERSION', 'game.race_version'],
    ['RACE_OPPONENTS', 'game.race.opponents'],
    ['RACE_TOTAL_LAPS', 'game.race.total_laps'],
    ['RACE_PENALTY_MS', 'game.race.penalty_ms'],
]);

it('страницата показва същите правила, които race.js прилага', function () {
    $page = (string) file_get_contents(resource_path('js/Pages/Game/Index.vue'));

    preg_match('/const RIVAL_COUNT\s*=\s*(\d+);/', $page, $rivals);
    preg_match('/const RACE_TOTAL_LAPS_FALLBACK\s*=\s*(\d+);/', $page, $laps);
    preg_match('/const RACE_PENALTY_SECONDS\s*=\s*(\d+);/', $page, $penalty);

    expect((int) ($rivals[1] ?? 0))->toBe((int) config('game.race.opponents'))
        ->and((int) ($laps[1] ?? 0))->toBe((int) config('game.race.total_laps'))
        ->and((int) ($penalty[1] ?? 0) * 1000)->toBe((int) config('game.race.penalty_ms'));
});

it('иска вход за запис на състезание', function () {
    $this->postJson('/game/race', racePayload())->assertUnauthorized();
});

it('записва състезанието като pending, смята наказанията и пуска валидацията', function () {
    $user = User::factory()->create(['name' => 'Пилот']);

    $this->actingAs($user)
        ->postJson('/game/race', racePayload())
        ->assertOk()
        ->assertJson([
            // 360 s + 2 × 5 s наказание — общото време го смята сървърът.
            'total_ms' => 370000,
            'personal_best' => true,
            'rank' => 1,
            'user_best_ms' => 370000,
        ])
        ->assertJsonPath('top.0.name', 'Пилот')
        ->assertJsonPath('top.0.is_you', true);

    $record = GameRaceRecord::query()->sole();

    expect($record->verify_status)->toBe('pending')
        ->and($record->total_ms)->toBe(370000)
        ->and($record->race_version)->toBe((int) config('game.race_version'));

    Queue::assertPushed(
        ValidateGameRaceJob::class,
        fn (ValidateGameRaceJob $job): bool => $job->recordId === $record->id,
    );
});

it('не приема общо време от клиента', function () {
    $user = User::factory()->create();

    $this->actingAs($user)
        ->postJson('/game/race', racePayload(['penalties' => 0, 'total_ms' => 1]))
        ->assertOk()
        ->assertJsonPath('total_ms', 360000);
});

it('по-бавно състезание не е личен рекорд и не сваля най-доброто', function () {
    $user = User::factory()->create();

    $this->actingAs($user)->postJson('/game/race', racePayload(['penalties' => 0]))->assertOk();

    $this->actingAs($user)
        ->postJson('/game/race', racePayload(['race_ms' => 400000, 'penalties' => 0]))
        ->assertOk()
        ->assertJson(['personal_best' => false, 'user_best_ms' => 360000]);
});

it('отхвърля невалиден запис на състезание', function (array $overrides, string $field) {
    $user = User::factory()->create();

    $this->actingAs($user)
        ->postJson('/game/race', racePayload($overrides))
        ->assertJsonValidationErrors($field);

    expect(GameRaceRecord::query()->count())->toBe(0);
})->with([
    'без трейс' => [['trace' => null], 'trace'],
    'стари правила' => [['race_version' => 0], 'race_version'],
    'стара физика' => [['sim_version' => 2], 'sim_version'],
    'непозната писта' => [['track' => 'nope'], 'track'],
    'позиция извън решетката' => [['position' => 7], 'position'],
    'отрицателни наказания' => [['penalties' => -1], 'penalties'],
    // 3 обиколки Монца (~5.8 km) под 3 минути надхвърлят максималната скорост.
    'неправдоподобно бързо' => [['race_ms' => 150000], 'race_ms'],
]);

it('класацията „Състезание" е по най-доброто общо време на потребител', function () {
    $alice = User::factory()->create(['name' => 'Алиса']);
    $bob = User::factory()->create(['name' => 'Боби']);

    GameRaceRecord::factory()->for($bob)->create(['total_ms' => 365000]);
    GameRaceRecord::factory()->for($alice)->create(['total_ms' => 380000]);
    GameRaceRecord::factory()->for($alice)->create(['total_ms' => 361000]);

    $this->actingAs($alice)
        ->getJson('/game/leaderboard/monza')
        ->assertOk()
        ->assertJsonCount(2, 'race_top')
        ->assertJsonPath('race_top.0.name', 'Алиса')
        ->assertJsonPath('race_top.0.total_ms', 361000)
        ->assertJsonPath('race_top.0.is_you', true)
        ->assertJsonPath('race_top.1.name', 'Боби')
        ->assertJsonPath('user_race_best_ms', 361000);
});

it('отхвърлените и старите състезания не се броят', function () {
    $honest = User::factory()->create(['name' => 'Честният']);
    $cheat = User::factory()->create(['name' => 'Хитрецът']);
    $legacy = User::factory()->create(['name' => 'Старият']);

    GameRaceRecord::factory()->for($honest)->create(['total_ms' => 370000, 'verify_status' => 'pending']);
    GameRaceRecord::factory()->for($cheat)->create(['total_ms' => 200000, 'verify_status' => 'rejected']);
    GameRaceRecord::factory()->for($legacy)->create(['total_ms' => 300000, 'race_version' => 0]);

    $this->getJson('/game/leaderboard/monza')
        ->assertOk()
        ->assertJsonCount(1, 'race_top')
        ->assertJsonPath('race_top.0.name', 'Честният')
        ->assertJsonPath('user_race_best_ms', null);
});

it('класацията казва кой има дух за задочна битка', function () {
    $ghosted = User::factory()->create(['name' => 'С дух']);
    $plain = User::factory()->create(['name' => 'Без дух']);

    GameRaceRecord::factory()->for($ghosted)->create(['total_ms' => 360000, 'ghost_frames' => 'кадри', 'race_ticks' => 43200]);
    GameRaceRecord::factory()->for($plain)->create(['total_ms' => 370000]);

    $this->getJson('/game/leaderboard/monza')
        ->assertOk()
        ->assertJsonPath('race_top.0.user_id', $ghosted->id)
        ->assertJsonPath('race_top.0.has_ghost', true)
        ->assertJsonPath('race_top.1.has_ghost', false);
});

it('сервира духа на най-доброто състезание с кадри', function () {
    $user = User::factory()->create(['name' => 'Съперник']);
    // По-бързо, но без кадри (напр. кадрите паднаха над тавана).
    GameRaceRecord::factory()->for($user)->create(['total_ms' => 350000]);
    GameRaceRecord::factory()->for($user)->create([
        'race_ms' => 355000,
        'penalties' => 1,
        'total_ms' => 360000,
        'ghost_frames' => 'кадри-360',
        'race_ticks' => 42600,
    ]);

    $this->getJson("/game/race-ghost/monza/{$user->id}")
        ->assertOk()
        ->assertJson([
            'v' => 3,
            'rv' => (int) config('game.race_version'),
            'race_ms' => 355000,
            'penalties' => 1,
            'total_ms' => 360000,
            'race_ticks' => 42600,
            'frames' => 'кадри-360',
            'name' => 'Съперник',
        ]);
});

it('духът на състезание е 404 без кадри, при отхвърлено или непозната писта', function () {
    $user = User::factory()->create();
    GameRaceRecord::factory()->for($user)->create(['total_ms' => 360000]);
    GameRaceRecord::factory()->for($user)->create([
        'total_ms' => 300000,
        'verify_status' => 'rejected',
        'ghost_frames' => 'фалшиви-кадри',
    ]);

    $this->getJson("/game/race-ghost/monza/{$user->id}")->assertNotFound();
    $this->getJson("/game/race-ghost/nope/{$user->id}")->assertNotFound();
});

it('състезанията и обиколките са отделни класации', function () {
    $racer = User::factory()->create(['name' => 'Състезател']);
    $solo = User::factory()->create(['name' => 'Соло']);

    GameRaceRecord::factory()->for($racer)->create();
    GameLapRecord::factory()->for($solo)->create(['lap_ms' => 90000]);

    $this->getJson('/game/leaderboard/monza')
        ->assertOk()
        ->assertJsonCount(1, 'top')
        ->assertJsonPath('top.0.name', 'Соло')
        ->assertJsonCount(1, 'race_top')
        ->assertJsonPath('race_top.0.name', 'Състезател');
});
