<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Календарът вече се синхронизира от Jolpica два пъти на ден. Без този
     * флаг час, поправен на ръка преди Jolpica, щеше да се връща обратно
     * при следващото пускане — включително часът на квалификацията, от който
     * зависи заключването на прогнозите.
     */
    public function up(): void
    {
        Schema::table('races', function (Blueprint $table) {
            $table->boolean('manual_schedule')->default(false)->after('has_sprint');
        });
    }

    public function down(): void
    {
        Schema::table('races', function (Blueprint $table) {
            $table->dropColumn('manual_schedule');
        });
    }
};
