<?php

declare(strict_types=1);

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    $this->outputDir = storage_path('framework/testing/radio-voice-'.uniqid());
    config([
        'services.elevenlabs.key' => 'test-key',
        'services.elevenlabs.base_url' => 'https://api.elevenlabs.test',
        'services.elevenlabs.radio_model' => 'eleven_multilingual_v2',
        'game.radio_voice.path' => $this->outputDir,
        'game.radio_voice.samples_path' => $this->outputDir.'/samples',
        'game.radio_voice.voices' => ['daniel' => 'voice-daniel', 'adam' => 'voice-adam'],
    ]);

    $catalog = json_decode((string) file_get_contents(resource_path('js/game/radioPhrases.json')), true);
    $this->clipCount = count($catalog['phrases']) + count($catalog['bots']) * count($catalog['botPhrases']);
});

afterEach(function () {
    File::deleteDirectory($this->outputDir);
});

it('имената на ботовете в каталога съвпадат с тези в играта', function () {
    $catalog = json_decode((string) file_get_contents(resource_path('js/game/radioPhrases.json')), true);
    $game = (string) file_get_contents(resource_path('js/game/Game.js'));

    preg_match('/const BOT_NAMES = \[(.*?)\];/s', $game, $matches);
    preg_match_all("/'[^'.]+\\.\\s*([^']+)'/u", $matches[1] ?? '', $names);

    // Гласът казва фамилията, кулата показва „В. Колев" — същият ред.
    expect($names[1])->toBe($catalog['bots']);
});

it('конфигурираните инженери са безплатните гласове, с които са генерирани клиповете', function () {
    $manifestPath = public_path('game-audio/radio/manifest.json');
    if (! File::exists($manifestPath)) {
        $this->markTestSkipped('Клиповете още не са генерирани.');
    }

    $manifest = json_decode((string) File::get($manifestPath), true);
    $configured = require config_path('game.php');

    $generated = collect($manifest['voices'])->map->id->sortKeys()->all();
    $expected = collect($configured['radio_voice']['voices'])->sortKeys()->all();

    expect($generated)->toBe($expected);
});

it('dry-run брои клиповете и знаците за всички гласове без заявки', function () {
    Http::fake();

    $this->artisan('game:generate-radio-voice', ['--dry-run' => true])
        ->expectsOutputToContain("{$this->clipCount} клипа × 2 гласа")
        ->assertSuccessful();

    Http::assertNothingSent();
});

it('отказва без API ключ', function () {
    config(['services.elevenlabs.key' => null]);
    Http::fake();

    $this->artisan('game:generate-radio-voice')
        ->expectsOutputToContain('ELEVENLABS_API_KEY')
        ->assertFailed();

    Http::assertNothingSent();
});

it('озвучава всички фрази за всеки инженер и пише manifest', function () {
    Http::fake(['api.elevenlabs.test/*' => Http::response('MP3', 200, ['Content-Type' => 'audio/mpeg'])]);

    $this->artisan('game:generate-radio-voice')->assertSuccessful();

    Http::assertSentCount($this->clipCount * 2);
    Http::assertSent(fn (Request $request): bool => $request->hasHeader('xi-api-key', 'test-key')
        && str_starts_with($request->url(), 'https://api.elevenlabs.test/v1/text-to-speech/voice-adam?output_format=mp3_22050_32')
        && $request['model_id'] === 'eleven_multilingual_v2'
        && $request['text'] === 'Изпревари Колев!');

    $manifest = json_decode((string) File::get($this->outputDir.'/manifest.json'), true);

    expect(array_keys($manifest['voices']))->toBe(['adam', 'daniel'])
        ->and($manifest['voices']['daniel']['id'])->toBe('voice-daniel')
        ->and($manifest['voices']['daniel']['clips'])->toHaveCount($this->clipCount)
        ->and($manifest['voices']['adam']['clips']['bot-0-passed']['file'])->toBe('adam/bot-0-passed.mp3')
        ->and(File::get($this->outputDir.'/adam/bot-0-passed.mp3'))->toBe('MP3');
});

it('не озвучава наново непроменени фрази, а force го прави', function () {
    Http::fake(['api.elevenlabs.test/*' => Http::response('MP3', 200)]);

    $this->artisan('game:generate-radio-voice')->assertSuccessful();
    $this->artisan('game:generate-radio-voice')->assertSuccessful();
    Http::assertSentCount($this->clipCount * 2);

    $this->artisan('game:generate-radio-voice', ['--force' => true])->assertSuccessful();
    Http::assertSentCount($this->clipCount * 4);
});

it('--voice озвучава само един инженер и не трие останалите', function () {
    Http::fake(['api.elevenlabs.test/*' => Http::response('MP3', 200)]);

    $this->artisan('game:generate-radio-voice')->assertSuccessful();
    $this->artisan('game:generate-radio-voice', ['--voice' => 'adam', '--force' => true])->assertSuccessful();

    Http::assertSentCount($this->clipCount * 3);
    $manifest = json_decode((string) File::get($this->outputDir.'/manifest.json'), true);
    expect(array_keys($manifest['voices']))->toBe(['adam', 'daniel']);
});

it('инженер, махнат от конфига, изчезва от manifest-а и от диска', function () {
    Http::fake(['api.elevenlabs.test/*' => Http::response('MP3', 200)]);

    $this->artisan('game:generate-radio-voice')->assertSuccessful();
    config(['game.radio_voice.voices' => ['daniel' => 'voice-daniel']]);
    $this->artisan('game:generate-radio-voice')->assertSuccessful();

    $manifest = json_decode((string) File::get($this->outputDir.'/manifest.json'), true);
    expect(array_keys($manifest['voices']))->toBe(['daniel'])
        ->and(File::isDirectory($this->outputDir.'/adam'))->toBeFalse();
});

it('отказва непознат инженер при генериране', function () {
    Http::fake();

    $this->artisan('game:generate-radio-voice', ['--voice' => 'nobody'])
        ->expectsOutputToContain('Непознат глас')
        ->assertFailed();

    Http::assertNothingSent();
});

it('спира при грешен ключ и пази готовото дотук', function () {
    Http::fake(['api.elevenlabs.test/*' => Http::sequence()
        ->push('MP3', 200)
        ->push(['detail' => ['message' => 'Invalid API key']], 401),
    ]);

    $this->artisan('game:generate-radio-voice')
        ->expectsOutputToContain('Invalid API key')
        ->assertFailed();

    $manifest = json_decode((string) File::get($this->outputDir.'/manifest.json'), true);
    expect(collect($manifest['voices'])->sum(fn (array $voice): int => count($voice['clips'])))->toBe(1);
});

it('пробите не пипат клиповете на играта и приемат суров ID', function () {
    Http::fake(['api.elevenlabs.test/*' => Http::response('MP3', 200)]);

    $this->artisan('game:generate-radio-voice', ['--sample' => true, '--voice' => 'raw-voice-id'])->assertSuccessful();

    Http::assertSentCount(5);
    expect(File::exists($this->outputDir.'/manifest.json'))->toBeFalse()
        ->and(File::exists($this->outputDir.'/samples/raw-voice-id/overtake.mp3'))->toBeTrue();
});

it('показва гласовете в акаунта', function () {
    Http::fake(['api.elevenlabs.test/v2/voices*' => Http::response(['voices' => [
        ['voice_id' => 'abc', 'name' => 'George', 'category' => 'premade', 'labels' => ['gender' => 'male', 'accent' => 'british']],
    ]])]);

    $this->artisan('game:generate-radio-voice', ['--list-voices' => true])
        ->expectsOutputToContain('George')
        ->assertSuccessful();
});
