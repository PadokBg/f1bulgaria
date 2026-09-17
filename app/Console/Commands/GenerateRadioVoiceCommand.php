<?php

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\RequestException;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * Озвучава радиото на играта през ElevenLabs: всяка фраза от каталога
 * (resources/js/game/radioPhrases.json) става кратък mp3 клип за всеки от
 * инженерите в config game.radio_voice.voices, а manifest.json казва на
 * играта кой файл за коя фраза и кой глас е. Играта избира случаен инженер
 * за всяко състезание.
 *
 * Пуска се ЛОКАЛНО и рядко (при нова фраза или нов глас); резултатът влиза в
 * репото. Клип, чийто текст, глас и настройки не са се променили, не се
 * генерира наново — знаците в тарифата са ограничени.
 */
class GenerateRadioVoiceCommand extends Command
{
    protected $signature = 'game:generate-radio-voice
        {--voice= : Само този инженер (ключ от конфига); за --sample може и суров ID на глас}
        {--list-voices : Показва гласовете в акаунта и спира}
        {--sample : Озвучава само няколко фрази в storage за слушане, без да пипа играта}
        {--force : Озвучава наново всички фрази}
        {--dry-run : Само брои клиповете и знаците, без заявки}';

    protected $description = 'Генерира гласовите клипове на радиото в играта (ElevenLabs).';

    /** Малък mp3: радио филтърът в играта и без това реже над ~3.4 kHz. */
    private const OUTPUT_FORMAT = 'mp3_22050_32';

    /** Фиксиран seed — повторно генериране на същия текст звучи еднакво. */
    private const SEED = 20260917;

    /**
     * По-малко стабилност = повече емоция (инженер по радиото, не диктор);
     * леко забързано, защото съобщенията са в движение.
     *
     * @var array{stability: float, similarity_boost: float, style: float, speed: float, use_speaker_boost: bool}
     */
    private const VOICE_SETTINGS = [
        'stability' => 0.4,
        'similarity_boost' => 0.8,
        'style' => 0.25,
        'speed' => 1.08,
        'use_speaker_boost' => true,
    ];

    /** Фразите за --sample: по една от всеки тип съобщение. */
    private const SAMPLE_CLIPS = ['last-lap', 'drs', 'bot-0-passed', 'penalty-contact', 'gained-p4'];

    public function handle(): int
    {
        $catalog = $this->catalog();
        if ($catalog === null) {
            return self::FAILURE;
        }

        $clips = $this->clips($catalog);
        $voices = $this->voices();
        if ($voices === null) {
            return self::FAILURE;
        }

        if ($this->option('dry-run')) {
            $characters = array_sum(array_map('mb_strlen', $clips));
            $this->info(count($clips).' клипа × '.count($voices).' гласа, '.($characters * count($voices)).' знака.');

            return self::SUCCESS;
        }

        $key = (string) config('services.elevenlabs.key');
        if ($key === '') {
            $this->error('Липсва ELEVENLABS_API_KEY в .env — ключът се взима от elevenlabs.io → Settings → API Keys.');

            return self::FAILURE;
        }

        if ($this->option('list-voices')) {
            return $this->listVoices($key);
        }

        if ($this->option('sample')) {
            foreach ($voices as $voiceId) {
                if ($this->generateSamples($key, $voiceId, $clips) === self::FAILURE) {
                    return self::FAILURE;
                }
            }

            return self::SUCCESS;
        }

        return $this->generateClips($key, $voices, $clips, (int) $catalog['version']);
    }

