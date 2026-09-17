<?php

declare(strict_types=1);

use App\Jobs\ValidateGameRaceJob;
use App\Models\GameRaceRecord;
use App\Models\User;
use App\Services\Game\NodeReplayRunner;

/**
 * Истински end-to-end: PHP job → Node валидатор → същата симулация на цялото
 * поле. Фикстурата е реално състезание (автопилот срещу решетката) —
 * регенерира се с scripts/game/make-race-fixture.mjs при промяна на версиите.
 */
beforeEach(function () {
    config(['features.game' => true]);

    $this->fixture = json_decode(
        (string) file_get_contents(base_path('tests/Fixtures/game/race.json')),
        true,
        512,
        JSON_THROW_ON_ERROR,
    );
});

/**
 * @param  array<string, mixed>  $overrides
 */
function fixtureRace(array $fixture, array $overrides = []): GameRaceRecord
{
    return GameRaceRecord::factory()->for(User::factory()->create())->create(array_merge([
        'track_slug' => $fixture['track'],
        'race_ms' => $fixture['race_ms'],
        'penalties' => $fixture['penalties'],
        'total_ms' => $fixture['total_ms'],
        'position' => $fixture['position'],
        'input_trace' => $fixture['trace'],
        'sim_version' => $fixture['sim_version'],
        'race_version' => $fixture['race_version'],
        'verify_status' => 'pending',
    ], $overrides));
}

$withoutNode = fn (): bool => trim((string) shell_exec('node --version 2>&1')) === '';

it('има retry прозорец над максималното време на валидатора', function () {
    expect(config('queue.connections.database.retry_after'))
        ->toBeGreaterThan((new ValidateGameRaceJob(1))->timeout);
});

it('потвърждава истинско състезание чрез преиграване на цялото поле в Node', function () {
    $record = fixtureRace($this->fixture, [
        // Клиентът праща временна позиция; окончателната идва от преиграването.
        'position' => 1,
    ]);

    // По-бавно състезание на същия потребител с дух — чисти се, щом новото
    // стане най-доброто с кадри.
    $older = GameRaceRecord::factory()->for($record->user)->create([
        'track_slug' => $this->fixture['track'],
        'total_ms' => $this->fixture['total_ms'] + 60000,
        'ghost_frames' => 'стари-кадри',
        'race_ticks' => 999,
    ]);

    (new ValidateGameRaceJob($record->id))->handle(new NodeReplayRunner);

    $record->refresh();

    expect($record->verify_status)->toBe('verified')
        ->and($record->verified_total_ms)->toBe($this->fixture['total_ms'])
        ->and($record->total_ms)->toBe($this->fixture['total_ms'])
        ->and($record->position)->toBe($this->fixture['final_position'])
        // Кадрите на духа от гасенето до флага — за задочните битки.
        ->and($record->ghost_frames)->not->toBeNull()
        ->and($record->race_ticks)->toBe($this->fixture['race_ticks'])
        ->and($older->refresh()->ghost_frames)->toBeNull();
})->skip($withoutNode, 'Node не е наличен в тази среда.');

it('отхвърля състезание с подправено по-бързо време', function () {
    $record = fixtureRace($this->fixture, [
        'race_ms' => $this->fixture['race_ms'] - 30000,
        'total_ms' => $this->fixture['total_ms'] - 30000,
    ]);

    (new ValidateGameRaceJob($record->id))->handle(new NodeReplayRunner);

    $record->refresh();

    // Преиграното време се пази за разследване, но записът е вън от класацията
    // и не оставя дух — фалшиво време не става съперник.
    expect($record->verify_status)->toBe('rejected')
        ->and($record->verified_total_ms)->toBe($this->fixture['total_ms'])
        ->and($record->ghost_frames)->toBeNull();
})->skip($withoutNode, 'Node не е наличен в тази среда.');

it('отхвърля трейс, записан срещу друга решетка', function () {
    $trace = json_decode($this->fixture['trace'], true, 512, JSON_THROW_ON_ERROR);
    $trace['opponents'] = 1;

    $record = fixtureRace($this->fixture, ['input_trace' => json_encode($trace, JSON_THROW_ON_ERROR)]);

    (new ValidateGameRaceJob($record->id))->handle(new NodeReplayRunner);

    expect($record->refresh()->verify_status)->toBe('rejected');
})->skip($withoutNode, 'Node не е наличен в тази среда.');

it('счупен трейс дава rejected, а не 500', function () {
    $record = fixtureRace($this->fixture, ['input_trace' => 'нещо счупено']);

    (new ValidateGameRaceJob($record->id))->handle(new NodeReplayRunner);

    expect($record->refresh()->verify_status)->toBe('rejected');
})->skip($withoutNode, 'Node не е наличен в тази среда.');

it('инфраструктурен провал дава error и състезанието остава в класацията', function () {
    config(['game.validator.node' => 'padok-no-such-node-binary']);
    $record = fixtureRace($this->fixture);

    (new ValidateGameRaceJob($record->id))->handle(new NodeReplayRunner);

    expect($record->refresh()->verify_status)->toBe('error')
        ->and(GameRaceRecord::query()->counted()->count())->toBe(1);
});

it('отхвърля чакащ job от стари правила без да стартира валидатора', function () {
    // Несъществуващият node доказва, че валидаторът изобщо не се пуска.
    config(['game.validator.node' => 'padok-no-such-node-binary']);
    $record = fixtureRace($this->fixture, ['race_version' => 0]);

    (new ValidateGameRaceJob($record->id))->handle(new NodeReplayRunner);

    expect($record->refresh()->verify_status)->toBe('rejected');
});
