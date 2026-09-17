<?php

declare(strict_types=1);

namespace App\Models;

use Database\Factories\GameSessionEventFactory;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Prunable;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class GameSessionEvent extends Model
{
    /** @use HasFactory<GameSessionEventFactory> */
    use HasFactory, Prunable;

    /**
     * Суровата хронология е за разследване „защо не тръгна / защо се отказа",
     * не архив: heartbeat на 20 s е ~180 реда на час игра. Агрегатите остават
     * в game_sessions завинаги; събитията се трият след толкова дни
     * (model:prune в routes/console.php). Обещано и в политиката за поверителност.
     */
    public const RETENTION_DAYS = 90;

    public $timestamps = false;

    public const LABELS = [
        'started' => 'Начало на карането',
        'moving' => 'Потегляне',
        'sector' => 'Навлизане в сектор',
        'lap_invalidated' => 'Невалидна обиколка',
        'lap_completed' => 'Завършена обиколка',
        'race_completed' => 'Завършено състезание',
        'heartbeat' => 'Периодичен отчет',
        'paused' => 'Пауза',
        'resumed' => 'Продължаване',
        'quit' => 'Натиснат изход',
        'restarted' => 'Рестарт',
        'page_hidden' => 'Скрит раздел',
        'page_left' => 'Напусната страница',
        'error' => 'Техническа грешка',
        'lap_submitted' => 'Резултат изпратен за класация',
        'lap_save_failed' => 'Проблем при запис за класация',
    ];

    protected $fillable = ['game_session_id', 'sequence', 'type', 'active_ms', 'data', 'received_at'];

    protected function casts(): array
    {
        return ['sequence' => 'integer', 'active_ms' => 'integer', 'data' => 'array', 'received_at' => 'datetime'];
    }

    /** @return Builder<static> */
    public function prunable(): Builder
    {
        return static::query()->where('received_at', '<', now()->subDays(self::RETENTION_DAYS));
    }

    /** @return BelongsTo<GameSession, $this> */
    public function gameSession(): BelongsTo
    {
        return $this->belongsTo(GameSession::class);
    }
}
