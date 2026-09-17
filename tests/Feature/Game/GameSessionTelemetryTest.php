<?php

declare(strict_types=1);

use App\Models\GameSession;
use App\Models\User;
use Illuminate\Support\Str;

beforeEach(function () {
    config(['features.game' => true]);
});

function drivingEvent(int $sequence, string $type, array $data = [], ?int $activeMs = null): array
{
    return ['sequence' => $sequence, 'type' => $type, 'active_ms' => $activeMs ?? $sequence * 1000, 'data' => $data];
}

it('starts an identified attempt once and preserves its initial context on retry', function () {
    $payload = [
        'client_id' => (string) Str::uuid(), 'track' => 'monza', 'device' => 'mobile', 'mode' => 'race',
        'context' => ['controls' => 'buttons', 'graphics' => 'auto', 'transmission' => 'auto', 'browser' => 'safari', 'os' => 'ios', 'viewport_width' => 844, 'viewport_height' => 390, 'pixel_ratio' => 3, 'sim_version' => 3],
    ];
    $response = $this->actingAs(User::factory()->create())->postJson(route('game.session.store'), $payload)->assertCreated();
    $id = $response->json('id');
    $this->postJson(route('game.session.store'), [...$payload, 'track' => 'spa'])->assertCreated()->assertJsonPath('id', $id);
    expect(GameSession::query()->count())->toBe(1)->and(GameSession::find($id)->track_slug)->toBe('monza')
        ->and(GameSession::find($id)->context['controls'])->toBe('buttons');
});

it('accepts the real mobile telemetry snapshot', function () {
    $session = GameSession::factory()->tracked()->mobile()->create();
    $snapshot = ['phase' => 'flying', 'sector' => 2, 'progress' => 0.4, 'speed' => 118, 'max_speed' => 203, 'frame_ms' => 33.4, 'render_scale' => 0.8, 'quality_tier' => 'low-power', 'lap_valid' => false, 'warnings' => 1, 'lap_number' => 0];
    $this->actingAs($session->user)->postJson(route('game.session.events', $session), ['events' => [drivingEvent(1, 'sector', $snapshot)]])->assertNoContent();
    expect($session->fresh()->max_progress)->toBe(0.4)->and($session->fresh()->max_speed)->toBe(203.0)->and($session->fresh()->last_sector)->toBe(2);
});

it('counts invalid solo finishes separately from leaderboard records and deduplicates retries', function () {
    $session = GameSession::factory()->tracked()->create();
    $payload = ['events' => [drivingEvent(1, 'started'), drivingEvent(2, 'lap_invalidated'), drivingEvent(3, 'lap_completed', ['lap_ms' => 150000, 'lap_valid' => false, 'lap_number' => 1])]];
    $this->actingAs($session->user)->postJson(route('game.session.events', $session), $payload)->assertNoContent();
    $this->postJson(route('game.session.events', $session), $payload)->assertNoContent();
    expect($session->fresh()->status)->toBe('completed')->and($session->fresh()->lap_count)->toBe(1)
        ->and($session->fresh()->invalid_lap_count)->toBe(1)->and($session->fresh()->valid_lap_count)->toBe(0)
        ->and($session->events()->count())->toBe(3)->and($session->user->gameLapRecords()->count())->toBe(0);
});

it('counts race laps but completes a race only on its own finish event', function () {
    $session = GameSession::factory()->tracked()->race()->create();
    // Първата обиколка на състезанието е бойна — без време, но е обиколка 1/3.
    $this->actingAs($session->user)->postJson(route('game.session.events', $session), ['events' => [drivingEvent(1, 'lap_completed', ['lap_ms' => null, 'lap_valid' => true, 'lap_number' => 1])]])->assertNoContent();
    expect($session->fresh()->status)->toBe('active');
    $this->postJson(route('game.session.events', $session), ['events' => [
        drivingEvent(2, 'lap_completed', ['lap_ms' => 140000, 'lap_valid' => false, 'lap_number' => 2]),
        drivingEvent(3, 'lap_completed', ['lap_ms' => 119000, 'lap_valid' => true, 'lap_number' => 3]),
        drivingEvent(4, 'race_completed', ['race_position' => 4]),
    ]])->assertNoContent();
    expect($session->fresh()->status)->toBe('completed')->and($session->fresh()->lap_count)->toBe(3)
        ->and($session->fresh()->valid_lap_count)->toBe(2)->and($session->fresh()->invalid_lap_count)->toBe(1);
});

