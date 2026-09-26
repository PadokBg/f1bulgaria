<?php

declare(strict_types=1);

namespace App\Models;

use App\Services\Races\RaceNameLocalizer;
use Database\Factories\RaceFactory;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\Relations\HasOne;

class Race extends Model
{
    /** @use HasFactory<RaceFactory> */
    use HasFactory;

    protected $fillable = [
        'season_id',
        'jolpica_id',
        'round',
        'name',
        'circuit',
        'country',
        'race_datetime_utc',
        'qualifying_datetime_utc',
        'sprint_datetime_utc',
        'has_sprint',
        'manual_schedule',
        'pole_driver_id',
        'had_safety_car',
    ];

    protected function casts(): array
    {
        return [
            'round' => 'integer',
            'race_datetime_utc' => 'datetime',
            'qualifying_datetime_utc' => 'datetime',
            'sprint_datetime_utc' => 'datetime',
            'has_sprint' => 'boolean',
            'manual_schedule' => 'boolean',
            'had_safety_car' => 'boolean',
        ];
    }

    /**
     * Българското име на Гран при-то, с падане към оригиналното.
     *
     * Съществува като АКСЕСОР, а не само в RaceResource: няколко места
     * (заглавие на страница, SEO описание, седмичният имейл) пишеха
     * `$race->name_bg ?? $race->name` и мълчаливо получаваха латиницата,
     * защото атрибут с това име нямаше.
     *
     * @return Attribute<string, never>
     */
    protected function nameBg(): Attribute
    {
        return Attribute::get(
            fn (): string => app(RaceNameLocalizer::class)->forRace($this),
        );
    }

    /** @return BelongsTo<Season, $this> */
    public function season(): BelongsTo
    {
        return $this->belongsTo(Season::class);
    }

    /** @return BelongsTo<Driver, $this> */
    public function poleDriver(): BelongsTo
    {
        return $this->belongsTo(Driver::class, 'pole_driver_id');
    }

    /** @return HasMany<RaceSession, $this> */
    public function sessions(): HasMany
    {
        return $this->hasMany(RaceSession::class);
    }

    /** @return HasMany<Result, $this> */
    public function results(): HasMany
    {
        return $this->hasMany(Result::class);
    }

    /**
     * Рекапът с данни от OpenF1 — един на състезание (виж App\Services\RaceData).
     *
     * @return HasOne<RaceDataRecap, $this>
     */
    public function dataRecap(): HasOne
    {
        return $this->hasOne(RaceDataRecap::class);
    }

    /** @return HasMany<Prediction, $this> */
    public function predictions(): HasMany
    {
        return $this->hasMany(Prediction::class);
    }

    public function hasFinished(): bool
    {
        return $this->results()->exists();
    }

    public function isUpcoming(): bool
    {
        return $this->race_datetime_utc !== null
            && $this->race_datetime_utc->isFuture();
    }
}
