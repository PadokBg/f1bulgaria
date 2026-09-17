<?php

declare(strict_types=1);

use App\Mcp\Servers\OpsReadServer;
use App\Mcp\Tools\LeagueStandingsTool;
use App\Mcp\Tools\QueueHealthTool;
use App\Mcp\Tools\RacePredictionsTool;
use App\Mcp\Tools\RecentUsersTool;
use App\Mcp\Tools\SiteOverviewTool;
use App\Models\AuthEvent;
use App\Models\Driver;
use App\Models\Prediction;
use App\Models\PredictionScore;
use App\Models\Race;
use App\Models\Result;
use App\Models\Season;
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Testing\Fluent\AssertableJson;

/*
 * Инструментите на read-only сървъра, извикани директно през тестовия API на
 * laravel/mcp (без HTTP слоя — той е в OpsReadServerAccessTest).
 */

beforeEach(function () {
    $this->travelTo(CarbonImmutable::parse('2026-09-17 12:00:00', 'Europe/Sofia'));
    $this->admin = User::factory()->create(['is_admin' => true]);
});

/** Чакаща задача, готова за изпълнение преди $minutesAgo минути. */
function opsQueueJob(int $minutesAgo): void
{
    $availableAt = now()->subMinutes($minutesAgo)->getTimestamp();

    DB::table('jobs')->insert([
        'queue' => 'default',
        'payload' => '{}',
        'attempts' => 0,
        'reserved_at' => null,
        'available_at' => $availableAt,
        'created_at' => $availableAt,
    ]);
}

it('site-overview брои потребители, прогнози и следващия кръг', function () {
    $season = Season::factory()->current()->create(['year' => 2026]);
    // Админът от beforeEach е регистриран „сега“ и също влиза в 7-дневния прозорец.
    $fresh = User::factory()->count(3)->create(['created_at' => now()->subDays(2)]);
    $old = User::factory()->create(['created_at' => now()->subDays(40)]);
    AuthEvent::forceCreate(['user_id' => $old->id, 'type' => AuthEvent::TYPE_LOGIN, 'created_at' => now()->subDay()]);

    $race = Race::factory()->create([
        'season_id' => $season->id,
        'round' => 17,
        'name' => 'Azerbaijan Grand Prix',
        'race_datetime_utc' => now()->addDays(3),
        'qualifying_datetime_utc' => now()->addDays(2),
    ]);
    Prediction::factory()->create(['race_id' => $race->id, 'user_id' => $fresh[0]->id]);
    Prediction::factory()->create(['race_id' => $race->id, 'user_id' => $old->id]);

    OpsReadServer::actingAs($this->admin)
        ->tool(SiteOverviewTool::class)
        ->assertOk()
        ->assertStructuredContent(function (AssertableJson $json): void {
            $json->where('users.total', 5)
                ->where('users.registered_last_7_days', 4)
                ->where('users.admins', 1)
                ->where('users.logged_in_last_7_days', 1)
                ->where('predictions.total', 2)
                ->where('predictions.current_season', 2)
                ->where('season.year', 2026)
                ->where('next_race.id', fn ($id) => (int) $id > 0)
                ->where('next_race.round', 17)
                ->where('next_race.predictions_open', true)
                ->where('next_race.predictions_count', 2)
                ->etc();
        });
});

it('site-overview работи и без текущ сезон и без състезания', function () {
    OpsReadServer::actingAs($this->admin)
        ->tool(SiteOverviewTool::class)
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('season', null)
            ->where('next_race', null)
            ->etc());
});

it('recent-users връща най-новите с брой прогнози и последно влизане', function () {
    $this->admin->forceFill(['created_at' => now()->subDays(30)])->save();
    $older = User::factory()->create(['name' => 'Стар Фен', 'created_at' => now()->subDays(10)]);
    $newer = User::factory()->create(['name' => 'Нов Фен', 'created_at' => now()->subHour()]);
    Prediction::factory()->count(2)->create(['user_id' => $newer->id]);
    AuthEvent::forceCreate(['user_id' => $newer->id, 'type' => AuthEvent::TYPE_LOGIN, 'created_at' => now()->subMinutes(30)]);
    AuthEvent::forceCreate(['user_id' => $newer->id, 'type' => AuthEvent::TYPE_LOGIN, 'created_at' => now()->subMinutes(5)]);

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentUsersTool::class, ['limit' => 2])
        ->assertOk()
        ->assertStructuredContent(function (AssertableJson $json) use ($newer, $older): void {
            $json->where('count', 2)
                ->where('users.0.id', $newer->id)
                ->where('users.0.predictions_count', 2)
                ->where('users.0.last_login_at', '2026-09-17 11:55 Sofia')
                ->where('users.0.is_admin', false)
                ->where('users.1.id', $older->id)
                ->where('users.1.predictions_count', 0)
                ->where('users.1.last_login_at', null)
                ->etc();
        });
});

it('recent-users филтрира по дни и отхвърля грешен limit', function () {
    $this->admin->forceFill(['created_at' => now()->subDays(30)])->save();
    User::factory()->create(['created_at' => now()->subDays(10)]);
    User::factory()->create(['created_at' => now()->subDay()]);

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentUsersTool::class, ['days' => 3])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json->where('count', 1)->etc());

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentUsersTool::class, ['limit' => 999])
        ->assertHasErrors();
});

it('queue-health обявява спрял worker по възрастта на най-старата готова задача', function () {
    config(['queue.default' => 'database']);
    opsQueueJob(minutesAgo: 60);

    OpsReadServer::actingAs($this->admin)
        ->tool(QueueHealthTool::class)
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('pending', 1)
            ->where('oldest_ready_minutes', 60)
            ->where('stale', true)
            ->where('failed_last_24h', 0)
            ->where('verdict', fn (string $verdict) => str_starts_with($verdict, 'ПРОБЛЕМ'))
            ->etc());
});

