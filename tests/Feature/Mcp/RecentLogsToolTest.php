<?php

declare(strict_types=1);

use App\Mcp\Servers\OpsReadServer;
use App\Mcp\Tools\RecentLogsTool;
use App\Models\User;
use App\Services\Ops\LogTail;
use Illuminate\Support\Facades\File;
use Illuminate\Testing\Fluent\AssertableJson;

/*
 * recent-logs чете от storage/logs, затова тестовете пренасочват storage
 * към временна папка и пишат свои файлове — реалният laravel.log на
 * машината не се пипа и не се чете.
 */

beforeEach(function () {
    $this->admin = User::factory()->create(['is_admin' => true]);

    $this->storage = sys_get_temp_dir().DIRECTORY_SEPARATOR.'padok-mcp-logs-'.uniqid();
    File::makeDirectory($this->storage.DIRECTORY_SEPARATOR.'logs', 0777, true);
    app()->useStoragePath($this->storage);

    config([
        'logging.default' => 'stack',
        'logging.channels.stack.channels' => ['single'],
        'logging.channels.single.path' => $this->storage.'/logs/laravel.log',
        'logging.channels.daily.path' => $this->storage.'/logs/laravel.log',
    ]);
});

afterEach(function () {
    File::deleteDirectory($this->storage);
});

function writeLog(string $file, string $content): void
{
    File::put(test()->storage."/logs/{$file}", $content);
}

it('връща последните записи от Laravel лога, групирани със stack trace-а', function () {
    writeLog('laravel.log', implode("\n", [
        '[2026-09-17 09:00:00] production.INFO: първи запис',
        '[2026-09-17 09:05:00] production.ERROR: гръмна нещо {"exception":"[object] (RuntimeException)"}',
        '[stacktrace]',
        '#0 /var/www/f1bulgaria/app/Foo.php(12): bar()',
        '#1 {main}',
        '[2026-09-17 09:10:00] production.WARNING: последен запис',
    ])."\n");

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentLogsTool::class, ['lines' => 100])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('source', 'laravel')
            ->where('file', 'laravel.log')
            ->where('lines_read', 6)
            ->count('entries', 3)
            ->where('entries.1', fn (string $entry) => str_contains($entry, 'гръмна нещо') && str_contains($entry, '#1 {main}'))
            ->where('entries.2', '[2026-09-17 09:10:00] production.WARNING: последен запис')
            ->etc());
});

it('филтрира Laravel лога по ниво', function () {
    writeLog('laravel.log', implode("\n", [
        '[2026-09-17 09:00:00] production.INFO: инфо',
        '[2026-09-17 09:05:00] production.ERROR: грешка едно',
        'продължение на грешката',
        '[2026-09-17 09:10:00] production.ERROR: грешка две',
        '[2026-09-17 09:15:00] production.INFO: пак инфо',
    ])."\n");

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentLogsTool::class, ['level' => 'error'])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('level', 'error')
            ->count('entries', 2)
            ->where('entries.0', "[2026-09-17 09:05:00] production.ERROR: грешка едно\nпродължение на грешката")
            ->etc());
});

it('чете само поисканите редове от края на голям файл', function () {
    $lines = [];

    foreach (range(1, 5000) as $i) {
        $lines[] = "[2026-09-17 09:00:00] production.INFO: ред {$i} ".str_repeat('x', 100);
    }

    writeLog('laravel.log', implode("\n", $lines)."\n");

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentLogsTool::class, ['lines' => 3])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('lines_read', 3)
            ->count('entries', 3)
            ->where('entries.0', fn (string $entry) => str_starts_with($entry, '[2026-09-17 09:00:00] production.INFO: ред 4998 '))
            ->etc());
});

it('намира днешния файл при daily канал', function () {
    $this->travelTo(now()->setDate(2026, 9, 17));
    config(['logging.channels.stack.channels' => ['daily']]);

    writeLog('laravel-2026-09-16.log', "[2026-09-16 09:00:00] production.INFO: вчера\n");
    writeLog('laravel-2026-09-17.log', "[2026-09-17 09:00:00] production.INFO: днес\n");

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentLogsTool::class)
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('file', 'laravel-2026-09-17.log')
            ->where('entries.0', '[2026-09-17 09:00:00] production.INFO: днес')
            ->etc());
});

it('пада към най-новия laravel*.log, когато конфигурираният файл липсва', function () {
    config(['logging.channels.stack.channels' => ['daily']]);

    writeLog('laravel-2026-09-10.log', "[2026-09-10 09:00:00] production.INFO: стар\n");

    expect(app(LogTail::class)->resolvePath('laravel'))->toEndWith('laravel-2026-09-10.log');
});

it('чете scheduler.log като суров текст без филтър по ниво', function () {
    writeLog('scheduler.log', "Синхронизирани 3 сесии\nГотово\n");

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentLogsTool::class, ['source' => 'scheduler', 'level' => 'error'])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('source', 'scheduler')
            ->where('level', null)
            ->where('entries', ['Синхронизирани 3 сесии', 'Готово'])
            ->etc());
});

it('обяснява липсващ лог файл и отхвърля невалидни аргументи', function () {
    OpsReadServer::actingAs($this->admin)
        ->tool(RecentLogsTool::class, ['source' => 'ssr'])
        ->assertHasErrors();

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentLogsTool::class, ['source' => 'nginx'])
        ->assertHasErrors();

    OpsReadServer::actingAs($this->admin)
        ->tool(RecentLogsTool::class, ['lines' => 100000])
        ->assertHasErrors();
});
