<?php

declare(strict_types=1);

use App\Jobs\ValidateGameLapJob;
use App\Models\GameLapRecord;
use App\Models\User;
use App\Services\Game\NodeReplayRunner;

/**
 * Истински end-to-end: PHP job → Node валидатор → същата симулация.
 * Фикстурата е реална обиколка (автопилот), генерирана със sim.js —
 * при промяна на физиката се регенерира (виж scripts/game/selftest.mjs).
 */
beforeEach(function () {
    config(['features.game' => true]);

    $this->fixture = json_decode(
        (string) file_get_contents(base_path('tests/Fixtures/game/monza-lap.json')),
        true,
        512,
        JSON_THROW_ON_ERROR,
    );
});

it('има retry прозорец над максималното време на валидатора', function () {
    $job = new ValidateGameLapJob(1);

    expect(config('queue.connections.database.retry_after'))
        ->toBeGreaterThan($job->timeout);
});

it('потвърждава истинска обиколка чрез преиграване в Node', function () {
    $record = GameLapRecord::factory()->for(User::factory()->create())->create([
        'track_slug' => 'monza',
        'lap_ms' => $this->fixture['lap_ms'],
        'sector1_ms' => $this->fixture['sectors_ms'][0],
        'sector2_ms' => $this->fixture['sectors_ms'][1],
        'sector3_ms' => $this->fixture['sectors_ms'][2],
        'input_trace' => $this->fixture['trace'],
        'sim_version' => $this->fixture['sim_version'],
        'verify_status' => 'pending',
    ]);

    // По-стара (по-бавна) обиколка на същия потребител с кадри — pruning-ът
    // трябва да ги изчисти, щом новата стане най-добрата с дух.
    $older = GameLapRecord::factory()->for($record->user)->create([
        'track_slug' => 'monza',
        'lap_ms' => $this->fixture['lap_ms'] + 60000,
        'verify_status' => 'verified',
        'ghost_frames' => 'старите-кадри',
        'lap_ticks' => 999,
    ]);

    (new ValidateGameLapJob($record->id))->handle(new NodeReplayRunner);

    $record->refresh();

    expect($record->verify_status)->toBe('verified')
        ->and($record->verified_lap_ms)->toBe($this->fixture['lap_ms'])
        // Преиграното време е авторитетното — записът го носи.
        ->and($record->lap_ms)->toBe($this->fixture['lap_ms'])
        // Кадрите на духа идват от преиграването — дуелите ги чакат.
        ->and($record->ghost_frames)->not->toBeNull()
        ->and($record->lap_ticks)->toBeGreaterThan(0)
        // Само най-добрата обиколка пази кадри.
        ->and($older->refresh()->ghost_frames)->toBeNull();
})->skip(
    fn (): bool => trim((string) shell_exec('node --version 2>&1')) === '',
    'Node не е наличен в тази среда.',
);

it('отхвърля обиколка с подправено (по-бързо) време', function () {
    $record = GameLapRecord::factory()->for(User::factory()->create())->create([
        'track_slug' => 'monza',
        // Твърди 30 секунди по-бързо от каквото трейсът реално вози.
        'lap_ms' => $this->fixture['lap_ms'] - 30000,
        'sector1_ms' => 30000,
        'sector2_ms' => 30000,
        'sector3_ms' => $this->fixture['lap_ms'] - 90000,
        'input_trace' => $this->fixture['trace'],
        'sim_version' => $this->fixture['sim_version'],
        'verify_status' => 'pending',
    ]);

    (new ValidateGameLapJob($record->id))->handle(new NodeReplayRunner);

    $record->refresh();

    // Отхвърлена обиколка никога не оставя дух — иначе фалшиво време би
    // се раздавало като съперник за дуели.
    expect($record->verify_status)->toBe('rejected')
        ->and($record->ghost_frames)->toBeNull();
})->skip(
    fn (): bool => trim((string) shell_exec('node --version 2>&1')) === '',
    'Node не е наличен в тази среда.',
);

it('счупен трейс дава rejected, а не 500', function () {
    $record = GameLapRecord::factory()->for(User::factory()->create())->create([
        'track_slug' => 'monza',
        'lap_ms' => 90000,
        'input_trace' => 'нещо счупено',
        'sim_version' => 3,
        'verify_status' => 'pending',
    ]);

    (new ValidateGameLapJob($record->id))->handle(new NodeReplayRunner);

    expect($record->refresh()->verify_status)->toBe('rejected');
})->skip(
    fn (): bool => trim((string) shell_exec('node --version 2>&1')) === '',
    'Node не е наличен в тази среда.',
);

it('отхвърля чакащ job от стара симулация без да стартира валидатора', function () {
    $record = GameLapRecord::factory()->for(User::factory()->create())->create([
        'track_slug' => 'monza',
        'lap_ms' => 90000,
        'input_trace' => '{"v":2,"start":{},"inputs":"AAA="}',
        'sim_version' => 2,
        'verify_status' => 'pending',
    ]);

    (new ValidateGameLapJob($record->id))->handle(new NodeReplayRunner);

    expect($record->refresh()->verify_status)->toBe('rejected');
});
