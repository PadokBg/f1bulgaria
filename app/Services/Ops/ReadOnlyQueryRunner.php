<?php

declare(strict_types=1);

namespace App\Services\Ops;

use Illuminate\Database\Connection;
use Illuminate\Support\Facades\DB;

/**
 * Изпълнява SELECT-only SQL за MCP инструмента sql-query.
 *
 * Три пояса, от твърдия към мекия:
 *  1. отделна връзка (config ops.mcp.query_connection) — на прод MySQL
 *     потребител САМО със SELECT. Това е гаранцията; долните две са за
 *     случая, в който някой я е конфигурирал грешно;
 *  2. READ ONLY транзакция с таван на времето — MySQL отказва писане с
 *     грешка 1792 дори с пишещ акаунт, а runaway SELECT спира сам;
 *  3. проверка на текста: една заявка, започва със SELECT/WITH/SHOW/
 *     DESCRIBE/EXPLAIN, без забранени таблици (сесии, токени, кеш).
 *
 * Резултатът е ограничен по редове и по дължина на клетка, а чувствителните
 * колони (пароли, токени) се режат независимо как е написана заявката.
 */
class ReadOnlyQueryRunner
{
    /** Над толкова знака една клетка се реже — payload-и и HTML не са за чат. */
    private const MAX_CELL_LENGTH = 500;

    private const ALLOWED_LEADING_KEYWORDS = ['select', 'with', 'show', 'describe', 'desc', 'explain'];

    public function connectionName(): string
    {
        return (string) config('ops.mcp.query_connection', 'mysql_readonly');
    }

    /**
     * Има ли конфигурирана връзка. MySQL без потребител значи, че
     * DB_READONLY_USERNAME липсва в .env — инструментът не се регистрира,
     * вместо да гръмне при първото извикване.
     */
    public function isAvailable(): bool
    {
        $name = $this->connectionName();
        $config = config("database.connections.{$name}");

        if (! is_array($config)) {
            return false;
        }

        $driver = (string) ($config['driver'] ?? '');

        if ($driver === 'sqlite') {
            return true;
        }

        return (string) ($config['username'] ?? '') !== '';
    }

    public function maxRows(): int
    {
        return max(1, (int) config('ops.mcp.query_max_rows', 200));
    }

    /**
     * @return array{columns: list<string>, rows: list<array<string, mixed>>, row_count: int, truncated: bool}
     *
     * @throws InvalidReadOnlyQuery
     */
    public function run(string $sql): array
    {
        $statement = $this->validate($sql);
        $connection = DB::connection($this->connectionName());
        $limit = $this->maxRows();

        // Заявката се изпълнява КАКТО Е — без обвиване в `SELECT * FROM (...)`.
        // Обвивката гърми на MySQL при дублирани имена на колони (всеки JOIN
        // със `*` → грешка 1060), а sqlite в тестовете ги търпи и не го хваща.
        // Таванът е през курсора (+ sql_select_limit на MySQL, за да не дойде
        // и целият резултат по мрежата).
        $rows = $this->withinReadOnlyTransaction($connection, function () use ($connection, $statement, $limit): array {
            $rows = [];

            foreach ($connection->cursor($statement) as $row) {
                $rows[] = (array) $row;

                if (count($rows) > $limit) {
                    break;
                }
            }

            return $rows;
        });

        $truncated = count($rows) > $limit;
        $rows = array_slice($rows, 0, $limit);
        $rows = array_map(fn (array $row): array => $this->sanitizeRow($row), $rows);

        return [
            'columns' => $rows === [] ? [] : array_keys($rows[0]),
            'rows' => array_values($rows),
            'row_count' => count($rows),
            'truncated' => $truncated,
        ];
    }

