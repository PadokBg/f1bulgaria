<?php

declare(strict_types=1);

use App\Mail\RaceResultMail;
use App\Models\Race;

/*
 * Разбивката в писмото след кръга различава точно от частично попадение.
 * Преди всяко ненулево поле излизаше със „✓" под „Какво позна" — пилот,
 * посочен за победител и завършил втори (+5), изглеждаше като познат
 * победител. Стойностите идват от конфига, не от числа в теста.
 */

function raceResultMailWith(array $breakdown): RaceResultMail
{
    return new RaceResultMail(
        race: Race::factory()->create(),
        points: array_sum($breakdown),
        breakdown: $breakdown,
        raceRank: ['rank' => 1, 'total' => 3],
        seasonRank: null,
        userUnsubscribeUrl: 'https://padok.bg/unsubscribe',
    );
}

it('показва пилот от подиума на друго място като частично попадение', function () {
    $scoring = config('predictions.scoring');

    raceResultMailWith([
        'p1' => $scoring['podium_partial'],
        'p2' => $scoring['exact']['p2'],
        'p3' => 0,
    ])
        ->assertSeeInHtml('≈ Победител — на подиума, но на друго място', false)
        ->assertSeeInHtml('✓ Второ място', false)
        ->assertSeeInHtml('✗ Трето място', false)
        ->assertDontSeeInHtml('✓ Победител', false);
});

it('различава точния брой отпаднали от разлика с един', function () {
    $scoring = config('predictions.scoring');

    raceResultMailWith(['dnf' => $scoring['dnf_close']])
        ->assertSeeInHtml('≈ Брой отпаднали — с разлика от един', false);

    raceResultMailWith(['dnf' => $scoring['dnf_exact']])
        ->assertSeeInHtml('✓ Брой отпаднали', false)
        ->assertDontSeeInHtml('с разлика от един', false);
});

it('не бърка бонус, равен на частичните точки, с частично попадение', function () {
    // Най-бързата обиколка носи колкото частичният подиум (5 т. днес) —
    // видът се решава по категорията, не само по числото.
    config(['predictions.scoring.fastest_lap' => config('predictions.scoring.podium_partial')]);

    raceResultMailWith(['fastest_lap' => config('predictions.scoring.fastest_lap')])
        ->assertSeeInHtml('✓ Най-бърза обиколка', false)
        ->assertDontSeeInHtml('на подиума, но на друго място', false);
});

it('не озаглавява таблицата „Какво позна"', function () {
    // „Какво позна" над „≈ Победител +5" пак щеше да внушава познат победител.
    raceResultMailWith(['p1' => 0])
        ->assertSeeInHtml('Категория', false)
        ->assertDontSeeInHtml('Какво позна', false);
});
