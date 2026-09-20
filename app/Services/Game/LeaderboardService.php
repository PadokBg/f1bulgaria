<?php

declare(strict_types=1);

namespace App\Services\Game;

use App\Jobs\ValidateGameLapJob;
use App\Models\GameLapRecord;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;

/**
 * Класация на играта: лилави рекорди, топ обиколки и записване на нова
 * квалификационна обиколка.
 *
 * „Лилаво" = най-бързото постигано на пистата — за цялата обиколка и за всеки
 * сектор поотделно. Секторните рекорди се търсят независимо от обиколката, в
 * която са направени (идеална обиколка), точно като в реалния тайминг.
 */
class LeaderboardService
{
    /**
     * Лилавите (рекордни) времена за пистата.
     *
     * @return array{lap_ms: int|null, sectors_ms: array{0: int|null, 1: int|null, 2: int|null}}
     */
    public function bests(string $trackSlug): array
    {
        $row = GameLapRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->selectRaw('MIN(lap_ms) as lap_ms, MIN(sector1_ms) as s1, MIN(sector2_ms) as s2, MIN(sector3_ms) as s3')
            ->first();

        return [
            'lap_ms' => $row?->lap_ms !== null ? (int) $row->lap_ms : null,
            'sectors_ms' => [
                $row?->s1 !== null ? (int) $row->s1 : null,
                $row?->s2 !== null ? (int) $row->s2 : null,
                $row?->s3 !== null ? (int) $row->s3 : null,
            ],
        ];
    }

    /**
     * Топ N потребители по най-добра обиколка на пистата. `has_ghost` казва
     * дали има сървърен дух за дуел („Карай срещу…"); $since ограничава до
     * седмичното предизвикателство (пистата на уикенда).
     *
     * @return Collection<int, array{user_id: int, name: string, avatar: string|null, lap_ms: int, is_you: bool, has_ghost: bool}>
     */
    public function topLaps(string $trackSlug, ?User $viewer = null, int $limit = 10, ?Carbon $since = null): Collection
    {
        // has_ghost е нарочно all-time и в седмичния изглед (без $since):
        // ghostOf() винаги сервира най-добрата обиколка на потребителя изобщо,
        // така че дуелът има смисъл независимо кога е карана седмичната.
        $withGhosts = GameLapRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->whereNotNull('ghost_frames')
            ->distinct()
            ->pluck('user_id')
            ->map(fn ($id): int => (int) $id)
            ->all();

        return GameLapRecord::query()
            ->counted()
            ->where('game_lap_records.track_slug', $trackSlug)
            ->when($since !== null, fn ($query) => $query->where('game_lap_records.created_at', '>=', $since))
            ->join('users', 'users.id', '=', 'game_lap_records.user_id')
            ->groupBy('game_lap_records.user_id', 'users.name', 'users.avatar_path')
            ->selectRaw('game_lap_records.user_id, users.name, users.avatar_path, MIN(lap_ms) as lap_ms')
            ->orderByRaw('MIN(lap_ms)')
            ->limit($limit)
            ->get()
            ->map(fn (GameLapRecord $row): array => [
                'user_id' => (int) $row->user_id,
                'name' => (string) $row->name,
                'avatar' => $row->avatar_path !== null ? (string) $row->avatar_path : null,
                'lap_ms' => (int) $row->lap_ms,
                'is_you' => $viewer !== null && (int) $row->user_id === $viewer->id,
                'has_ghost' => in_array((int) $row->user_id, $withGhosts, true),
            ]);
    }

