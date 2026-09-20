<?php

declare(strict_types=1);

use App\Models\Prediction;
use App\Models\PredictionScore;
use App\Models\Race;
use App\Models\Season;
use App\Models\User;
use Inertia\Testing\AssertableInertia as Assert;

/*
 * Позицията в кръга захранва картичката за споделяне („3-и от 21"). Без нея
 * картичката е само сбор точки и не казва нищо на този, който я вижда.
 */

function scoredRace(): array
{
    $season = Season::factory()->create(['is_current' => true]);
    $race = Race::factory()->create(['season_id' => $season->id]);

    return [$race, $season];
}

function predictionWorth(Race $race, User $user, ?int $points): Prediction
{
    $prediction = Prediction::factory()->create([
        'race_id' => $race->id,
        'user_id' => $user->id,
    ]);

    if ($points !== null) {
        PredictionScore::factory()->create([
            'prediction_id' => $prediction->id,
            'points' => $points,
            'breakdown_json' => ['p1' => $points, 'p2' => 0, 'p3' => 0],
        ]);
    }

    return $prediction;
}

it('дава позицията и броя прогнозирали за кръга', function () {
    [$race] = scoredRace();

    $me = User::factory()->create();
    predictionWorth($race, $me, 12);
    predictionWorth($race, User::factory()->create(), 20);
    predictionWorth($race, User::factory()->create(), 5);

    $this->actingAs($me)
        ->get(route('races.show', $race->id))
        ->assertInertia(fn (Assert $page) => $page
            ->where('userRaceRank.rank', 2)
            ->where('userRaceRank.total', 3));
});

it('дава една и съща позиция при равни точки', function () {
    [$race] = scoredRace();

    $me = User::factory()->create();
    predictionWorth($race, $me, 12);
    predictionWorth($race, User::factory()->create(), 12);
    predictionWorth($race, User::factory()->create(), 20);

    $this->actingAs($me)
        ->get(route('races.show', $race->id))
        ->assertInertia(fn (Assert $page) => $page->where('userRaceRank.rank', 2));
});

it('мълчи преди кръгът да е точкуван', function () {
    [$race] = scoredRace();

    $me = User::factory()->create();
    predictionWorth($race, $me, null);

    $this->actingAs($me)
        ->get(route('races.show', $race->id))
        ->assertInertia(fn (Assert $page) => $page->where('userRaceRank', null));
});

it('мълчи за гост', function () {
    [$race] = scoredRace();
    predictionWorth($race, User::factory()->create(), 12);

    $this->get(route('races.show', $race->id))
        ->assertInertia(fn (Assert $page) => $page->where('userRaceRank', null));
});
