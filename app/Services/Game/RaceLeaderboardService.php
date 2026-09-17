<?php

declare(strict_types=1);

namespace App\Services\Game;

use App\Jobs\ValidateGameRaceJob;
use App\Models\GameRaceRecord;
use App\Models\User;
use Illuminate\Support\Collection;

/**
 * Класацията „Състезание": най-доброто общо време (чисто време + наказанията
 * за излизане или удар) на всеки потребител за пистата. Отделна от обиколките „Сам на
 * пистата" — трафикът и стартът от решетката правят времената несравними.
 */
class RaceLeaderboardService
{
    /**
     * Топ N потребители по най-добро общо време на пистата.
     *
     * @return Collection<int, array{user_id: int, name: string, total_ms: int, is_you: bool, has_ghost: bool}>
     */
    public function topRaces(string $trackSlug, ?User $viewer = null, int $limit = 10): Collection
    {
        $withGhosts = GameRaceRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->whereNotNull('ghost_frames')
            ->distinct()
            ->pluck('user_id')
            ->map(fn ($id): int => (int) $id)
            ->all();

        return GameRaceRecord::query()
            ->counted()
            ->where('game_race_records.track_slug', $trackSlug)
            ->join('users', 'users.id', '=', 'game_race_records.user_id')
            ->groupBy('game_race_records.user_id', 'users.name')
            ->selectRaw('game_race_records.user_id, users.name, MIN(total_ms) as total_ms')
            ->orderByRaw('MIN(total_ms)')
            ->limit($limit)
            ->get()
            ->map(fn (GameRaceRecord $row): array => [
                'user_id' => (int) $row->user_id,
                'name' => (string) $row->name,
                'total_ms' => (int) $row->total_ms,
                'is_you' => $viewer !== null && (int) $row->user_id === $viewer->id,
                'has_ghost' => in_array((int) $row->user_id, $withGhosts, true),
            ]);
    }

    /**
     * Най-доброто състезание С кадри на потребителя за пистата — задочният
     * съперник за „Състезавай се срещу".
     */
    public function ghostOf(int $userId, string $trackSlug): ?GameRaceRecord
    {
        // Изричен списък колони: input_trace (стотици KB) не трябва на отговора.
        return GameRaceRecord::query()
            ->counted()
            ->with('user:id,name')
            ->where('user_id', $userId)
            ->where('track_slug', $trackSlug)
            ->whereNotNull('ghost_frames')
            ->orderBy('total_ms')
            ->orderByDesc('id')
            ->first(['id', 'user_id', 'sim_version', 'race_version', 'race_ms', 'penalties', 'total_ms', 'race_ticks', 'ghost_frames']);
    }

    /** Най-доброто общо време на потребителя за пистата, в милисекунди. */
    public function userBestMs(User $user, string $trackSlug): ?int
    {
        $value = GameRaceRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->where('user_id', $user->id)
            ->min('total_ms');

        return $value !== null ? (int) $value : null;
    }

    /**
     * Записва завършено състезание (pending до преиграването) и връща
     * личния рекорд, позицията и обновената класация.
     *
     * @return array{total_ms: int, personal_best: bool, rank: int, user_best_ms: int|null, top: Collection<int, array{user_id: int, name: string, total_ms: int, is_you: bool, has_ghost: bool}>}
     */
    public function record(
        User $user,
        string $trackSlug,
        int $raceMs,
        int $penalties,
        int $position,
        string $trace,
        int $simVersion,
        int $raceVersion,
    ): array {
        $bestBefore = $this->userBestMs($user, $trackSlug);
        $totalMs = $raceMs + $penalties * (int) config('game.race.penalty_ms', 5000);

        $record = GameRaceRecord::create([
            'user_id' => $user->id,
            'track_slug' => $trackSlug,
            'race_ms' => $raceMs,
            'penalties' => $penalties,
            'total_ms' => $totalMs,
            'position' => $position,
            'input_trace' => $trace,
            'sim_version' => $simVersion,
            'race_version' => $raceVersion,
            'verify_status' => 'pending',
        ]);

        ValidateGameRaceJob::dispatch($record->id)->afterCommit();

        return [
            'total_ms' => $totalMs,
            'personal_best' => $bestBefore === null || $totalMs <= $bestBefore,
            'rank' => $this->rankOf($trackSlug, $user),
            'user_best_ms' => $this->userBestMs($user, $trackSlug),
            'top' => $this->topRaces($trackSlug, $user),
        ];
    }

    /** Позицията на потребителя в класацията (по неговото най-добро време). */
    private function rankOf(string $trackSlug, User $user): int
    {
        $userBest = $this->userBestMs($user, $trackSlug);

        if ($userBest === null) {
            return 1;
        }

        $ahead = GameRaceRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->where('user_id', '!=', $user->id)
            ->groupBy('user_id')
            ->havingRaw('MIN(total_ms) < ?', [$userBest])
            ->get(['user_id'])
            ->count();

        return $ahead + 1;
    }
}
