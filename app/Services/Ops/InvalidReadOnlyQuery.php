<?php

declare(strict_types=1);

namespace App\Services\Ops;

use InvalidArgumentException;

/**
 * Заявка, която ReadOnlyQueryRunner отказва да изпълни. Съобщението е за
 * AI клиента — казва какво точно не е наред, за да се поправи заявката.
 */
class InvalidReadOnlyQuery extends InvalidArgumentException {}
