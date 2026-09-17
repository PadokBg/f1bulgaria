<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Одит лог на MCP инструментите — кой, кога, кой инструмент и с какви
     * аргументи е извикал през /mcp/ops. Append-only, по образеца на
     * auth_events; чете се и през самия sql-query инструмент.
     */
    public function up(): void
    {
        Schema::create('mcp_tool_calls', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->nullable()->constrained()->nullOnDelete();
            $table->string('token_name')->nullable();       // името от padok:mcp-token
            $table->string('server', 40)->index();          // ops-read | (бъдещ write)
            $table->string('tool')->index();                // sql-query, queue-health, ...
            $table->json('arguments')->nullable();
            $table->unsignedSmallInteger('status')->nullable();  // HTTP статус на отговора
            // Отказ на ниво инструмент (isError в JSON-RPC резултата) е HTTP 200 —
            // без тези две колони отхвърлен DELETE изглежда като успешен SELECT.
            $table->boolean('is_error')->default(false);
            $table->string('error', 500)->nullable();
            $table->unsignedInteger('duration_ms')->nullable();
            $table->string('ip_address', 45)->nullable();   // IPv4/IPv6
            $table->timestamps();
            $table->index('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('mcp_tool_calls');
    }
};
