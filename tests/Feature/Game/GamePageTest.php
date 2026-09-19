<?php

declare(strict_types=1);

use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Inertia\Testing\AssertableInertia as Assert;

beforeEach(function () {
    config(['features.game' => true]);
    Cache::forget('game.tracks.index');
});

afterEach(function () {
    Cache::forget('game.tracks.index');
});

it('връща 404 когато флагът е изключен', function () {
    config(['features.game' => false]);

    $this->get('/game')->assertNotFound();
});

it('показва каталога на пистите', function () {
    $this->get('/game')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Game/Index')
            ->has('tracks')
        );
});

it('подава само метаданни, не самите точки на трасето', function () {
    // Точките са стотици килобайта на писта — ако някога влязат в Inertia
    // отговора, всяко зареждане на страницата ще влачи всички писти наведнъж.
    $this->get('/game')
        ->assertInertia(fn (Assert $page) => $page
            ->has('tracks.0', fn (Assert $track) => $track
                ->has('slug')
                ->has('name')
                ->has('location')
                ->has('length')
                ->has('elevation')
                ->missing('points')
                ->missing('landmarks')
            )
        );
});

it('не гърми когато каталогът липсва', function () {
    // Пресен clone преди `php artisan game:generate-tracks` — страницата
    // трябва да се зареди празна, не да хвърли.
    $index = public_path('game-tracks/index.json');
    $backup = file_exists($index) ? file_get_contents($index) : null;

    if ($backup !== null) {
        unlink($index);
    }

    try {
        $this->get('/game')
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page->has('tracks', 0));
    } finally {
        if ($backup !== null) {
            file_put_contents($index, $backup);
        }
    }
});

it('крие камерата от кокпита по подразбиране — флагът стига до страницата', function () {
    $this->get('/game')
        ->assertInertia(fn (Assert $page) => $page->where('features.game_cockpit', false));

    config(['features.game_cockpit' => true]);

    $this->get('/game')
        ->assertInertia(fn (Assert $page) => $page->where('features.game_cockpit', true));
});

it('подава на страницата дали влезлият е админ — само той вижда кокпита при изключен флаг', function () {
    $this->actingAs(User::factory()->create(['is_admin' => true]))
        ->get('/game')
        ->assertInertia(fn (Assert $page) => $page->where('auth.user.is_admin', true));

    $this->actingAs(User::factory()->create(['is_admin' => false]))
        ->get('/game')
        ->assertInertia(fn (Assert $page) => $page->where('auth.user.is_admin', false));
});

it('играта не пуска кокпита без разрешение — нито от менюто, нито от C, нито в реплея', function () {
    $game = (string) file_get_contents(resource_path('js/game/Game.js'));
    $page = (string) file_get_contents(resource_path('js/Pages/Game/Index.vue'));

    expect($game)->toContain('this.cockpitAllowed = options.allowCockpit === true;')
        ->and(substr_count($game, "mode === 'onboard' && !this.cockpitAllowed"))->toBe(2)
        ->and($game)->toContain("event.code === 'KeyC' && !event.repeat && this.cockpitAllowed")
        ->and($page)->toContain('allowCockpit: cockpitAllowed.value')
        ->and($page)->toContain('page.props.features?.game_cockpit === true || authUser.value?.is_admin === true');
});
