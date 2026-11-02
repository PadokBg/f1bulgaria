<?php

declare(strict_types=1);

use App\Models\Race;
use App\Models\Season;
use Inertia\Testing\AssertableInertia as Assert;

/*
 * Точковата схема стига до браузъра от конфига: от нея зависят блокът
 * „Как се точкува" и видът попадение в разбивката (точно/частично/мимо).
 * Преди стойностите не се подаваха никъде и частичните 5 т. бяха невидими —
 * посетител предложи „половин точки за пилот на подиума", без да знае, че
 * такива вече има.
 */

it('споделя точковата схема от конфига на класирането', function () {
    Season::factory()->create(['is_current' => true]);

    $this->get(route('leaderboard'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Leaderboard/Index')
            ->where('predictionScoring', config('predictions.scoring'))
        );
});

it('подава схемата и на страницата на кръга, до формата и разбивката', function () {
    $season = Season::factory()->create(['is_current' => true]);
    $race = Race::factory()->create(['season_id' => $season->id]);

    $this->get(route('races.show', $race->id))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Races/Show')
            ->where('predictionScoring', config('predictions.scoring'))
        );
});

it('следва конфига, ако схемата се пренастрои', function () {
    Season::factory()->create(['is_current' => true]);
    config(['predictions.scoring.podium_partial' => 7]);

    $this->get(route('leaderboard'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('predictionScoring.podium_partial', 7)
        );
});