    /**
     * Връща нормализираната заявка (без краен `;`) или хвърля.
     *
     * @throws InvalidReadOnlyQuery
     */
    public function validate(string $sql): string
    {
        $statement = trim($this->stripLeadingComments($sql));
        $statement = rtrim(rtrim($statement), ';');
        $statement = rtrim($statement);

        if ($statement === '') {
            throw new InvalidReadOnlyQuery('Празна заявка. Подай SELECT, SHOW, DESCRIBE или EXPLAIN.');
        }

        if (str_contains($statement, ';')) {
            throw new InvalidReadOnlyQuery('Само една заявка наведнъж — „;“ по средата не се приема (и в литерали).');
        }

        $keyword = $this->leadingKeyword($statement);

        if (! in_array($keyword, self::ALLOWED_LEADING_KEYWORDS, true)) {
            throw new InvalidReadOnlyQuery(
                'Сървърът е само за четене: заявката трябва да започва със SELECT, WITH, SHOW, DESCRIBE или EXPLAIN.'
            );
        }

        if (preg_match('/\binto\s+(outfile|dumpfile)\b/i', $statement) === 1) {
            throw new InvalidReadOnlyQuery('INTO OUTFILE/DUMPFILE не се приема.');
        }

        foreach ($this->deniedTables() as $table) {
            if (preg_match('/\b'.preg_quote($table, '/').'\b/i', $statement) === 1) {
                throw new InvalidReadOnlyQuery("Таблицата „{$table}“ е извън обхвата на този инструмент.");
            }
        }

        // Забранените колони се режат и от резултата (sanitizeRow), но само по
        // име — `SELECT password AS p` или `substr(password, 1, 20)` биха ги
        // заобиколили. Затова самото им споменаване в заявката е отказ.
        foreach ($this->deniedColumns() as $column) {
            if (preg_match('/\b'.preg_quote($column, '/').'\b/i', $statement) === 1) {
                throw new InvalidReadOnlyQuery("Колоната „{$column}“ е извън обхвата на този инструмент — не я споменавай в заявката (SELECT * я пропуска автоматично).");
            }
        }

        return $statement;
    }

    /**
     * @template T
     *
     * @param  callable(): T  $callback
     * @return T
     */
    private function withinReadOnlyTransaction(Connection $connection, callable $callback): mixed
    {
        if ($connection->getDriverName() !== 'mysql') {
            $connection->beginTransaction();

            try {
                return $callback();
            } finally {
                $connection->rollBack();
            }
        }

        $timeout = max(100, (int) config('ops.mcp.query_timeout_ms', 5000));
        $selectLimit = $this->maxRows() + 1;

        // sql_select_limit важи за SELECT без изричен LIMIT — сървърът спира
        // да праща редове там, където курсорът така или иначе би спрял.
        $connection->unprepared("SET SESSION max_execution_time = {$timeout}, SESSION sql_select_limit = {$selectLimit}");
        $connection->unprepared('START TRANSACTION READ ONLY');

        try {
            return $callback();
        } finally {
            $connection->unprepared('ROLLBACK');
        }
    }

    /**
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    private function sanitizeRow(array $row): array
    {
        $denied = array_map('strtolower', $this->deniedColumns());
        $clean = [];

        foreach ($row as $column => $value) {
            if (in_array(strtolower((string) $column), $denied, true)) {
                continue;
            }

            if (is_string($value) && mb_strlen($value) > self::MAX_CELL_LENGTH) {
                $value = mb_substr($value, 0, self::MAX_CELL_LENGTH).'…';
            }

            $clean[(string) $column] = $value;
        }

        return $clean;
    }

    private function leadingKeyword(string $statement): string
    {
        preg_match('/^\s*\(?\s*([a-z]+)/i', $statement, $matches);

        return strtolower($matches[1] ?? '');
    }

    private function stripLeadingComments(string $sql): string
    {
        $pattern = '/^\s*(?:--[^\n]*\n|#[^\n]*\n|\/\*.*?\*\/\s*)+/s';

        return preg_replace($pattern, '', $sql) ?? $sql;
    }

    /**
     * @return list<string>
     */
    private function deniedTables(): array
    {
        $tables = config('ops.mcp.query_denied_tables', []);

        return is_array($tables) ? array_values(array_filter($tables, 'is_string')) : [];
    }

    /**
     * @return list<string>
     */
    private function deniedColumns(): array
    {
        $columns = config('ops.mcp.query_denied_columns', []);

        return is_array($columns) ? array_values(array_filter($columns, 'is_string')) : [];
    }
}
