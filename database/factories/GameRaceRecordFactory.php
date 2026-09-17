<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Models\GameRaceRecord;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<GameRaceRecord>
 */
class GameRaceRecordFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $raceMs = fake()->numberBetween(300000, 420000);
        $penalties = fake()->numberBetween(0, 2);

        return [
            'user_id' => User::factory(),
            'track_slug' => 'monza',
            'race_ms' => $raceMs,
            'penalties' => $penalties,
            'total_ms' => $raceMs + $penalties * 5000,
            'position' => fake()->numberBetween(1, 6),
            'input_trace' => '{"v":3,"rv":1,"opponents":5,"inputs":"AAAA"}',
            'sim_version' => (int) config('game.sim_version', 3),
            'race_version' => (int) config('game.race_version', 1),
            'verify_status' => 'verified',
        ];
    }
}
