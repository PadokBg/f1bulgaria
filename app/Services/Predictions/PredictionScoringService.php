<?php

declare(strict_types=1);

namespace App\Services\Predictions;

use App\Enums\ResultSessionType;
use App\Models\Prediction;
use App\Models\Race;
use Illuminate\Support\Facades\DB;

/**
 * Точкува прогнозите за дадено състезание спрямо реалните резултати.
 * Идемпотентен — повторно изпълнение преизчислява и обновява точките.
 */
class PredictionScoringService
{
    /**
     * Точкува всички прогнози за състезанието. Връща броя точкувани прогнози.
     */
    public function scoreRace(Race $race): int
    {
        $actual = $this->resolveActuals($race);

        if ($actual === null) {
            return 0;
        }

        $predictions = $race->predictions()->get();
        $scored = 0;

        DB::transaction(function () use ($predictions, $actual, &$scored) {
            foreach ($predictions as $prediction) {
                $breakdown = $this->scorePrediction($prediction, $actual);

                $prediction->score()->updateOrCreate(
                    [],
                    [
                        'points' => array_sum($breakdown),
                        'breakdown_json' => $breakdown,
                    ],
                );

                $scored++;
            }
        });

        return $scored;
    }

    /**
     * Точкува една прогноза спрямо подадените резултати.
     *
     * Публичен, защото същите правила се ползват и от точкуването на живо
     * (LivePredictionService) — там резултатите са частични и идват от OpenF1
     * вместо от базата. Неизвестна стойност се подава като null и носи 0
     * точки, вместо да се брои за сгрешена.
     *
     * @param  array{p1:?int,p2:?int,p3:?int,podium:array<int,int>,pole:?int,fastest_lap:?int,dnf_count:?int,safety_car:?bool}  $actual
     * @return array<string, int>
     */
    public function scorePrediction(Prediction $prediction, array $actual): array
    {
        /** @var array<string, array<string,int>|int> $rules */
        $rules = config('predictions.scoring');
        $breakdown = [];

        // Подиум — точна позиция или частична точка за "в топ 3".
        foreach (['p1', 'p2', 'p3'] as $slot) {
            $predicted = $prediction->{"{$slot}_driver_id"};
            $breakdown[$slot] = 0;

            if ($predicted === null) {
                continue;
            }

            if ($predicted === $actual[$slot]) {
                $breakdown[$slot] = $rules['exact'][$slot];
            } elseif (in_array($predicted, $actual['podium'], true)) {
                $breakdown[$slot] = $rules['podium_partial'];
            }
        }

        // Pole.
        $breakdown['pole'] = ($prediction->pole_driver_id !== null
            && $prediction->pole_driver_id === $actual['pole'])
            ? $rules['pole'] : 0;

        // Най-бърза обиколка.
        $breakdown['fastest_lap'] = ($prediction->fastest_lap_driver_id !== null
            && $prediction->fastest_lap_driver_id === $actual['fastest_lap'])
            ? $rules['fastest_lap'] : 0;

        // Брой DNF. Неподаден отговор е null, не 0 — без тази проверка
        // празното поле щеше да носи точки при състезание без отпаднали.
        $breakdown['dnf'] = 0;

        // На живо броят отпаднали още не е окончателен и идва като null —
        // тогава категорията просто мълчи вместо да наказва.
        if ($prediction->dnf_count !== null && $actual['dnf_count'] !== null) {
            $dnfDiff = abs($prediction->dnf_count - $actual['dnf_count']);
            $breakdown['dnf'] = match (true) {
                $dnfDiff === 0 => $rules['dnf_exact'],
                $dnfDiff === 1 => $rules['dnf_close'],
                default => 0,
            };
        }

        // Safety car — само ако и прогнозата, и реалният резултат са известни.
        $breakdown['safety_car'] = ($prediction->safety_car !== null
            && $actual['safety_car'] !== null
            && $prediction->safety_car === $actual['safety_car'])
            ? $rules['safety_car'] : 0;

        return $breakdown;
    }

    /**
     * Извлича реалните резултати за състезанието. Връща null ако още няма резултати.
     *
     * @return array{p1:?int,p2:?int,p3:?int,podium:array<int,int>,pole:?int,fastest_lap:?int,dnf_count:int,safety_car:?bool}|null
     */
    private function resolveActuals(Race $race): ?array
    {
        // Прогнозите се отнасят за ГЛАВНОТО състезание, не за спринта.
        $results = $race->results()
            ->where('session_type', ResultSessionType::Race->value)
            ->get();

        if ($results->isEmpty()) {
            return null;
        }

        $byPosition = $results->whereNotNull('position')->keyBy('position');
        $podium = $results->whereNotNull('position')
            ->whereBetween('position', [1, 3])
            ->pluck('driver_id')
            ->all();

        $fastestLap = $results->firstWhere('fastest_lap', true);

        return [
            'p1' => $byPosition->get(1)?->driver_id,
            'p2' => $byPosition->get(2)?->driver_id,
            'p3' => $byPosition->get(3)?->driver_id,
            'podium' => $podium,
            'pole' => $race->pole_driver_id,
            'fastest_lap' => $fastestLap?->driver_id,
            'dnf_count' => $results->where('dnf', true)->count(),
            'safety_car' => $race->had_safety_car,
        ];
    }
}
