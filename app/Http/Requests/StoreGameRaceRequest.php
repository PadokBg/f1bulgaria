<?php

declare(strict_types=1);

namespace App\Http\Requests;

use App\Services\Game\LeaderboardService;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class StoreGameRaceRequest extends FormRequest
{
    /** Максималната скорост на болида, m/s — същата като при обиколките. */
    private const MAX_SPEED = 92.0;

    public function authorize(): bool
    {
        return $this->user() !== null;
    }

    /**
     * Клиентът НЕ праща общото време: сървърът го смята от чистото време и
     * наказанията, а валидацията после го заменя с преиграното.
     *
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        $opponents = (int) config('game.race.opponents', 5);

        return [
            'track' => ['required', 'string', Rule::in(array_keys((array) config('game.tracks', [])))],
            // Таванът е 20-минутният запис на клиента (MAX_RACE_TICKS в race.js).
            'race_ms' => ['required', 'integer', 'min:30000', 'max:1200000'],
            'penalties' => ['required', 'integer', 'min:0', 'max:3000'],
            'position' => ['required', 'integer', 'min:1', 'max:'.($opponents + 1)],
            // 20 минути × 120 Hz × 2 байта в base64 ≈ 384 KB + JSON обвивката.
            'trace' => ['required', 'string', 'max:400000'],
            'sim_version' => ['required', 'integer', Rule::in([(int) config('game.sim_version', 3)])],
            'race_version' => ['required', 'integer', Rule::in([(int) config('game.race_version', 1)])],
        ];
    }

    public function withValidator(Validator $validator): void
    {
        $validator->after(function (Validator $validator): void {
            $raceMs = $this->input('race_ms');

            if (! is_numeric($raceMs)) {
                return;
            }

            // Под обиколки × дължина / максимална скорост е физически
            // невъзможно — базова защита, пълната е преиграването.
            $length = $this->trackLengthMeters((string) $this->input('track'));
            $laps = (int) config('game.race.total_laps', 3);

            if ($length !== null && (int) $raceMs < (int) floor($laps * $length / self::MAX_SPEED * 1000)) {
                $validator->errors()->add('race_ms', 'Времето е неправдоподобно бързо за тази писта.');
            }
        });
    }

    private function trackLengthMeters(string $slug): ?float
    {
        foreach (app(LeaderboardService::class)->trackIndex() as $track) {
            if (($track['slug'] ?? null) === $slug && isset($track['length'])) {
                return (float) $track['length'];
            }
        }

        return null;
    }
}
