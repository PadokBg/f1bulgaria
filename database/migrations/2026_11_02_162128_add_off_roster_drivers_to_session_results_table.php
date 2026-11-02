<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Пилоти извън ростъра в класациите от сесиите.
 *
 * Във FP1 отборите пускат новаци (Цолов в Мексико 2026), които ги няма в
 * `drivers`. Досега синхронът ги прескачаше и класацията излизаше с дупки:
 * 1, 2, 4, 6… Да ги добавим в `drivers` не става — тази таблица е ростърът на
 * лигата: формата за прогноза и валидацията ѝ приемат всеки пилот от сезона,
 * а /drivers ги изброява всичките.
 *
 * Затова редът носи сам кой е карал: номер, име и отбор, както ги дава
 * OpenF1. `driver_id` остава за пилотите от ростъра и е null за останалите.
 *
 * Уникалността по номер покрива редовете без пилот. И двата unique индекса
 * допускат много NULL-и, така че квалификацията от Jolpica (без номер) и
 * пилотите извън ростъра (без driver_id) не си пречат.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('session_results', function (Blueprint $table) {
            $table->unsignedBigInteger('driver_id')->nullable()->change();

            $table->unsignedTinyInteger('driver_number')->nullable()->after('driver_id');
            $table->string('driver_name', 100)->nullable()->after('driver_number'); // „Nikola Tsolov"
            $table->string('team_name', 100)->nullable()->after('driver_name');

            $table->unique(['race_id', 'session_type', 'driver_number'], 'session_results_number_unique');
        });
    }

    public function down(): void
    {
        // Без пилот такъв ред няма как да съществува в старата схема.
        DB::table('session_results')->whereNull('driver_id')->delete();

        // NOT NULL е единствената стъпка, която може да гръмне (ако синхронът
        // е вкарал нов ред без пилот междувременно). Затова е първа: DDL в
        // MySQL не е транзакционен и ако се провали след изтритите колони,
        // схемата остава наполовина върната. Така връщането просто се пуска пак.
        Schema::table('session_results', function (Blueprint $table) {
            $table->unsignedBigInteger('driver_id')->nullable(false)->change();
        });

        Schema::table('session_results', function (Blueprint $table) {
            $table->dropUnique('session_results_number_unique');
        });

        Schema::table('session_results', function (Blueprint $table) {
            $table->dropColumn(['driver_number', 'driver_name', 'team_name']);
        });
    }
};
