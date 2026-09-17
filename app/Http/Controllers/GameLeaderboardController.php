<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Requests\StoreGameLapRequest;
use App\Http\Requests\StoreGameRaceRequest;
use App\Services\Game\LeaderboardService;
use App\Services\Game\RaceLeaderboardService;
use App\Services\Game\WeekTrackResolver;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class GameLeaderboardController extends Controller
{
    public function __construct(
        private readonly LeaderboardService $leaderboard,
        private readonly RaceLeaderboardService $raceLeaderboard,
        private readonly WeekTrackResolver $weekTrack,
    ) {}

    /**
     * Лилавите рекорди + топ класация за пистата. Публично (без вход): гостите
     * виждат лилавите времена за сравнение, но не записват. За пистата на
     * уикенда идва и седмичната класация — тя се нулира всеки уикенд и дава
     * на всекиго шанс да е №1. `race_top` е отделната класация „Състезание".
     */
    public function show(Request $request, string $track): JsonResponse
    {
        abort_unless(array_key_exists($track, (array) config('game.tracks', [])), 404);

        $user = $request->user();

        $week = $this->weekTrack->resolve();
        $weekly = $week !== null && $week['slug'] === $track
            ? $this->leaderboard->topLaps($track, $user, 10, $week['week_start'])
            : null;

        return response()->json([
            'bests' => $this->leaderboard->bests($track),
            'top' => $this->leaderboard->topLaps($track, $user),
            'weekly' => $weekly,
            'race_top' => $this->raceLeaderboard->topRaces($track, $user),
            'user_bests' => $user !== null
                ? $this->leaderboard->userBests($user, $track)
                : ['lap_ms' => null, 'sectors_ms' => [null, null, null]],
            'user_race_best_ms' => $user !== null ? $this->raceLeaderboard->userBestMs($user, $track) : null,
            'authenticated' => $user !== null,
        ]);
    }

    /**
     * Сървърният дух на потребител за пистата — кадрите на най-добрата му
     * потвърдена обиколка, за дуелите „Карай срещу…". Публично: духът е
     * общностно съдържание, както класацията.
     */
    public function ghost(string $track, int $user): JsonResponse
    {
        abort_unless(array_key_exists($track, (array) config('game.tracks', [])), 404);

        $record = $this->leaderboard->ghostOf($user, $track);

        abort_if($record === null, 404);

        return response()->json([
            'v' => $record->sim_version,
            'lap_ms' => $record->lap_ms,
            'lap_ticks' => $record->lap_ticks,
            'frames' => $record->ghost_frames,
            'name' => $record->user->name,
        ]);
    }

    /**
     * Задочният съперник в състезание: кадрите на най-доброто потвърдено
     * състезание на потребителя от гасенето до флага. Публично, както духът
     * на обиколката.
     */
    public function raceGhost(string $track, int $user): JsonResponse
    {
        abort_unless(array_key_exists($track, (array) config('game.tracks', [])), 404);

        $record = $this->raceLeaderboard->ghostOf($user, $track);

        abort_if($record === null, 404);

        return response()->json([
            'v' => $record->sim_version,
            'rv' => $record->race_version,
            'race_ms' => $record->race_ms,
            'penalties' => $record->penalties,
            'total_ms' => $record->total_ms,
            'race_ticks' => $record->race_ticks,
            'frames' => $record->ghost_frames,
            'name' => $record->user->name,
        ]);
    }

    /**
     * Записва завършена квалификационна обиколка и връща какво е постигнала
     * (лилави полета, личен рекорд, позиция).
     */
    public function store(StoreGameLapRequest $request): JsonResponse
    {
        $data = $request->validated();

        /** @var array{0: int, 1: int, 2: int} $sectors */
        $sectors = array_map('intval', $data['sectors']);

        $result = $this->leaderboard->record(
            $request->user(),
            $data['track'],
            (int) $data['lap_ms'],
            $sectors,
            $data['trace'] ?? null,
            isset($data['sim_version']) ? (int) $data['sim_version'] : null,
        );

        return response()->json($result);
    }

    /**
     * Записва завършено състезание срещу ботовете (класация „Състезание") и
     * връща личния рекорд, позицията и обновената класация.
     */
    public function storeRace(StoreGameRaceRequest $request): JsonResponse
    {
        $data = $request->validated();

        return response()->json($this->raceLeaderboard->record(
            $request->user(),
            $data['track'],
            (int) $data['race_ms'],
            (int) $data['penalties'],
            (int) $data['position'],
            $data['trace'],
            (int) $data['sim_version'],
            (int) $data['race_version'],
        ));
    }
}
