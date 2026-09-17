<?php

declare(strict_types=1);

namespace App\Mcp\Tools;

use App\Services\Ops\InvalidReadOnlyQuery;
use App\Services\Ops\ReadOnlyQueryRunner;
use Illuminate\Contracts\JsonSchema\JsonSchema;
use Illuminate\Database\QueryException;
use Illuminate\JsonSchema\Types\Type;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\ResponseFactory;
use Laravel\Mcp\Server\Attributes\Description;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Server\Tools\Annotations\IsIdempotent;
use Laravel\Mcp\Server\Tools\Annotations\IsReadOnly;

/**
 * Ad hoc SELECT към продукцията през read-only връзка. Гаранциите и
 * ограниченията са в ReadOnlyQueryRunner; тук е само MCP обвивката.
 *
 * Регистрира се само когато има конфигурирана read-only връзка — без
 * DB_READONLY_USERNAME инструментът липсва от списъка, вместо да гърми.
 */
#[Name('sql-query')]
#[Description('Изпълнява ЕДНА SELECT/SHOW/DESCRIBE/EXPLAIN заявка към базата на Падок през MySQL потребител само за четене. Резултатът е ограничен по редове; сесии, токени и пароли не са достъпни. За схемата: SHOW TABLES, DESCRIBE races.')]
#[IsReadOnly]
#[IsIdempotent]
class SqlQueryTool extends Tool
{
    public function __construct(private readonly ReadOnlyQueryRunner $runner) {}

    public function shouldRegister(): bool
    {
        return $this->runner->isAvailable();
    }

    public function handle(Request $request): ResponseFactory|Response
    {
        $validated = $request->validate([
            'sql' => ['required', 'string', 'max:10000'],
        ], [
            'sql.*' => 'Подай една SELECT заявка като низ в аргумента sql (до 10 000 знака).',
        ]);

        try {
            $result = $this->runner->run((string) $validated['sql']);
        } catch (InvalidReadOnlyQuery $e) {
            return Response::error($e->getMessage());
        } catch (QueryException $e) {
            return Response::error('SQL грешка: '.$e->getMessage());
        }

        $note = $result['truncated']
            ? "Показани са първите {$result['row_count']} реда (таван {$this->runner->maxRows()}) — стесни заявката или добави LIMIT."
            : null;

        return Response::structured([
            'connection' => $this->runner->connectionName(),
            'columns' => $result['columns'],
            'row_count' => $result['row_count'],
            'truncated' => $result['truncated'],
            'note' => $note,
            'rows' => $result['rows'],
        ]);
    }

    /**
     * @return array<string, Type>
     */
    public function schema(JsonSchema $schema): array
    {
        return [
            'sql' => $schema->string()
                ->required()
                ->max(10000)
                ->description('Една SELECT (или WITH/SHOW/DESCRIBE/EXPLAIN) заявка. Без „;“ по средата, без INTO OUTFILE.'),
        ];
    }
}