    /**
     * Статистика за публичния профил: карани писти, първи места и трите
     * най-силни времена (с имена на пистите от кеширания каталог).
     *
     * @return array{tracks_played: int, total_tracks: int, firsts: int,
     *               best_laps: array<int, array{track: string, name: string, lap_ms: int, rank1: bool}>}
     */
    public function profileStats(User $user): array
    {
        $userBests = GameLapRecord::query()
            ->counted()
            ->where('user_id', $user->id)
            ->groupBy('track_slug')
            ->selectRaw('track_slug, MIN(lap_ms) as lap_ms')
            ->pluck('lap_ms', 'track_slug');

        if ($userBests->isEmpty()) {
            return ['tracks_played' => 0, 'total_tracks' => count((array) config('game.tracks', [])), 'firsts' => 0, 'best_laps' => []];
        }

        // Абсолютният рекорд на всяка от караните писти — за „първо място".
        $overall = GameLapRecord::query()
            ->counted()
            ->whereIn('track_slug', $userBests->keys())
            ->groupBy('track_slug')
            ->selectRaw('track_slug, MIN(lap_ms) as lap_ms')
            ->pluck('lap_ms', 'track_slug');

        $names = collect($this->trackIndex())->pluck('name', 'slug');

        $bestLaps = $userBests
            ->map(fn (int $lapMs, string $slug): array => [
                'track' => $slug,
                'name' => (string) ($names[$slug] ?? $slug),
                'lap_ms' => $lapMs,
                'rank1' => (int) ($overall[$slug] ?? 0) === $lapMs,
            ])
            ->sortBy('lap_ms')
            ->values();

        return [
            'tracks_played' => $userBests->count(),
            'total_tracks' => count((array) config('game.tracks', [])),
            'firsts' => $bestLaps->where('rank1', true)->count(),
            'best_laps' => $bestLaps->take(3)->all(),
        ];
    }

    /**
     * Каталогът на пистите (public/game-tracks/index.json) — същият кеш ключ
     * като валидацията на записа. Публичен: тийзърът на началната страница
     * взима имената оттук.
     *
     * @return array<int, array{slug: string, name: string}>
     */
    public function trackIndex(): array
    {
        return Cache::remember('game.tracks.index', now()->addHour(), function (): array {
            $path = public_path('game-tracks/index.json');

            if (! file_exists($path)) {
                return [];
            }

            try {
                return json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                return [];
            }
        });
    }

    /**
     * Най-бързата обиколка СЪС записани кадри на потребителя за пистата —
     * духът, срещу който се кара дуел.
     */
    public function ghostOf(int $userId, string $trackSlug): ?GameLapRecord
    {
        // Изричен списък колони: без него редът идва с input_trace (до 620 KB
        // MEDIUMTEXT), който отговорът изобщо не ползва. Tiebreak-ът по id
        // огледално повтаря pruneGhostFrames — двете винаги сочат един ред.
        return GameLapRecord::query()
            ->counted()
            ->with('user:id,name')
            ->where('user_id', $userId)
            ->where('track_slug', $trackSlug)
            ->whereNotNull('ghost_frames')
            ->orderBy('lap_ms')
            ->orderByDesc('id')
            ->first(['id', 'user_id', 'sim_version', 'lap_ms', 'lap_ticks', 'ghost_frames']);
    }

    /** Най-добрата обиколка на потребителя за пистата, в милисекунди. */
    public function userBestMs(User $user, string $trackSlug): ?int
    {
        $value = GameLapRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->where('user_id', $user->id)
            ->min('lap_ms');

        return $value !== null ? (int) $value : null;
    }

    /**
     * Личните рекорди на потребителя (обиколка + по сектори) — за зелено/жълто
     * оцветяване спрямо собственото най-добро.
     *
     * @return array{lap_ms: int|null, sectors_ms: array{0: int|null, 1: int|null, 2: int|null}}
     */
    public function userBests(User $user, string $trackSlug): array
    {
        $row = GameLapRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->where('user_id', $user->id)
            ->selectRaw('MIN(lap_ms) as lap_ms, MIN(sector1_ms) as s1, MIN(sector2_ms) as s2, MIN(sector3_ms) as s3')
            ->first();

        return [
            'lap_ms' => $row?->lap_ms !== null ? (int) $row->lap_ms : null,
            'sectors_ms' => [
                $row?->s1 !== null ? (int) $row->s1 : null,
                $row?->s2 !== null ? (int) $row->s2 : null,
                $row?->s3 !== null ? (int) $row->s3 : null,
            ],
        ];
    }

