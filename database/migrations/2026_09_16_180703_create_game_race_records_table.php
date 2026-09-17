<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Завършени състезания срещу ботовете — отделна класация от обиколките
     * „Сам на пистата". Подрежда се по total_ms = чисто време + наказанията
     * за излизане. Валидацията е като на обиколките: опашката преиграва
     * записа на входа през същата симулация (scripts/game/validate-race.mjs).
     *
     *   verify_status: pending   — чака преиграване
     *                  verified  — възпроизведено; времената са преиграните
     *                  rejected  — НЕ се възпроизвежда → вън от класацията
     *                  error     — инфраструктурен проблем (брои се)
     *
     * position е окончателната позиция от преиграването (полето доизкарва след
     * флага), а ghost_frames — кадрите на играча от гасенето до флага: задочен
     * съперник в чужди състезания. Пазят се само за най-доброто състезание на
     * потребителя на пистата (job-ът чисти останалите).
     */
    public function up(): void
    {
        Schema::create('game_race_records', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('track_slug', 64);
            $table->unsignedInteger('race_ms');
            $table->unsignedSmallInteger('penalties');
            $table->unsignedInteger('total_ms');
            $table->unsignedTinyInteger('position');
            $table->mediumText('input_trace');
            $table->unsignedSmallInteger('sim_version');
            $table->unsignedSmallInteger('race_version');
            $table->string('verify_status', 16)->index();
            $table->unsignedInteger('verified_total_ms')->nullable();
            $table->mediumText('ghost_frames')->nullable();
            $table->unsignedInteger('race_ticks')->nullable();
            $table->timestamps();

            $table->index(['sim_version', 'race_version', 'track_slug', 'total_ms'], 'game_races_versions_track_total_index');
            $table->index(['track_slug', 'user_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('game_race_records');
    }
};
