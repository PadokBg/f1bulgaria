<?php

declare(strict_types=1);

use App\Mail\RaceResultMail;
use App\Models\NewsletterSend;
use App\Models\Prediction;
use App\Models\PredictionScore;
use App\Models\Race;
use App\Models\Season;
use App\Models\User;
use Illuminate\Support\Facades\Mail;

/*
 * Писмото след кръга — другата половина на уикенда. Праща се САМО на подалите
 * прогноза: то е отговор на тяхно действие, не разпращане. Флагът е изключен,
 * докато политиката за поверителност не изброи и него.
 */

beforeEach(function () {
    Mail::fake();
    config(['features.race_result_mail' => true]);
});

function racePast(): Race
{
    $season = Season::factory()->create(['is_current' => true]);

    return Race::factory()->create([
        'season_id' => $season->id,
        'race_datetime_utc' => now()->subHours(4),
    ]);
}

function scoredPrediction(Race $race, User $user, int $points): Prediction
{
    $prediction = Prediction::factory()->create([
        'race_id' => $race->id,
        'user_id' => $user->id,
    ]);

    PredictionScore::factory()->create([
        'prediction_id' => $prediction->id,
        'points' => $points,
        'breakdown_json' => ['p1' => $points, 'p2' => 0, 'p3' => 0],
    ]);

    return $prediction;
}

it('не праща нищо при изключен флаг', function () {
    config(['features.race_result_mail' => false]);
    $race = racePast();
    scoredPrediction($race, User::factory()->create(), 10);

    $this->artisan('f1:race-result-mail')->assertSuccessful();

    Mail::assertNothingSent();
});

it('праща само на подалите прогноза', function () {
    $race = racePast();
    $predicted = User::factory()->create();
    $silent = User::factory()->create();

    scoredPrediction($race, $predicted, 10);

    $this->artisan('f1:race-result-mail')->assertSuccessful();

    Mail::assertSent(RaceResultMail::class, 1);
    Mail::assertSent(RaceResultMail::class, fn ($mail) => $mail->hasTo($predicted->email));
    Mail::assertNotSent(RaceResultMail::class, fn ($mail) => $mail->hasTo($silent->email));
});

it('носи точките и мястото в кръга', function () {
    $race = racePast();
    $winner = User::factory()->create();

    scoredPrediction($race, $winner, 25);
    scoredPrediction($race, User::factory()->create(), 10);
    scoredPrediction($race, User::factory()->create(), 4);

    $this->artisan('f1:race-result-mail')->assertSuccessful();

    Mail::assertSent(RaceResultMail::class, function ($mail) use ($winner) {
        return $mail->hasTo($winner->email)
            && $mail->points === 25
            && $mail->raceRank === ['rank' => 1, 'total' => 3];
    });
});

it('прескача спрелите имейлите и банатите', function () {
    $race = racePast();

    scoredPrediction($race, User::factory()->create(['email_opt_out_at' => now()]), 10);
    scoredPrediction($race, User::factory()->create(['banned_at' => now()]), 10);

    $this->artisan('f1:race-result-mail')->assertSuccessful();

    Mail::assertNothingSent();
});

it('не праща втори път за същия кръг', function () {
    $race = racePast();
    scoredPrediction($race, User::factory()->create(), 10);

    $this->artisan('f1:race-result-mail')->assertSuccessful();
    Mail::assertSent(RaceResultMail::class, 1);

    $this->artisan('f1:race-result-mail')->assertSuccessful();
    Mail::assertSent(RaceResultMail::class, 1);

    expect(NewsletterSend::where('mail_type', NewsletterSend::TYPE_RACE_RESULT)->count())->toBe(1);
});

it('мълчи за кръг без точкувани прогнози', function () {
    $race = racePast();
    Prediction::factory()->create(['race_id' => $race->id]);

    $this->artisan('f1:race-result-mail')->assertSuccessful();

    Mail::assertNothingSent();
});

it('dry-run не праща и работи при изключен флаг', function () {
    config(['features.race_result_mail' => false]);
    $race = racePast();
    scoredPrediction($race, User::factory()->create(), 10);

    $this->artisan('f1:race-result-mail', ['--dry-run' => true])->assertSuccessful();

    Mail::assertNothingSent();
    expect(NewsletterSend::where('mail_type', NewsletterSend::TYPE_RACE_RESULT)->count())->toBe(0);
});

it('политиката изброява и това писмо', function () {
    // Регресия: флагът не бива да се включва, преди текстът да го споменава.
    // Страницата е Inertia — текстът живее в props, не в сървърния HTML.
    $this->get('/poveritelnost')
        ->assertOk()
        ->assertInertia(function ($page) {
            $flat = json_encode($page->toArray()['props']['sections'] ?? [], JSON_UNESCAPED_UNICODE);

            expect($flat)->toContain('писмо след състезанието с точките от твоята прогноза');
        });
});
