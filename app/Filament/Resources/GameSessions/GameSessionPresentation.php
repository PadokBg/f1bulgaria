<?php

declare(strict_types=1);

namespace App\Filament\Resources\GameSessions;

use App\Filament\Resources\GamePlayers\Tables\GamePlayersTable;
use App\Models\GameSession;
use Illuminate\Database\Eloquent\Model;

class GameSessionPresentation
{
    public const STATUS_LABELS = [
        'legacy' => 'Няма подробна история',
        'active' => 'Активно',
        'paused' => 'На пауза',
        'completed' => 'Завършено',
        'quit' => 'Изход към менюто',
        'restarted' => 'Рестартирано',
        'interrupted' => 'Прекъснато от браузъра',
        'error' => 'Техническа грешка',
    ];

    public const EVENT_LABELS = [
        'started' => 'Играта е стартирана',
        'moving' => 'Болидът потегля',
        'sector' => 'Навлизане в сектор',
        'lap_invalidated' => 'Обиколката е невалидна',
        'lap_completed' => 'Завършена обиколка',
        'race_completed' => 'Завършено състезание',
        'heartbeat' => 'Периодична проверка',
        'paused' => 'Пауза',
        'resumed' => 'Карането продължава',
        'quit' => 'Изход към менюто',
        'restarted' => 'Рестарт',
        'page_hidden' => 'Страницата е скрита',
        'page_left' => 'Напускане на страницата',
        'error' => 'Техническа грешка',
        'lap_submitted' => 'Резултат изпратен за класацията',
        'lap_save_failed' => 'Неуспешен запис за класацията',
    ];

    public static function status(GameSession $session): string
    {
        if (self::isStale($session)) {
            return 'Няма скорошни данни';
        }
        if ($session->status === 'completed') {
            return $session->mode === 'race' ? 'Завършено състезание' : 'Завършена соло обиколка';
        }

        return self::STATUS_LABELS[$session->status] ?? 'Неизвестно';
    }

    public static function isStale(GameSession $session): bool
    {
        return in_array($session->status, ['active', 'paused'], true)
            && ($session->last_seen_at === null || $session->last_seen_at->lt(now()->subMinutes(2)));
    }

    public static function statusColor(GameSession $session): string
    {
        if (self::isStale($session)) {
            return 'warning';
        }

        return match ($session->status) {
            'completed' => 'success',
            'active' => 'info',
            'error' => 'danger',
            'paused', 'interrupted' => 'warning',
            default => 'gray',
        };
    }

    public static function duration(?int $milliseconds): string
    {
        if ($milliseconds === null) {
            return 'Няма данни';
        }

        $seconds = (int) floor($milliseconds / 1000);

        return sprintf('%d:%02d', intdiv($seconds, 60), $seconds % 60);
    }

    public static function laps(GameSession $session): string
    {
        if ($session->status === 'legacy') {
            return 'Няма данни';
        }

        return "{$session->lap_count} общо · {$session->valid_lap_count} чисти · {$session->invalid_lap_count} невалидни";
    }

    public static function interpretation(GameSession $session): string
    {
        if ($session->status === 'legacy') {
            return 'Този запис е отпреди подробното отчитане. Знаем само, че играчът е стартирал. Нямаме данни дали е потеглил, завършил или се е отказал.';
        }
        if (self::isStale($session)) {
            return 'Няма получен краен сигнал и повече от 2 минути няма нови данни. Възможни са скрит раздел, затворен браузър или загубена връзка. Това не доказва отказване.';
        }

        return 'Обиколките включват чисти и невалидни финали в двата режима; в състезание първата (бойна) обиколка е без време. Загряващата обиколка в соло не е финал. Записът за класацията е отделно събитие и има собствена проверка. Времето е отчетено от браузъра и изключва отчетените паузи; неполучени събития не могат да бъдат възстановени.';
    }