it('queue-health показва последните провалени задачи с класа и грешката', function () {
    config(['queue.default' => 'database']);

    DB::table('failed_jobs')->insert([
        'uuid' => 'f2c1a2b3-0000-4000-8000-000000000001',
        'connection' => 'database',
        'queue' => 'default',
        'payload' => json_encode(['displayName' => 'App\\Jobs\\ValidateGameLapJob']),
        'exception' => "RuntimeException: Node replay failed\n#0 /var/www/...",
        'failed_at' => now()->subHours(2),
    ]);

    OpsReadServer::actingAs($this->admin)
        ->tool(QueueHealthTool::class)
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('pending', 0)
            ->where('stale', false)
            ->where('failed_last_24h', 1)
            ->where('failed_total', 1)
            ->where('recent_failures.0.job', 'App\\Jobs\\ValidateGameLapJob')
            ->where('recent_failures.0.error', 'RuntimeException: Node replay failed')
            ->where('recent_failures.0.failed_at', '2026-09-17 10:00')
            ->etc());
});

it('queue-health не брои от базата при друг драйвер', function () {
    config(['queue.default' => 'sync']);

    OpsReadServer::actingAs($this->admin)
        ->tool(QueueHealthTool::class)
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json->where('driver', 'sync')->has('verdict')->etc());
});

it('race-predictions показва прогнозите за отворения кръг с точки след оценяване', function () {
    $season = Season::factory()->current()->create(['year' => 2026]);
    $verstappen = Driver::factory()->create(['first_name' => 'Max', 'last_name' => 'Verstappen', 'driver_code' => 'VER', 'season_id' => $season->id]);

    $past = Race::factory()->past()->create(['season_id' => $season->id, 'round' => 15]);
    $open = Race::factory()->create([
        'season_id' => $season->id,
        'round' => 16,
        'race_datetime_utc' => now()->addDays(3),
        'qualifying_datetime_utc' => now()->addDays(2),
    ]);

    $fan = User::factory()->create(['name' => 'Фен Едно']);
    $prediction = Prediction::factory()->create([
        'user_id' => $fan->id,
        'race_id' => $open->id,
        'p1_driver_id' => $verstappen->id,
        'dnf_count' => 3,
        'safety_car' => true,
    ]);
    PredictionScore::factory()->create(['prediction_id' => $prediction->id, 'points' => 25]);
    Prediction::factory()->create(['race_id' => $past->id]);

    OpsReadServer::actingAs($this->admin)
        ->tool(RacePredictionsTool::class)
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('race.id', $open->id)
            ->where('race.round', 16)
            ->where('race.predictions_locked', false)
            ->where('race.has_race_results', false)
            ->where('counts.predictions', 1)
            ->where('counts.scored', 1)
            ->where('predictions.0.user', 'Фен Едно')
            ->where('predictions.0.p1', 'Max Verstappen (VER)')
            ->where('predictions.0.dnf_count', 3)
            ->where('predictions.0.safety_car', true)
            ->where('predictions.0.points', 25)
            ->etc());
});

it('race-predictions без отворен кръг взима последния изминал и приема race_id', function () {
    $past = Race::factory()->past()->create();
    Result::factory()->create(['race_id' => $past->id, 'session_type' => 'race']);
    $older = Race::factory()->create([
        'race_datetime_utc' => now()->subMonths(2),
        'qualifying_datetime_utc' => now()->subMonths(2)->subDay(),
    ]);

    OpsReadServer::actingAs($this->admin)
        ->tool(RacePredictionsTool::class)
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('race.id', $past->id)
            ->where('race.has_race_results', true)
            ->etc());

    OpsReadServer::actingAs($this->admin)
        ->tool(RacePredictionsTool::class, ['race_id' => $older->id])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json->where('race.id', $older->id)->etc());

    OpsReadServer::actingAs($this->admin)
        ->tool(RacePredictionsTool::class, ['race_id' => 999999])
        ->assertHasErrors(['Няма състезание с id 999999.']);
});

it('league-standings подрежда по точки за текущия сезон', function () {
    $season = Season::factory()->current()->create(['year' => 2026]);
    $race = Race::factory()->create(['season_id' => $season->id]);

    $leader = User::factory()->create(['name' => 'Лидер']);
    $runnerUp = User::factory()->create(['name' => 'Втори']);

    PredictionScore::factory()->create([
        'prediction_id' => Prediction::factory()->create(['user_id' => $leader->id, 'race_id' => $race->id])->id,
        'points' => 40,
    ]);
    PredictionScore::factory()->create([
        'prediction_id' => Prediction::factory()->create(['user_id' => $runnerUp->id, 'race_id' => $race->id])->id,
        'points' => 12,
    ]);

    OpsReadServer::actingAs($this->admin)
        ->tool(LeagueStandingsTool::class, ['limit' => 1])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('season', 2026)
            ->where('participants', 2)
            ->count('standings', 1)
            ->where('standings.0.name', 'Лидер')
            ->where('standings.0.points', 40)
            ->etc());

    OpsReadServer::actingAs($this->admin)
        ->tool(LeagueStandingsTool::class, ['year' => 1999])
        ->assertHasErrors(['Няма сезон 1999 в базата.']);
});

it('league-standings обяснява липсата на текущ сезон', function () {
    OpsReadServer::actingAs($this->admin)
        ->tool(LeagueStandingsTool::class)
        ->assertHasErrors();
});
