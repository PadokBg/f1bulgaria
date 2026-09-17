<?php

declare(strict_types=1);

namespace App\Models;

use Database\Factories\GameRaceRecordFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class GameRaceRecord extends Model
{
    /** @use HasFactory<GameRaceRecordFactory> */
    use HasFactory;

    /** @var list<string> */
    protected $fillable = [
        'user_id',
        'track_slug',
        'race_ms',
        'penalties',
        'total_ms',
        'position',
        'input_trace',
        'sim_version',
        'race_version',
        'verify_status',
        'verified_total_ms',
        'ghost_frames',
        'race_ticks',
    ];

    /** @var list<string> */
    protected $hidden = ['input_trace', 'ghost_frames'];

    /** @return array<string, string> */
    protected function casts(): array
    {
        return [
            'race_ms' => 'integer',
            'penalties' => 'integer',
            'total_ms' => 'integer',
            'position' => 'integer',
            'sim_version' => 'integer',
            'race_version' => 'integer',
            'verified_total_ms' => 'integer',
            'race_ticks' => 'integer',
        ];
    }

    /**
     * Състезанията, които се броят в класацията: текущите версии на
     * симулацията и правилата, без отхвърлените от преиграването. pending и
     * error остават — не наказваме никого без доказателство.
     *
     * @param  Builder<GameRaceRecord>  $query
     * @return Builder<GameRaceRecord>
     */
    public function scopeCounted(Builder $query): Builder
    {
        return $query
            ->where($query->qualifyColumn('sim_version'), (int) config('game.sim_version', 3))
            ->where($query->qualifyColumn('race_version'), (int) config('game.race_version', 1))
            ->where($query->qualifyColumn('verify_status'), '!=', 'rejected');
    }

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
