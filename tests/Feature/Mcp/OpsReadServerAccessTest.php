<?php

declare(strict_types=1);

use App\Enums\McpAbility;
use App\Models\McpToolCall;
use App\Models\User;
use Illuminate\Testing\TestResponse;

/*
 * Границата на достъпа до /mcp/ops: само Bearer токен на действащ админ с
 * ability mcp:ops-read минава. Сесията НЕ е достатъчна — отворен таб на
 * сайта не бива да е MCP достъп.
 */

/** JSON-RPC заявка към сървъра с (или без) Bearer токен. */
function mcpPost(string $method, array $params = [], ?string $token = null): TestResponse
{
    $headers = ['Accept' => 'application/json, text/event-stream'];

    if ($token !== null) {
        $headers['Authorization'] = "Bearer {$token}";
    }

    return test()->withHeaders($headers)->postJson('/mcp/ops', [
        'jsonrpc' => '2.0',
        'id' => 1,
        'method' => $method,
        'params' => $params,
    ]);
}

function opsToken(User $user, array $abilities = [McpAbility::OpsRead->value]): string
{
    return $user->createToken('test', $abilities)->plainTextToken;
}

it('връща 404 при изключен feature флаг за всички глаголи', function () {
    config(['features.mcp_ops' => false]);

    $admin = User::factory()->create(['is_admin' => true]);

    mcpPost('tools/list', token: opsToken($admin))->assertNotFound();

    // Mcp::web() регистрира и GET/DELETE (405 Allow: POST) — и те не бива да
    // издават, че рутът съществува.
    $this->get('/mcp/ops')->assertNotFound();
    $this->delete('/mcp/ops')->assertNotFound();

    // Заявка по новия протокол без MCP-Protocol-Version хедър: флагът трябва
    // да е ПРЕДИ валидацията на хедърите на пакета (иначе 400 вместо 404).
    $this->withHeaders(['Accept' => 'application/json, text/event-stream'])
        ->postJson('/mcp/ops', [
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'tools/list',
            'params' => ['_meta' => ['io.modelcontextprotocol/protocolVersion' => '2026-07-28']],
        ])
        ->assertNotFound();
});

it('не споделя mcp_ops флага с Inertia страниците', function () {
    $this->get('/')->assertInertia(fn ($page) => $page->missing('features.mcp_ops')->etc());
});

it('връща 401 без токен', function () {
    mcpPost('tools/list')->assertUnauthorized();
});

it('връща 401 при невалиден токен', function () {
    mcpPost('tools/list', token: 'nyama-takav-token')->assertUnauthorized();
});

it('връща 401 за изтекъл токен', function () {
    $admin = User::factory()->create(['is_admin' => true]);
    $token = $admin->createToken('test', [McpAbility::OpsRead->value], now()->subMinute())->plainTextToken;

    mcpPost('tools/list', token: $token)->assertUnauthorized();
});

it('не пуска логната сесия без токен', function () {
    $admin = User::factory()->create(['is_admin' => true]);

    $this->actingAs($admin);

    mcpPost('tools/list')->assertForbidden();
});

it('връща 403 за токен на обикновен потребител', function () {
    $user = User::factory()->create(['is_admin' => false]);

    mcpPost('tools/list', token: opsToken($user))->assertForbidden();
});

it('връща 403 за админ токен без нужната ability', function () {
    $admin = User::factory()->create(['is_admin' => true]);

    mcpPost('tools/list', token: opsToken($admin, ['nyama:takava']))->assertForbidden();
});

it('връща 403 за блокиран админ дори с валиден токен', function () {
    $admin = User::factory()->create(['is_admin' => true]);
    $token = opsToken($admin);

    $admin->update(['banned_at' => now()]);

    mcpPost('tools/list', token: $token)->assertForbidden();
});

it('връща 403, когато админ правата са свалени след издаването на токена', function () {
    $admin = User::factory()->create(['is_admin' => true]);
    $token = opsToken($admin);

    $admin->update(['is_admin' => false]);

    mcpPost('tools/list', token: $token)->assertForbidden();
});

it('изброява read-only инструментите за действащ админ с токен', function () {
    $admin = User::factory()->create(['is_admin' => true]);

    $response = mcpPost('tools/list', token: opsToken($admin))->assertOk();

    $names = collect($response->json('result.tools'))->pluck('name')->all();

    expect($names)->toContain('site-overview', 'recent-users', 'queue-health', 'recent-logs', 'race-predictions', 'league-standings', 'sql-query');

    // Всеки инструмент е обявен като read-only към клиента.
    foreach ($response->json('result.tools') as $tool) {
        expect($tool['annotations']['readOnlyHint'] ?? null)->toBeTrue("{$tool['name']} не е readOnly");
    }
});

it('записва всяко извикване на инструмент в одит лога', function () {
    $admin = User::factory()->create(['is_admin' => true]);
    $token = $admin->createToken('claude-code', [McpAbility::OpsRead->value])->plainTextToken;

    mcpPost('tools/list', token: $token)->assertOk();

    expect(McpToolCall::count())->toBe(0);

    mcpPost('tools/call', ['name' => 'recent-users', 'arguments' => ['limit' => 3]], $token)->assertOk();

    $call = McpToolCall::sole();

    expect($call->user_id)->toBe($admin->id)
        ->and($call->token_name)->toBe('claude-code')
        ->and($call->server)->toBe('ops-read')
        ->and($call->tool)->toBe('recent-users')
        ->and($call->arguments)->toBe(['limit' => 3])
        ->and($call->status)->toBe(200)
        ->and($call->duration_ms)->toBeGreaterThanOrEqual(0)
        ->and($call->ip_address)->not->toBeNull();
});

it('отбелязва отказ на ниво инструмент в одит лога, макар HTTP статусът да е 200', function () {
    $admin = User::factory()->create(['is_admin' => true]);

    mcpPost('tools/call', ['name' => 'sql-query', 'arguments' => ['sql' => 'DELETE FROM users']], opsToken($admin))
        ->assertOk()
        ->assertJsonPath('result.isError', true);

    $call = McpToolCall::sole();

    expect($call->status)->toBe(200)
        ->and($call->is_error)->toBeTrue()
        ->and($call->error)->toContain('само за четене');

    mcpPost('tools/call', ['name' => 'sql-query', 'arguments' => ['sql' => 'SELECT 1 AS one']], opsToken($admin))->assertOk();

    expect(McpToolCall::latest('id')->first()->is_error)->toBeFalse();
});

it('реже прекалено дълги аргументи в одит лога', function () {
    $admin = User::factory()->create(['is_admin' => true]);
    $sql = 'SELECT '.str_repeat('1, ', 1500).'1';

    mcpPost('tools/call', ['name' => 'sql-query', 'arguments' => ['sql' => $sql]], opsToken($admin))->assertOk();

    expect(mb_strlen((string) McpToolCall::sole()->arguments['sql']))->toBeLessThanOrEqual(2001);
});

it('ограничава заявките по потребител с именувана throttle кофа', function () {
    $admin = User::factory()->create(['is_admin' => true]);
    $token = opsToken($admin);

    foreach (range(1, 60) as $i) {
        mcpPost('tools/list', token: $token)->assertOk();
    }

    mcpPost('tools/list', token: $token)->assertTooManyRequests();
});
