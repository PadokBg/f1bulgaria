<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Models\Race;
use App\Services\Predictions\LivePredictionService;
use Illuminate\Http\JsonResponse;

class LivePredictionController extends Controller
{
    /**
     * Временното класиране на прогнозите, докато състезанието тече.
     *
     * Публично и без вход: панелът е общата гледка към неделята, а не личен
     * резултат. `live` е null извън ефир — клиентът тогава просто не показва
     * нищо и спира да пита.
     */
    public function show(Race $race, LivePredictionService $live): JsonResponse
    {
        return response()->json(['live' => $live->standings($race)]);
    }
}
