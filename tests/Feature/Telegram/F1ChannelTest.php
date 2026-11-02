<?php

declare(strict_types=1);

use App\Enums\ChannelPostKind;
use App\Enums\ResultSessionType;
use App\Enums\SessionType;
use App\Models\ChannelPost;
use App\Models\Constructor;
use App\Models\Driver;
use App\Models\Race;
use App\Models\RaceSession;
use App\Models\Result;
use App\Models\Season;
use App\Models\SessionResult;
use App\Services\Telegram\F1ChannelEnqueuer;

beforeEach(function () {
    config()->set('channel.enabled', true);
    config()->set('channel.max_backfill_hours', 24);
});

function f1Race(): Race
{
    $season = Season::factory()->create(['year' => 2026, 'is_current' => true]);

    return Race::factory()->create([
        'season_id' => $season->id,
        'jolpica_id' => 'hungaroring',
        'name' => 'Hungarian Grand Prix',
        'round' => 9,
        'qualifying_datetime_utc' => now()->subHours(20),
        'sprint_datetime_utc' => null,
        'race_datetime_utc' => now()->subHours(3),
        'has_sprint' => false,
    ]);
}

function f1Driver(Race $race, string $first, string $last, string $slug, string $team = 'Ferrari'): Driver
{
    $constructor = Constructor::factory()->create([
        'season_id' => $race->season_id,
        'name' => $team,
        'slug' => Str::slug($team),
    ]);

    return Driver::factory()->create([
        'season_id' => $race->season_id,
        'constructor_id' => $constructor->id,
        'first_name' => $first,
        'last_name' => $last,
        'slug' => $slug,
    ]);
}

it('поставя квалификацията в опашката от session_results', function () {
    $race = f1Race();
    $driver = f1Driver($race, 'Lewis', 'Hamilton', 'lewis-hamilton');

    SessionResult::query()->create([
        'race_id' => $race->id,
        'session_type' => SessionType::Qualifying->value,
        'driver_id' => $driver->id,
        'position' => 1,
        'q3' => '1:15.096',
    ]);

    expect(app(F1ChannelEnqueuer::class)->enqueuePending()['queued'])->toBe(1);

    $post = ChannelPost::query()->first();

    expect($post->kind)->toBe(ChannelPostKind::F1Qualifying)
        // Име на Гран при-то и на пилота — и двете на български.
        ->and($post->body)->toContain('Гран при на Унгария · кръг 9')
        ->and($post->body)->toContain('Люис Хамилтън')
        ->and($post->body)->toContain('1:15.096');
});

it('публикува временната класация от бързия източник, отбелязана като такава', function () {
    $race = f1Race();
    $driver = f1Driver($race, 'Max', 'Verstappen', 'max-verstappen', 'Red Bull');

    // Само бързият източник. Официалният (Jolpica) още не е публикувал.
    SessionResult::query()->create([
        'race_id' => $race->id,
        'session_type' => SessionType::Race->value,
        'driver_id' => $driver->id,
        'position' => 1,
        'gap' => null,
        'source' => 'openf1',
    ]);

    expect(app(F1ChannelEnqueuer::class)->enqueuePending()['queued'])->toBe(1);

    $post = ChannelPost::query()->where('kind', ChannelPostKind::F1Race->value)->first();

    expect($post->body)->toContain('Макс Верстапен')
        ->and($post->body)->toContain('Временна класация')
        // Лицензът на бързия източник изисква посочване.
        ->and($post->body)->toContain('OpenF1');
});

it('пренаписва поста, щом официалните резултати с точките пристигнат', function () {
    $race = f1Race();
    $driver = f1Driver($race, 'Max', 'Verstappen', 'max-verstappen', 'Red Bull');

    SessionResult::query()->create([
        'race_id' => $race->id,
        'session_type' => SessionType::Race->value,
        'driver_id' => $driver->id,
        'position' => 1,
        'source' => 'openf1',
    ]);

    app(F1ChannelEnqueuer::class)->enqueuePending();

    // Jolpica пристига с часове закъснение — и носи точките.
    Result::factory()->create([
        'race_id' => $race->id, 'driver_id' => $driver->id,
        'session_type' => ResultSessionType::Race->value,
        'position' => 1, 'points' => 25, 'dnf' => false,
    ]);

    $stats = app(F1ChannelEnqueuer::class)->enqueuePending();

    // Не нов пост, а обновяване на същия — иначе каналът получава две
    // съобщения за едно състезание.
    expect($stats['queued'])->toBe(0)
        ->and($stats['updated'])->toBe(1)
        ->and(ChannelPost::query()->where('kind', ChannelPostKind::F1Race->value)->count())->toBe(1);

    $post = ChannelPost::query()->where('kind', ChannelPostKind::F1Race->value)->first();

    expect($post->body)->toContain('25 т.')
        ->and($post->body)->not->toContain('Временна класация');
});

it('подрежда квалификацията преди състезанието', function () {
    $race = f1Race();
    $driver = f1Driver($race, 'Charles', 'Leclerc', 'charles-leclerc');

    SessionResult::query()->create([
        'race_id' => $race->id,
        'session_type' => SessionType::Qualifying->value,
        'driver_id' => $driver->id,
        'position' => 1,
        'q3' => '1:15.096',
    ]);

    Result::factory()->create([
        'race_id' => $race->id,
        'driver_id' => $driver->id,
        'session_type' => ResultSessionType::Race->value,
        'position' => 1,
        'points' => 25,
        'dnf' => false,
    ]);

    app(F1ChannelEnqueuer::class)->enqueuePending();

    expect(ChannelPost::query()->ready()->pluck('kind')->map(fn ($k) => $k->value)->all())
        ->toBe(['f1_qualifying', 'f1_race']);
});

