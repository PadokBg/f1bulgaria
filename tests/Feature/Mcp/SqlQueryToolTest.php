<?php

declare(strict_types=1);

use App\Mcp\Servers\OpsReadServer;
use App\Mcp\Tools\SqlQueryTool;
use App\Models\User;
use App\Services\Ops\InvalidReadOnlyQuery;
use App\Services\Ops\ReadOnlyQueryRunner;
use Illuminate\Testing\Fluent\AssertableJson;

/*
 * sql-query в тестове върви през sqlite (OPS_QUERY_CONNECTION=sqlite в
 * phpunit.xml) — същата in-memory база като приложението. Твърдата гаранция
 * на прод е MySQL потребителят само със SELECT; тук се проверява вторият
 * пояс (текстови проверки, транзакция, лимити, режене на колони).
 */

beforeEach(function () {
    $this->admin = User::factory()->create(['is_admin' => true, 'name' => 'Админ']);
});

it('изпълнява SELECT и връща колони и редове', function () {
    User::factory()->create(['name' => 'Фен', 'email' => 'fen@example.bg']);

    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => "SELECT name, email FROM users WHERE email = 'fen@example.bg';"])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('connection', 'sqlite')
            ->where('columns', ['name', 'email'])
            ->where('row_count', 1)
            ->where('truncated', false)
            ->where('rows.0.name', 'Фен')
            ->etc());
});

it('реже чувствителните колони дори при SELECT *', function () {
    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => 'SELECT * FROM users'])
        ->assertOk()
        ->assertStructuredContent(function (AssertableJson $json): void {
            $json->where('row_count', 1)
                ->where('columns', fn ($columns) => ! in_array('password', $columns->all(), true)
                    && ! in_array('remember_token', $columns->all(), true)
                    && in_array('email', $columns->all(), true))
                ->missing('rows.0.password')
                ->missing('rows.0.remember_token')
                ->etc();
        });
});

it('ограничава броя редове и го казва', function () {
    config(['ops.mcp.query_max_rows' => 2]);
    User::factory()->count(3)->create();

    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => 'SELECT id FROM users ORDER BY id'])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json
            ->where('row_count', 2)
            ->where('truncated', true)
            ->where('note', fn (string $note) => str_contains($note, 'таван 2'))
            ->etc());
});

it('отказва всичко, което не е четене', function (string $sql) {
    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => $sql])
        ->assertHasErrors();
})->with([
    'update' => ["UPDATE users SET name = 'x'"],
    'delete' => ['DELETE FROM users'],
    'insert' => ["INSERT INTO users (name) VALUES ('x')"],
    'drop' => ['DROP TABLE users'],
    'multi-statement' => ['SELECT 1; DELETE FROM users'],
    'comment-hidden write' => ["-- hi\nDELETE FROM users"],
    'outfile' => ["SELECT * FROM users INTO OUTFILE '/tmp/x'"],
    'sessions table' => ['SELECT * FROM sessions'],
    'tokens table' => ['SELECT token FROM personal_access_tokens'],
    'empty' => ['   '],
]);

it('отказва чувствителни колони и под псевдоним или в израз', function (string $sql) {
    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => $sql])
        ->assertHasErrors();
})->with([
    'alias' => ['SELECT password AS p FROM users'],
    'expression' => ['SELECT substr(password, 1, 20) FROM users'],
    'remember token' => ['SELECT remember_token AS r FROM users'],
    'unsubscribe token' => ['SELECT unsubscribe_token AS t FROM newsletter_subscribers'],
    'quoted identifier' => ['SELECT "password" FROM users'],
]);

it('изпълнява заявката както е — JOIN със * , краен коментар и изричен LIMIT', function () {
    User::factory()->count(3)->create();

    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => 'SELECT * FROM users u JOIN users v ON v.id = u.id'])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json->where('row_count', 4)->etc());

    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => 'SELECT COUNT(*) AS n FROM users -- колко са'])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json->where('rows.0.n', 4)->etc());

    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => 'SELECT id FROM users ORDER BY id LIMIT 2'])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json->where('row_count', 2)->where('truncated', false)->etc());
});

it('не променя базата дори когато проверката на текста бъде заобиколена', function () {
    $runner = app(ReadOnlyQueryRunner::class);
    $before = User::count();

    // Хвърля InvalidReadOnlyQuery още на проверката — писането не стига до базата.
    expect(fn () => $runner->run('DELETE FROM users'))->toThrow(InvalidReadOnlyQuery::class)
        ->and(User::count())->toBe($before);
});

it('не блокира таблици, чието име само съдържа забранено (race_sessions)', function () {
    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => 'SELECT COUNT(*) AS n FROM race_sessions'])
        ->assertOk()
        ->assertStructuredContent(fn (AssertableJson $json) => $json->where('rows.0.n', 0)->etc());
});

it('връща SQL грешката на клиента вместо да гърми', function () {
    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => 'SELECT * FROM nyama_takava_tablica'])
        ->assertHasErrors();
});

it('не се регистрира без конфигурирана read-only връзка', function () {
    config(['ops.mcp.query_connection' => 'mysql_readonly', 'database.connections.mysql_readonly.username' => null]);

    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => 'SELECT 1'])
        ->assertNotRegistered();

    config(['ops.mcp.query_connection' => 'nyama_takava']);

    OpsReadServer::actingAs($this->admin)
        ->tool(SqlQueryTool::class, ['sql' => 'SELECT 1'])
        ->assertNotRegistered();
});