it('още изисква ключа lap_ms за завършена обиколка, дори да е null', function () {
    $session = GameSession::factory()->tracked()->race()->create();
    $this->actingAs($session->user)
        ->postJson(route('game.session.events', $session), ['events' => [drivingEvent(1, 'lap_completed', ['lap_valid' => true, 'lap_number' => 1])]])
        ->assertUnprocessable()
        ->assertJsonValidationErrors('events.0.data.lap_ms');
});

it('пази числата като числа и отхвърля километрични десетични низове', function () {
    $session = GameSession::factory()->tracked()->create();
    $this->actingAs($session->user)
        ->postJson(route('game.session.events', $session), ['events' => [drivingEvent(1, 'heartbeat', ['progress' => '0.25', 'speed' => '118.5', 'frame_ms' => 16.7])]])
        ->assertNoContent();

    $data = $session->events()->sole()->data;
    expect($data['progress'])->toBe(0.25)->and($data['speed'])->toBe(118.5)->and($data['frame_ms'])->toBe(16.7);

    $this->postJson(route('game.session.events', $session), ['events' => [drivingEvent(2, 'heartbeat', ['progress' => '0.'.str_repeat('0', 5000).'1'])]])
        ->assertUnprocessable()
        ->assertJsonValidationErrors('events.0.data.progress');
});

it('спира да брои обиколки над тавана на клиента', function () {
    $session = GameSession::factory()->tracked()->race()->create(['lap_count' => 100, 'valid_lap_count' => 100]);
    $this->actingAs($session->user)
        ->postJson(route('game.session.events', $session), ['events' => [drivingEvent(1, 'lap_completed', ['lap_ms' => 90000, 'lap_valid' => true, 'lap_number' => 100])]])
        ->assertNoContent();
    expect($session->fresh()->lap_count)->toBe(100)->and($session->fresh()->valid_lap_count)->toBe(100);
});

it('блокиран играч не може да отчита карания', function () {
    $user = User::factory()->create(['banned_at' => now()]);
    $this->actingAs($user)
        ->postJson(route('game.session.store'), ['track' => 'monza', 'device' => 'desktop', 'mode' => 'solo'])
        ->assertForbidden();

    $session = GameSession::factory()->tracked()->for($user)->create();
    $this->postJson(route('game.session.events', $session), ['events' => [drivingEvent(1, 'started')]])->assertForbidden();
    expect($session->events()->count())->toBe(0);
});

it('preserves a late finish when exit arrived first and never reopens completed attempts', function () {
    $session = GameSession::factory()->tracked()->create();
    $url = route('game.session.events', $session);
    $this->actingAs($session->user)->postJson($url, ['events' => [drivingEvent(5, 'page_left', ['sector' => 3], 200000)]])->assertNoContent();
    expect($session->fresh()->status)->toBe('interrupted');
    $this->postJson($url, ['events' => [drivingEvent(1, 'started', ['sector' => 1]), drivingEvent(3, 'lap_completed', ['lap_ms' => 150000, 'lap_valid' => true, 'lap_number' => 1], 180000)]])->assertNoContent();
    expect($session->fresh()->status)->toBe('completed')->and($session->fresh()->last_sector)->toBe(3)->and($session->fresh()->active_ms)->toBe(200000);
    $this->postJson($url, ['events' => [drivingEvent(6, 'resumed', [], 200000), drivingEvent(7, 'lap_save_failed', ['error_code' => 'request_failed'], 200000)]])->assertNoContent();
    expect($session->fresh()->status)->toBe('completed')->and($session->fresh()->lap_count)->toBe(1);
});

