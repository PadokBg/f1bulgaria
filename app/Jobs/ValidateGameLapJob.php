<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\GameLapRecord;
use App\Services\Badges\BadgeService;
use App\Services\Game\NodeReplayRunner;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\Middleware\WithoutOverlapping;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Преиграва записан вход през СЪЩАТА симулация като клиента (Node,
 * scripts/game/validate-lap.mjs) и отбелязва дали времето се възпроизвежда.
 *
 * Толерансът покрива разликите в Math.sin/cos между JS двигателите
 * (Firefox/Safari клиенти срещу V8 на сървъра) — V8→V8 е бит-идентично.
 * Инфраструктурен проблем (няма node, счупен скрипт) дава 'error' и
 * обиколката ОСТАВА в класацията: не наказваме играч без доказателство.
 */
class ValidateGameLapJob implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    /** Позволена разлика между заявено и преиграно време, ms. */
    private const TOLERANCE_MS = 120;

    public int $timeout = 120;

    public int $tries = 2;

    public function __construct(public readonly int $recordId) {}

    /**
     * Две едновременни валидации на един потребител+писта могат взаимно да си
     * изтрият кадрите на духа (prune-ът е read-then-write) — сериализират се.
     *
     * @return array<int, object>
     */
    public function middleware(): array
    {
        $record = GameLapRecord::query()->find($this->recordId, ['user_id', 'track_slug']);

        if ($record === null) {
            return [];
        }

        return [
            (new WithoutOverlapping("game-lap:{$record->user_id}:{$record->track_slug}"))
                ->releaseAfter(15)
                ->expireAfter(180),
        ];
    }

    public function handle(NodeReplayRunner $runner): void
    {
        $record = GameLapRecord::query()->find($this->recordId);

        if ($record === null || $record->input_trace === null) {
            return;
        }

        // A deploy may leave v2 jobs in the queue. Reject them before starting
        // Node: v3 is a deliberately fresh leaderboard and the current replay
        // engine cannot authoritatively validate an older physics model.
        if ($record->sim_version !== (int) config('game.sim_version', 3)) {
            $record->update(['verify_status' => 'rejected', 'verified_lap_ms' => null]);

            return;
        }

        $trackFile = public_path("game-tracks/{$record->track_slug}.json");

        if (! file_exists($trackFile)) {
            $record->update(['verify_status' => 'error']);

            return;
        }

        $result = $runner->run('scripts/game/validate-lap.mjs', [
            'trackFile' => $trackFile,
            'trace' => $record->input_trace,
        ], $record->id);

        if ($result === null) {
            $record->update(['verify_status' => 'error']);

            return;
        }

        $status = (string) ($result['status'] ?? 'bad_trace');
        $replayedMs = isset($result['lapMs']) && is_numeric($result['lapMs'])
            ? (int) $result['lapMs']
            : null;

        // trace.v е под контрола на клиента: несъвпадаща версия НЕ Е билет за
        // доверие (иначе {"v":999,...} байпасва цялата валидация) — отхвърля
        // се. При вдигане на SIM_VERSION клиенти със стар кеш губят записи до
        // рефреш — цената на честна класация.
        if ($status === 'version_mismatch') {
            $record->update(['verify_status' => 'rejected', 'verified_lap_ms' => null]);
            Log::notice('game: обиколка с несъвпадаща версия на симулацията', [
                'record' => $record->id,
                'sim_version' => $record->sim_version,
            ]);

            return;
        }

        // Заявеният sim_version трябва да съвпада с този в самия трейс.
        try {
            $traceVersion = json_decode($record->input_trace, true, 8, JSON_THROW_ON_ERROR)['v'] ?? null;
        } catch (\JsonException) {
            $traceVersion = null;
        }

        if ($traceVersion !== $record->sim_version) {
            $record->update(['verify_status' => 'rejected', 'verified_lap_ms' => null]);

            return;
        }

        $reproduced = $status === 'finished'
            && ($result['valid'] ?? false) === true
            && $replayedMs !== null
            && abs($replayedMs - $record->lap_ms) <= self::TOLERANCE_MS;

        if ($reproduced) {
            // ПРЕИГРАНОТО време е авторитетното — иначе толерансът е безплатен
            // подарък (клиент би заявил replayed − 119 ms и би минал).
            $sectors = is_array($result['sectorsMs'] ?? null) ? $result['sectorsMs'] : [null, null, null];

            // Кадрите от преиграването = сървърният дух за дуелите. Таван
            // срещу раздут изход (~90 KB е нормална обиколка).
            $frames = is_string($result['frames'] ?? null) && strlen($result['frames']) <= 4_000_000
                ? $result['frames']
                : null;

            $record->update([
                'verify_status' => 'verified',
                'verified_lap_ms' => $replayedMs,
                'lap_ms' => $replayedMs,
                'sector1_ms' => is_numeric($sectors[0] ?? null) ? (int) $sectors[0] : $record->sector1_ms,
                'sector2_ms' => is_numeric($sectors[1] ?? null) ? (int) $sectors[1] : $record->sector2_ms,
                'sector3_ms' => is_numeric($sectors[2] ?? null) ? (int) $sectors[2] : $record->sector3_ms,
                'ghost_frames' => $frames,
                'lap_ticks' => is_numeric($result['lapTicks'] ?? null) ? (int) $result['lapTicks'] : null,
            ]);

            $this->pruneGhostFrames($record);

            // Значките — чак СЛЕД потвърждението (отхвърлена обиколка не бива
            // да е раздала значки). Провал тук не проваля валидацията.
            try {
                app(BadgeService::class)->evaluateForGameLap($record->refresh());
            } catch (\Throwable $e) {
                Log::warning('game: значките след валидация гръмнаха', [
                    'record' => $record->id,
                    'error' => $e->getMessage(),
                ]);
            }

            return;
        }

        $record->update([
            'verify_status' => 'rejected',
            'verified_lap_ms' => $replayedMs,
        ]);

        if (! $reproduced) {
            Log::notice('game: обиколка отхвърлена от преиграването', [
                'record' => $record->id,
                'claimed_ms' => $record->lap_ms,
                'replayed_ms' => $replayedMs,
                'status' => $status,
            ]);
        }
    }

    /**
     * Кадрите на духа се пазят само за НАЙ-ДОБРАТА обиколка на потребителя на
     * пистата — всяка друга е мъртво тегло от ~90 KB. Дуелът от класацията
     * винаги сочи най-бързия наличен дух.
     */
    private function pruneGhostFrames(GameLapRecord $record): void
    {
        // Заключваме редовете: изборът на „най-добрата" и изтриването на
        // останалите трябва да са една атомарна стъпка (WithoutOverlapping
        // пази между два worker-а, транзакцията — при всичко останало).
        DB::transaction(function () use ($record): void {
            $best = GameLapRecord::query()
                ->counted()
                ->where('user_id', $record->user_id)
                ->where('track_slug', $record->track_slug)
                ->whereNotNull('ghost_frames')
                ->lockForUpdate()
                ->orderBy('lap_ms')
                ->orderByDesc('id')
                ->first(['id']);

            if ($best === null) {
                return;
            }

            GameLapRecord::query()
                ->where('user_id', $record->user_id)
                ->where('track_slug', $record->track_slug)
                ->where('id', '!=', $best->id)
                ->whereNotNull('ghost_frames')
                ->update(['ghost_frames' => null]);
        });
    }
}
