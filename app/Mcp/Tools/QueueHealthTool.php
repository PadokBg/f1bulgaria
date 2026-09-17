<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Mcp\Concerns\FormatsSofiaTime;
use App\Services\Ops\QueueHealthInspector;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Отговаря на въпроса, който вече ни е струвал 13 дни без писма: дренира ли
 * се опашката. Приложението не вижда systemd, затова присъдата е по
 * най-старата готова задача — виж QueueHealthInspector::STALE_MINUTES.
 */
#[Name('queue-health')]
#[Description('Здраве на опашката (database driver): чакащи задачи, възраст на най-старата готова, провалени за 24 ч и общо, последните провалени с грешката им. Готова задача, чакаща над 15 мин = спрял worker (systemctl status padok-queue).')]
#[IsReadOnly]
#[IsIdempotent]
class QueueHealthTool extends Tool
{
    use FormatsSofiaTime;

    public function handle(Request $request, QueueHealthInspector $inspector): ResponseFactory
    {
        $now = CarbonImmutable::now();
        $snapshot = $inspector->inspect($now->subDay(), $now);

        if (! $snapshot['counts_from_database']) {
            return Response::structured([
                'driver' => $snapshot['driver'],
                'verdict' => "Драйверът е „{$snapshot['driver']}“, не database — опашката не се брои от базата.",
            ]);
        }

        $stale = $inspector->isStale($snapshot['oldest_minutes']);
        $failedTotal = DB::table('failed_jobs')->count();

        $verdict = match (true) {
            $stale => "ПРОБЛЕМ: най-старата готова задача чака {$snapshot['oldest_minutes']} мин — worker-ът най-вероятно е спрял. На сървъра: systemctl status padok-queue; при ударен лимит първо systemctl reset-failed padok-queue.",
            $snapshot['failed_in_window'] > 0 => "Опашката се дренира, но за 24 ч има {$snapshot['failed_in_window']} провалени задачи — виж списъка.",
            default => 'Опашката е здрава: нищо не чака над прага и няма провалени за 24 ч.',
        };

        return Response::structured([
            'checked_at' => $this->sofia($now),
            'driver' => $snapshot['driver'],
            'pending' => $snapshot['pending'],
            'oldest_ready_minutes' => $snapshot['oldest_minutes'],
            'stale_threshold_minutes' => QueueHealthInspector::STALE_MINUTES,
            'stale' => $stale,
            'failed_last_24h' => $snapshot['failed_in_window'],
            'failed_total' => $failedTotal,
            'recent_failures' => $inspector->recentFailures(),
            'verdict' => $verdict,
        ]);
    }
}
