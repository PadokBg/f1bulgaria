<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Services\Game\GameFeedbackService;
use App\Services\Game\WeekTrackResolver;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Inertia\Inertia;
use Inertia\Response;

class GameController extends Controller
{
    public function __construct(private readonly WeekTrackResolver $weekTrack) {}

    /**
     * Каталогът на пистите се генерира от `php artisan game:generate-tracks`.
     *
     * Самите точки на трасето НЕ минават през Inertia — те са стотици
     * килобайта и клиентът ги тегли директно от public/, само за избраната
     * писта.
     */
    public function index(Request $request, GameFeedbackService $feedback): Response
    {
        // Кой влиза (вкл. гости) се брои от клиента — POST /game/visit при
        // mount; тук hover prefetch-ът на менюто е неразличим от истинско влизане.
        return Inertia::render('Game/Index', [
            'tracks' => $this->tracks(),
            'weekTrack' => $this->weekTrack->slug(),
            'gameFeedback' => $feedback->prompt($request->user()),
            // Версиите идват от сървъра, а не от import на sim.js: заделеният
            // бег на гост се проверява още в лобито, а физиката се зарежда
            // чак когато човек натисне „Карай".
            'simVersion' => (int) config('game.sim_version', 3),
            'raceVersion' => (int) config('game.race_version', 2),
        ]);
    }

    /**
     * @return array<int, array{slug: string, name: string, location: string, length: float}>
     */
    private function tracks(): array
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
}