    /**
     * @return array{version: int, bots: list<string>, botPhrases: array<string, string>, phrases: array<string, string>}|null
     */
    private function catalog(): ?array
    {
        $path = (string) config('game.radio_voice.phrases');

        try {
            $catalog = json_decode((string) File::get($path), true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable $e) {
            $this->error("Каталогът с фрази не се чете ({$path}): {$e->getMessage()}");

            return null;
        }

        return is_array($catalog) ? $catalog : null;
    }

    /**
     * Всички клипове: фиксираните фрази + всяка фраза с име на бот.
     *
     * @param  array{bots: list<string>, botPhrases: array<string, string>, phrases: array<string, string>}  $catalog
     * @return array<string, string> id => текст
     */
    private function clips(array $catalog): array
    {
        $clips = $catalog['phrases'];

        foreach ($catalog['bots'] as $index => $name) {
            foreach ($catalog['botPhrases'] as $phrase => $template) {
                $clips["bot-{$index}-{$phrase}"] = str_replace('{name}', $name, $template);
            }
        }

        return $clips;
    }

    /**
     * Инженерите за генериране: всички от конфига или само --voice. За
     * --sample --voice може да е и суров ID (проба на глас извън конфига).
     *
     * @return array<string, string>|null ключ => voice ID
     */
    private function voices(): ?array
    {
        $configured = (array) config('game.radio_voice.voices', []);
        $only = $this->option('voice');

        if ($only === null || $only === '') {
            if ($configured === []) {
                $this->error('Няма гласове в config game.radio_voice.voices.');

                return null;
            }

            return $configured;
        }

        if (array_key_exists($only, $configured)) {
            return [$only => $configured[$only]];
        }

        if ($this->option('sample') || $this->option('list-voices')) {
            return [$only => $only];
        }

        $this->error("Непознат глас „{$only}“. Добави го в config game.radio_voice.voices (ключ => ID).");

        return null;
    }

    private function listVoices(string $key): int
    {
        $response = $this->client($key)
            ->acceptJson()
            ->get('/v2/voices', ['page_size' => 100, 'sort' => 'name']);

        if ($response->failed()) {
            $this->reportFailure($response);

            return self::FAILURE;
        }

        $rows = collect($response->json('voices', []))
            ->map(fn (array $voice): array => [
                $voice['name'] ?? '—',
                $voice['voice_id'] ?? '—',
                $voice['category'] ?? '—',
                collect($voice['labels'] ?? [])->only(['gender', 'age', 'accent', 'use_case'])->implode(', '),
            ])
            ->all();

        $this->table(['Име', 'ID', 'Тип', 'Етикети'], $rows);

        return self::SUCCESS;
    }

    /**
     * @param  array<string, string>  $clips
     */
    private function generateSamples(string $key, string $voiceId, array $clips): int
    {
        $directory = rtrim((string) config('game.radio_voice.samples_path'), '/\\').DIRECTORY_SEPARATOR.$voiceId;
        File::ensureDirectoryExists($directory);

        foreach (self::SAMPLE_CLIPS as $id) {
            $response = $this->synthesize($key, $voiceId, $clips[$id]);
            if ($response === null || $response->failed()) {
                $this->reportFailure($response);

                return self::FAILURE;
            }

            File::put($directory.DIRECTORY_SEPARATOR."{$id}.mp3", $response->body());
            $this->line("  {$id}: {$clips[$id]}");
        }

        $this->info("Пробите са в {$directory}");

        return self::SUCCESS;
    }

    /**
     * @param  array<string, string>  $voices  ключ => voice ID
     * @param  array<string, string>  $clips
     */
    private function generateClips(string $key, array $voices, array $clips, int $version): int
    {
        $directory = rtrim((string) config('game.radio_voice.path'), '/\\');
        File::ensureDirectoryExists($directory);

        $manifestPath = $directory.DIRECTORY_SEPARATOR.'manifest.json';
        $manifest = $this->readManifest($manifestPath);
        $model = (string) config('services.elevenlabs.radio_model');
        $generated = 0;
        $characters = 0;

        $manifest['version'] = $version;
        $manifest['model'] = $model;

        // Инженер, махнат от конфига, не остава като мъртва папка (само при
        // пълно генериране — --voice пипа един глас).
        if ($this->option('voice') === null) {
            foreach (array_diff(array_keys($manifest['voices']), array_keys($voices)) as $orphan) {
                File::deleteDirectory($directory.DIRECTORY_SEPARATOR.$orphan);
                unset($manifest['voices'][$orphan]);
            }
        }

        foreach ($voices as $voiceKey => $voiceId) {
            File::ensureDirectoryExists($directory.DIRECTORY_SEPARATOR.$voiceKey);

            $voice = $manifest['voices'][$voiceKey] ?? ['id' => $voiceId, 'clips' => []];
            $voice['id'] = $voiceId;

            // Фрази, махнати от каталога, не остават като мъртви файлове.
            foreach (array_diff(array_keys($voice['clips']), array_keys($clips)) as $orphan) {
                File::delete($directory.DIRECTORY_SEPARATOR.$voice['clips'][$orphan]['file']);
                unset($voice['clips'][$orphan]);
            }

            foreach ($clips as $id => $text) {
                $hash = sha1((string) json_encode([$text, $voiceId, $model, self::VOICE_SETTINGS, self::OUTPUT_FORMAT, self::SEED]));
                $file = "{$voiceKey}/{$id}.mp3";

                $unchanged = ($voice['clips'][$id]['hash'] ?? null) === $hash
                    && File::exists($directory.DIRECTORY_SEPARATOR.$file);
                if ($unchanged && ! $this->option('force')) {
                    continue;
                }

                $response = $this->synthesize($key, $voiceId, $text);
                if ($response === null || $response->failed()) {
                    // Готовите дотук остават в manifest-а — повторният пуск продължава.
                    $manifest['voices'][$voiceKey] = $voice;
                    $this->writeManifest($manifestPath, $manifest);
                    $this->reportFailure($response);

                    return self::FAILURE;
                }

                File::put($directory.DIRECTORY_SEPARATOR.$file, $response->body());
                $voice['clips'][$id] = ['file' => $file, 'hash' => $hash, 'text' => $text];
                $manifest['voices'][$voiceKey] = $voice;
                $this->writeManifest($manifestPath, $manifest);

                $generated++;
                $characters += mb_strlen($text);
                $this->line("  {$voiceKey}/{$id}: {$text}");
            }

            $manifest['voices'][$voiceKey] = $voice;
        }

        $this->writeManifest($manifestPath, $manifest);
        $this->info("Готово: {$generated} нови клипа ({$characters} знака) за ".count($voices).' гласа.');

        return self::SUCCESS;
    }

    private function synthesize(string $key, string $voiceId, string $text): ?Response
    {
        try {
            return $this->client($key)
                ->accept('audio/mpeg')
                ->withQueryParameters(['output_format' => self::OUTPUT_FORMAT])
                ->post('/v1/text-to-speech/'.rawurlencode($voiceId), [
                    'text' => $text,
                    'model_id' => (string) config('services.elevenlabs.radio_model'),
                    'voice_settings' => self::VOICE_SETTINGS,
                    'seed' => self::SEED,
                ]);
        } catch (ConnectionException $e) {
            $this->error("ElevenLabs не отговаря: {$e->getMessage()}");

            return null;
        }
    }

    private function client(string $key): PendingRequest
    {
        return Http::baseUrl((string) config('services.elevenlabs.base_url'))
            ->withHeaders(['xi-api-key' => $key])
            ->timeout(60)
            // Претоварване или rate limit се повтаря; грешен ключ/глас — не.
            ->retry(
                3,
                fn (int $attempt): int => $attempt * 2000,
                fn (Throwable $e): bool => $e instanceof ConnectionException
                    || ($e instanceof RequestException && in_array($e->response->status(), [429, 500, 502, 503], true)),
                throw: false,
            );
    }

    private function reportFailure(?Response $response): void
    {
        if ($response === null) {
            return;
        }

        $detail = $response->json('detail.message') ?? $response->json('detail') ?? mb_substr($response->body(), 0, 300);
        $this->error("ElevenLabs върна {$response->status()}: ".(is_string($detail) ? $detail : json_encode($detail)));
    }

    /**
     * @return array{version: int, model: string|null, voices: array<string, array{id: string, clips: array<string, array{file: string, hash: string, text: string}>}>}
     */
    private function readManifest(string $path): array
    {
        $empty = ['version' => 0, 'model' => null, 'voices' => []];

        if (! File::exists($path)) {
            return $empty;
        }

        try {
            $manifest = json_decode((string) File::get($path), true, 512, JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            return $empty;
        }

        return is_array($manifest) && is_array($manifest['voices'] ?? null) ? $manifest + $empty : $empty;
    }

    /**
     * @param  array<string, mixed>  $manifest
     */
    private function writeManifest(string $path, array $manifest): void
    {
        ksort($manifest['voices']);
        foreach ($manifest['voices'] as &$voice) {
            ksort($voice['clips']);
        }
        unset($voice);

        File::put($path, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)."\n");
    }
}
