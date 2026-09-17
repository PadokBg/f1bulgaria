<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Models\GameRaceRecord;
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
 * Преиграва записания вход на цялото състезание — играч, ботове и контакти —
 * през СЪЩАТА симулация като клиента (Node, scripts/game/validate-race.mjs).
 *
 * Преиграното е авторитетното: при съвпадение записът приема времето,
 * наказанията и окончателната позиция от сървъра, плюс кадрите на духа за
 * задочните битки. Инфраструктурен проблем дава 'error' и състезанието ОСТАВА
 * в класацията — не наказваме играч без доказателство.
 */
class ValidateGameRaceJob implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    /**
     * Позволена разлика между заявено и преиграно общо време, ms. V8 → V8 е
     * бит-идентично; толерансът покрива само дребни разминавания на Math.sin/
     * cos в други двигатели. При контакти те бързо растат, затова Firefox/
     * Safari по-често падат извън него — съзнателно, честността е по-важна.
     */
    private const TOLERANCE_MS = 120;

    public int $timeout = 120;

    public int $tries = 2;

    public function __construct(public readonly int $recordId) {}

    /**
     * Две валидации на един потребител+писта биха си изтрили взаимно духа
     * (prune-ът е read-then-write) — сериализират се.
     *
     * @return array<int, object>
     */
    public function middleware(): array
    {
        $record = GameRaceRecord::query()->find($this->recordId, ['user_id', 'track_slug']);

        if ($record === null) {
            return [];
        }

        return [
            (new WithoutOverlapping("game-race:{$record->user_id}:{$record->track_slug}"))
                ->releaseAfter(15)
                ->expireAfter(180),
        ];
    }

    public function handle(NodeReplayRunner $runner): void
    {
        $record = GameRaceRecord::query()->find($this->recordId);

        if ($record === null) {
            return;
        }

        // Чакащ job отпреди деплой с нова физика/правила не може да се преиграе честно.
        if (
            $record->sim_version !== (int) config('game.sim_version', 3)
            || $record->race_version !== (int) config('game.race_version', 1)
        ) {
            $record->update(['verify_status' => 'rejected']);

            return;
        }

        $trackFile = public_path("game-tracks/{$record->track_slug}.json");

        if (! file_exists($trackFile)) {
            $record->update(['verify_status' => 'error']);

            return;
        }

        $result = $runner->run('scripts/game/validate-race.mjs', [
            'trackFile' => $trackFile,
            'trace' => $record->input_trace,
        ], $record->id);

        if ($result === null) {
            $record->update(['verify_status' => 'error']);

            return;
        }

        $status = (string) ($result['status'] ?? 'bad_trace');
        $replayedTotalMs = is_numeric($result['totalMs'] ?? null) ? (int) $result['totalMs'] : null;

        $reproduced = $status === 'finished'
            && $replayedTotalMs !== null
            && is_numeric($result['raceMs'] ?? null)
            && is_numeric($result['penalties'] ?? null)
            && is_numeric($result['position'] ?? null)
            && abs($replayedTotalMs - $record->total_ms) <= self::TOLERANCE_MS;

        if ($reproduced) {
            // Кадрите на духа — таван срещу раздут изход (20-минутно
            // състезание е ~1.1 MB base64; нормалното е 300–500 KB).
            $frames = is_string($result['frames'] ?? null) && strlen($result['frames']) <= 4_000_000
                ? $result['frames']
                : null;

            $record->update([
                'verify_status' => 'verified',
                'verified_total_ms' => $replayedTotalMs,
                'race_ms' => (int) $result['raceMs'],
                'penalties' => (int) $result['penalties'],
                'total_ms' => $replayedTotalMs,
                'position' => (int) $result['position'],
                'ghost_frames' => $frames,
                'race_ticks' => is_numeric($result['raceTicks'] ?? null) ? (int) $result['raceTicks'] : null,
            ]);

            $this->pruneGhostFrames($record);

            return;
        }

        $record->update([
            'verify_status' => 'rejected',
            'verified_total_ms' => $replayedTotalMs,
        ]);

        Log::notice('game: състезание отхвърлено от преиграването', [
            'record' => $record->id,
            'claimed_ms' => $record->total_ms,
            'replayed_ms' => $replayedTotalMs,
            'status' => $status,
        ]);
    }

    /**
     * Кадрите се пазят само за НАЙ-ДОБРОТО състезание на потребителя на
     * пистата — останалите са мъртво тегло от стотици KB. Изборът и чистенето
     * са една транзакция със заключени редове.
     */
    private function pruneGhostFrames(GameRaceRecord $record): void
    {
        DB::transaction(function () use ($record): void {
            $best = GameRaceRecord::query()
                ->counted()
                ->where('user_id', $record->user_id)
                ->where('track_slug', $record->track_slug)
                ->whereNotNull('ghost_frames')
                ->lockForUpdate()
                ->orderBy('total_ms')
                ->orderByDesc('id')
                ->first(['id']);

            if ($best === null) {
                return;
            }

            GameRaceRecord::query()
                ->where('user_id', $record->user_id)
                ->where('track_slug', $record->track_slug)
                ->where('id', '!=', $best->id)
                ->whereNotNull('ghost_frames')
                ->update(['ghost_frames' => null]);
        });
    }
}
