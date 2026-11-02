<?php

declare(strict_types=1);

use Inertia\Testing\AssertableInertia as Assert;

it('страницата на Цолов връща 200 и рендира профила', function () {
    $this->get('/tsolov')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Tsolov')
            ->where('profile.name', 'Никола Цолов')
            ->has('profile.bio_bg')
            ->has('profile.milestones'));
});

it('профилът съдържа рождена дата, серия, титли и разширена биография', function () {
    // Официален FIA F2 профил: роден 21.12.2006 (не 2007!).
    expect(config('tsolov.birth_date'))->toBe('2006-12-21')
        ->and(config('tsolov.nationality'))->toBe('Българин')
        ->and(config('tsolov.milestones'))->toBeArray()
        ->and(count(config('tsolov.milestones')))->toBeGreaterThan(0)
        ->and(config('tsolov.titles'))->toBeArray()
        ->and(count(config('tsolov.titles')))->toBeGreaterThanOrEqual(2)
        // Разширена биография (брой думи; str_word_count не брои кирилица).
        ->and(count(preg_split('/\s+/', trim(implode(' ', config('tsolov.bio_bg'))))))->toBeGreaterThan(150);
});

it('не съдържа опровергани твърдения (фактчек 24.07.2026)', function () {
    $flat = json_encode(config('tsolov'), JSON_UNESCAPED_UNICODE);

    // Цолов никога не е печелил Eurocup-3 (шампион 2023 е Esteban Masson).
    expect($flat)->not->toContain('Eurocup')
        // 2026 е първият му пълен сезон във Ф2 (новак), не „втори сезон".
        ->and($flat)->not->toContain('Втори сезон във Формула 2')
        // Дебютът във FIA Формула 3 е 2023 с ART, не 2024.
        ->and(collect(config('tsolov.milestones'))->firstWhere('year', 2023)['event'])->toContain('Формула 3')
        // Имола (27.08.2026) е първият му ТЕСТ, не първият път в болид от Ф1:
        // преди това е карал RB7 на шоуто на Red Bull в София (06.2025) и RB8
        // на Goodwood (07.2026). Фактчек 02.11.2026.
        ->and($flat)->not->toContain('за първи път кара болид');
});

it('редакционният текст не казва кой води шампионата (фактчек 02.11.2026)', function () {
    // Позицията идва живо от базата (TsolovController::liveSeason). Записана
    // във файла, тя остарява още на следващия кръг: на 02.11.2026 страницата
    // още наричаше Цолов „лидер", пет седмици след като Камара го изпревари.
    $flat = mb_strtolower(json_encode(config('tsolov'), JSON_UNESCAPED_UNICODE));

    expect($flat)->not->toContain('лидер');
});

it('мини класирането има бележка за актуалност (standings_note)', function () {
    $this->get('/tsolov')
        ->assertInertia(fn (Assert $page) => $page
            ->has('profile.standings_note')
            ->has('profile.standings', 5));
});

it('сервира файла директно, не (потенциално стар) config кеш', function () {
    // Симулираме стар config кеш: подменена стойност в config регистъра.
    // Страницата трябва да я игнорира и да чете config/tsolov.php директно —
    // така на прод редакция + deploy влиза в сила без `config:cache`.
    config(['tsolov.season_stats.points' => 99999]);

    $fromFile = require config_path('tsolov.php');

    $this->get('/tsolov')
        ->assertInertia(fn (Assert $page) => $page
            ->where('profile.season_stats.points', $fromFile['season_stats']['points']));
});

it('страницата рендира титлите', function () {
    $this->get('/tsolov')
        ->assertInertia(fn (Assert $page) => $page->has('profile.titles', 2));
});