it('отбелязва най-бързата обиколка и отпадналите', function () {
    $race = f1Race();
    $winner = f1Driver($race, 'Max', 'Verstappen', 'max-verstappen', 'Red Bull');
    $retired = f1Driver($race, 'Lewis', 'Hamilton', 'lewis-hamilton', 'Ferrari');

    Result::factory()->create([
        'race_id' => $race->id, 'driver_id' => $winner->id,
        'session_type' => ResultSessionType::Race->value,
        'position' => 1, 'points' => 25, 'dnf' => false, 'fastest_lap' => true,
    ]);

    Result::factory()->create([
        'race_id' => $race->id, 'driver_id' => $retired->id,
        'session_type' => ResultSessionType::Race->value,
        'position' => null, 'points' => 0, 'dnf' => true, 'fastest_lap' => false,
    ]);

    app(F1ChannelEnqueuer::class)->enqueuePending();
    $body = ChannelPost::query()->where('kind', ChannelPostKind::F1Race->value)->first()->body;

    expect($body)->toContain('🥇')
        ->and($body)->toContain('Макс Верстапен')
        ->and($body)->toContain('25 т.')
        ->and($body)->toContain('🟣')
        ->and($body)->toContain('Отпаднали: Люис Хамилтън');
});

it('показва в поста за тренировка и новака извън ростъра', function () {
    $race = f1Race();
    $lindblad = f1Driver($race, 'Arvid', 'Lindblad', 'arvid-lindblad', 'RB F1 Team');

    // Тренировките нямат резервно време в `races` — тръгват по разписанието.
    RaceSession::query()->create([
        'race_id' => $race->id,
        'type' => SessionType::FP1->value,
        'scheduled_at_utc' => now()->subHours(10),
    ]);

    SessionResult::query()->create([
        'race_id' => $race->id,
        'session_type' => SessionType::FP1->value,
        'driver_id' => $lindblad->id,
        'driver_number' => 41,
        'position' => 10,
        'best_time' => '1:19.478',
        'source' => 'openf1',
    ]);

    SessionResult::query()->create([
        'race_id' => $race->id,
        'session_type' => SessionType::FP1->value,
        'driver_id' => null,
        'driver_number' => 91,
        'driver_name' => 'Nikola Tsolov',
        'team_name' => 'RB F1 Team',
        'position' => 12,
        'best_time' => '1:19.604',
        'gap' => '+1.476',
        'source' => 'openf1',
    ]);

    app(F1ChannelEnqueuer::class)->enqueuePending();

    $body = ChannelPost::query()->where('kind', ChannelPostKind::F1Fp1->value)->sole()->body;

    expect($body)->toContain('<b>Никола Цолов</b> · RB F1 Team · 1:19.604 · +1.476')
        ->and($body)->toContain('<b>Арвид Линдблад</b> · RB F1 Team')
        // Вече е в показаните редове — не се дописва втори път.
        ->and($body)->not->toContain('🇧🇬');
});

it('дописва Цолов под първите десет, когато е извън тях', function () {
    $race = f1Race();

    RaceSession::query()->create([
        'race_id' => $race->id,
        'type' => SessionType::FP1->value,
        'scheduled_at_utc' => now()->subHours(10),
    ]);

    foreach (range(1, 11) as $position) {
        $driver = f1Driver($race, "Driver{$position}", 'Test', "driver{$position}-test", "Team {$position}");

        SessionResult::query()->create([
            'race_id' => $race->id,
            'session_type' => SessionType::FP1->value,
            'driver_id' => $driver->id,
            'position' => $position,
            'source' => 'openf1',
        ]);
    }

    // Мексико 2026: новак извън ростъра, 12-и — постът показва само първите десет.
    SessionResult::query()->create([
        'race_id' => $race->id,
        'session_type' => SessionType::FP1->value,
        'driver_id' => null,
        'driver_number' => 91,
        'driver_name' => 'Nikola Tsolov',
        'team_name' => 'RB F1 Team',
        'position' => 12,
        'best_time' => '1:19.604',
        'source' => 'openf1',
    ]);

    app(F1ChannelEnqueuer::class)->enqueuePending();

    $body = ChannelPost::query()->where('kind', ChannelPostKind::F1Fp1->value)->sole()->body;

    expect($body)->toContain('🇧🇬 <b>Никола Цолов</b> — 12-и')
        ->and($body)->not->toContain('12. <b>Никола Цолов</b>')
        ->and($body)->not->toContain('Driver11');
});

it('не наваксва състезания извън прозореца', function () {
    $race = f1Race();
    $race->update([
        'qualifying_datetime_utc' => now()->subDays(5),
        'race_datetime_utc' => now()->subDays(5),
    ]);

    $driver = f1Driver($race, 'Max', 'Verstappen', 'max-verstappen');

    Result::factory()->create([
        'race_id' => $race->id, 'driver_id' => $driver->id,
        'session_type' => ResultSessionType::Race->value,
        'position' => 1, 'points' => 25, 'dnf' => false,
    ]);

    expect(app(F1ChannelEnqueuer::class)->enqueuePending()['queued'])->toBe(0);
});

it('не поставя сесия без резултати', function () {
    f1Race();

    expect(app(F1ChannelEnqueuer::class)->enqueuePending()['queued'])->toBe(0);
});