    /** @return list<string> */
    public static function eventDetails(Model $event): array
    {
        $data = $event->data ?? [];
        $parts = [];
        if (isset($data['phase'])) {
            $parts[] = match ($data['phase']) {
                'formation' => 'Загряваща обиколка',
                'flying' => 'Хронометрирана обиколка',
                'finished' => 'Финиш',
                default => 'Неизвестна фаза',
            };
        }
        if (isset($data['sector'])) {
            $parts[] = 'Сектор '.$data['sector'];
        }
        if (isset($data['progress'])) {
            $parts[] = round((float) $data['progress'] * 100).'% от обиколката';
        }
        if (array_key_exists('lap_ms', $data) && $event->type === 'lap_completed') {
            $parts[] = $data['lap_ms'] === null ? 'Без време (бойна обиколка)' : 'Време '.GamePlayersTable::formatLap((int) $data['lap_ms']);
        } elseif (isset($data['lap_ms'])) {
            $parts[] = 'Време '.GamePlayersTable::formatLap((int) $data['lap_ms']);
        }
        if (array_key_exists('lap_valid', $data)) {
            $parts[] = $data['lap_valid'] ? 'Чиста обиколка' : 'Невалидна обиколка';
        }
        if (isset($data['race_position'])) {
            $parts[] = 'Позиция '.$data['race_position'];
        }
        if (isset($data['lap_number'])) {
            $parts[] = 'Завършени обиколки '.$data['lap_number'];
        }
        if (isset($data['speed'])) {
            $parts[] = round((float) $data['speed']).' км/ч';
        }
        if (isset($data['warnings']) && $data['warnings'] > 0) {
            $parts[] = 'Предупреждения '.$data['warnings'];
        }
        if (isset($data['save_status'])) {
            $parts[] = 'Класация: '.match ($data['save_status']) {
                'accepted' => 'приета', 'pending' => 'изпратена за проверка (резултатът е в класацията)', 'rejected' => 'отхвърлена', 'failure' => 'неуспешен запис',
                default => 'неизвестно',
            };
        }
        if (isset($data['error_code'])) {
            $parts[] = 'Код на грешката: '.$data['error_code'];
        }
        if (isset($data['frame_ms']) && $data['frame_ms'] > 0) {
            $parts[] = round(1000 / (float) $data['frame_ms'], 1).' кадъра/сек';
        }
        if (isset($data['render_scale'])) {
            $parts[] = 'Рендериране '.round((float) $data['render_scale'] * 100).'%';
        }
        if (isset($data['quality_tier'])) {
            $parts[] = 'Графика: '.self::qualityTier((string) $data['quality_tier']);
        }

        return $parts;
    }

    public static function qualityTier(string $value): string
    {
        return match ($value) {
            'low-power' => 'Икономичен режим', 'auto-full' => 'Автоматично / пълно качество',
            'auto-balanced' => 'Автоматично / балансирано', 'auto-safe' => 'Автоматично / намалено',
            'manual' => 'Ръчна настройка', default => 'Няма данни',
        };
    }

    /** @return list<array{label: string, value: string}> */
    public static function context(GameSession $session): array
    {
        $context = $session->context ?? [];
        $labels = [
            'controls' => 'Управление', 'graphics' => 'Избрана графика', 'transmission' => 'Скоростна кутия',
            'browser' => 'Браузър', 'os' => 'Операционна система',
            'viewport_width' => 'Ширина на екрана (CSS px)', 'viewport_height' => 'Височина на екрана (CSS px)',
            'pixel_ratio' => 'Плътност на екрана', 'sim_version' => 'Версия на симулацията',
        ];
        $values = [
            'buttons' => 'Сензорни бутони', 'tilt' => 'Накланяне на телефона', 'keyboard' => 'Клавиатура',
            'auto' => 'Автоматично', 'manual' => 'Ръчно', 'low' => 'Ниско', 'medium' => 'Средно', 'high' => 'Високо', 'ultra' => 'Ултра',
            'safari' => 'Safari', 'chrome' => 'Chrome', 'firefox' => 'Firefox', 'edge' => 'Edge', 'other' => 'Друг/неизвестен',
            'ios' => 'iOS', 'android' => 'Android', 'windows' => 'Windows', 'macos' => 'macOS', 'linux' => 'Linux',
        ];
        $rows = [];

        foreach ($labels as $key => $label) {
            $value = $context[$key] ?? null;
            if ($value === null || ! is_scalar($value)) {
                continue;
            }
            $rows[] = ['label' => $label, 'value' => $values[(string) $value] ?? (string) $value];
        }

        return $rows;
    }
}