it('distinguishes pause, resume and explicit quit with cumulative active duration', function () {
    $session = GameSession::factory()->tracked()->create();
    $url = route('game.session.events', $session);
    $this->actingAs($session->user)->postJson($url, ['events' => [drivingEvent(1, 'page_hidden', [], 12000)]])->assertNoContent();
    expect($session->fresh()->status)->toBe('paused')->and($session->fresh()->ended_at)->toBeNull();
    $this->postJson($url, ['events' => [drivingEvent(2, 'resumed', [], 12000), drivingEvent(3, 'quit', [], 15000)]])->assertNoContent();
    expect($session->fresh()->status)->toBe('quit')->and($session->fresh()->active_ms)->toBe(15000)->and($session->fresh()->ended_at)->not->toBeNull();
});

it('rejects guests, other users and disabled-game access', function () {
    $session = GameSession::factory()->tracked()->create();
    $payload = ['events' => [drivingEvent(1, 'started')]];
    $url = route('game.session.events', $session);
    $this->postJson($url, $payload)->assertUnauthorized();
    $this->actingAs(User::factory()->create())->postJson($url, $payload)->assertNotFound();
    config(['features.game' => false]);
    $this->actingAs($session->user)->postJson($url, $payload)->assertNotFound();
    expect($session->events()->count())->toBe(0);
});

it('does not invent history for legacy starts', function () {
    $session = GameSession::factory()->create();
    $this->actingAs($session->user)->postJson(route('game.session.events', $session), ['events' => [drivingEvent(1, 'started')]])->assertConflict();
    expect($session->fresh()->status)->toBe('legacy')->and($session->fresh()->last_seen_at)->toBeNull()->and($session->events()->count())->toBe(0);
});

it('rejects malformed or incomplete batches atomically', function (array $events) {
    $session = GameSession::factory()->tracked()->create();
    $this->actingAs($session->user)->postJson(route('game.session.events', $session), ['events' => $events])->assertUnprocessable();
    expect($session->events()->count())->toBe(0);
})->with([
    'missing lap details' => [[drivingEvent(1, 'lap_completed')]],
    'unknown type' => [[drivingEvent(1, 'made_up')]],
    'raw stack' => [[drivingEvent(1, 'error', ['stack' => 'private data'])]],
    'duplicate sequence' => [[drivingEvent(1, 'started'), drivingEvent(1, 'quit')]],
    'oversize sequence' => [[drivingEvent(4097, 'heartbeat')]],
    'solo race finish' => [[drivingEvent(1, 'race_completed')]],
    'unexpected key' => [[drivingEvent(1, 'started') + ['extra' => true]]],
]);

it('records a graphics failure as a failed attempt with its reason', function (string $code) {
    // Двата известни случая на празно платно с жив HUD: отнет контекст (Brave
    // 1.93, brave-browser#57902) и несвързан шейдър (Pixel 10 / Android 17).
    // В статистиката трябва да се вижда защо карането е свършило.
    $session = GameSession::factory()->tracked()->create();
    $url = route('game.session.events', $session);

    $this->actingAs($session->user)
        ->postJson($url, ['events' => [
            drivingEvent(1, 'started'),
            drivingEvent(2, 'error', ['error_code' => $code], 9000),
        ]])
        ->assertNoContent();

    expect($session->fresh()->status)->toBe('error')
        ->and($session->fresh()->ended_at)->not->toBeNull()
        ->and($session->events()->where('type', 'error')->value('data'))->toBe(['error_code' => $code]);
})->with(['webgl_context_lost', 'shader_failed']);