    /**
     * Какво БИ постигнало това време, без да се записва нищо — за госта, който
     * току-що е спрял на финала и още не е влязъл.
     *
     * Позицията се брои спрямо най-добрите обиколки на другите, точно както
     * rankOf(), но без потребител: гостът още няма свой ред, който да се
     * изключва.
     *
     * @return array{rank: int, ranked_users: int, leader_ms: int|null, gap_ms: int|null, purple_lap: bool}
     */
    public function preview(string $trackSlug, int $lapMs): array
    {
        $leaderMs = $this->bests($trackSlug)['lap_ms'];

        $ahead = GameLapRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->groupBy('user_id')
            ->havingRaw('MIN(lap_ms) < ?', [$lapMs])
            ->get(['user_id'])
            ->count();

        $rankedUsers = GameLapRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->distinct()
            ->count('user_id');

        return [
            'rank' => $ahead + 1,
            'ranked_users' => $rankedUsers,
            'leader_ms' => $leaderMs,
            // Отрицателно = гостът е по-бърз от лидера (тогава purple_lap е true).
            'gap_ms' => $leaderMs !== null ? $lapMs - $leaderMs : null,
            'purple_lap' => $leaderMs === null || $lapMs < $leaderMs,
        ];
    }

    /**
     * Записва квалификационна обиколка и връща какво е постигнала: лилави
     * полета (нов рекорд на пистата), личен рекорд, позиция и обновените
     * рекорди/класация.
     *
     * @param  array{0: int, 1: int, 2: int}  $sectorsMs
     * @return array<string, mixed>
     */
    public function record(
        User $user,
        string $trackSlug,
        int $lapMs,
        array $sectorsMs,
        ?string $trace = null,
        ?int $simVersion = null,
    ): array {
        // Рекордите ПРЕДИ тази обиколка — за да знаем кои полета стават лилави
        // (рекорд на всички) и кои зелени (личен рекорд на потребителя).
        $before = $this->bests($trackSlug);
        $userBefore = $this->userBests($user, $trackSlug);

        $record = GameLapRecord::create([
            'user_id' => $user->id,
            'track_slug' => $trackSlug,
            'lap_ms' => $lapMs,
            'sector1_ms' => $sectorsMs[0],
            'sector2_ms' => $sectorsMs[1],
            'sector3_ms' => $sectorsMs[2],
            'input_trace' => $trace,
            'sim_version' => $simVersion,
            // С трейс → чака преиграване; без (стар клиент) → на доверие.
            'verify_status' => $trace !== null ? 'pending' : null,
        ]);

        if ($trace !== null) {
            ValidateGameLapJob::dispatch($record->id)->afterCommit();
        }

        $purpleSectors = [];
        $greenSectors = [];
        foreach ($sectorsMs as $i => $ms) {
            $overall = $before['sectors_ms'][$i];
            $personal = $userBefore['sectors_ms'][$i];
            $purpleSectors[$i] = $overall === null || $ms < $overall;
            $greenSectors[$i] = $personal === null || $ms <= $personal;
        }

        return [
            'purple_lap' => $before['lap_ms'] === null || $lapMs < $before['lap_ms'],
            'purple_sectors' => $purpleSectors,
            'green_sectors' => $greenSectors,
            'personal_best' => $userBefore['lap_ms'] === null || $lapMs <= $userBefore['lap_ms'],
            'rank' => $this->rankOf($trackSlug, $user),
            'bests' => $this->bests($trackSlug),
            'user_bests' => $this->userBests($user, $trackSlug),
            'top' => $this->topLaps($trackSlug, $user),
        ];
    }

    /** Позицията на потребителя в класацията (по неговата най-добра обиколка). */
    private function rankOf(string $trackSlug, User $user): int
    {
        $userBest = $this->userBestMs($user, $trackSlug);

        if ($userBest === null) {
            return 1;
        }

        $ahead = GameLapRecord::query()
            ->counted()
            ->where('track_slug', $trackSlug)
            ->where('user_id', '!=', $user->id)
            ->groupBy('user_id')
            ->havingRaw('MIN(lap_ms) < ?', [$userBest])
            ->get(['user_id'])
            ->count();

        return $ahead + 1;
    }
}
