<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Mail\DailyActivityMail;
use App\Models\AuthEvent;
use App\Models\NewsletterSend;
use App\Models\Race;
use App\Models\RaceDataRecap;
use App\Models\Season;
use App\Models\User;
use App\Services\Newsletter\NewsletterAudience;
use App\Services\Ops\QueueHealthInspector;
use App\Services\Predictions\PredictionLockService;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Facades\Mail;

/**
 * Дневният отчет за активността + здравна проверка на автоматиките.
 *
 * ЗАЩО здравната част живее тук, а не в отделна аларма: авариите, които този
 * проект реално преживя, не гърмят — трупат се. Мъртъв queue worker,
 * надхвърлен дневен лимит на пощата, ненаваксан рекап; всяка от тях мълчи и се
 * открива случайно, месеци по-късно. Едно писмо на ден, което човек ЧЕТЕ, ги
 * хваща за един ден.
 *
 * Всичко се смята със заявки към базата. Нарочно: LOG_CHANNEL е `daily`,
 * файловете се въртят и логът не е източник на истината за вчерашния ден.
 *
 * Секция без проблем се свива до един ред. Отчет, който всеки ден изглежда
 * еднакво дълъг, спира да се чете след седмица — а нечетеният отчет е точно
 * толкова полезен, колкото липсващият.
 */
class DailyActivityReportCommand extends Command
{
    protected $signature = 'report:daily-activity
        {--date= : Ден в Y-m-d (софийско време); по подразбиране днес}
        {--preview : Отпечатай отчета в конзолата вместо да пращаш имейл}';

    protected $description = 'Дневен отчет за активността и здравето на автоматиките — праща имейл на админа.';

    /**
     * Дневният таван идва от `mail.daily_cap`, тоест от средата.
     *
     * Беше константа с довода, че е ограничение на плана, а не настройка на
     * приложението. Доводът е верен, изводът — не: планът се сменя с акаунта,
     * а константата значи деплой при всяка смяна. На 07.09.2026 планът стана
     * платен още същия ден, в който отчетът тръгна, и таванът от 100 веднага
     * почна да лъже.
     *
     * Нула изключва проверката. Обемът пак се отчита — просто не е проблем.
     */
    private function mailDailyCap(): int
    {
        return (int) config('mail.daily_cap', 0);
    }

    /**
     * Огледало на GenerateRaceDataRecapCommand::MAX_HOURS.
     *
     * Вътре в този прозорец почасовият крон сам наваксва пропуснат час, тоест
     * кръг без рекап още не е проблем. Проблем става чак когато прозорецът се
     * затвори — иначе всяка неделна вечер би вдигала фалшива аларма.
     */
    private const RECAP_GRACE_HOURS = 36;

    /** Огледало на GenerateRaceDataRecapCommand::MAX_ATTEMPTS — след толкова опита кръгът е изоставен. */
    private const RECAP_MAX_ATTEMPTS = 5;

    /** До толкова часа преди заключването нула прогнози вече е сигнал, а не спокойствие. */
    private const LEAGUE_ALARM_HOURS = 48;

    public function handle(
        NewsletterAudience $audience,
        PredictionLockService $locks,
        QueueHealthInspector $queue,
    ): int {
        $tz = 'Europe/Sofia';
        $day = $this->option('date')
            ? CarbonImmutable::parse((string) $this->option('date'), $tz)
            : CarbonImmutable::now($tz);

        // Базата пази времена в UTC — конвертираме границите на софийския ден.
        $from = $day->startOfDay()->utc();
        $to = $day->endOfDay()->utc();

        $events = AuthEvent::whereBetween('created_at', [$from, $to])->get();

        $logins = $events->where('type', AuthEvent::TYPE_LOGIN);

        $stats = [
            'date' => $day->format('d.m.Y'),
            'registrations' => $events->where('type', AuthEvent::TYPE_REGISTERED)->count(),
            'logins' => $logins->count(),
            'unique_logins' => $logins->whereNotNull('user_id')->pluck('user_id')->unique()->count(),
            'logouts' => $events->where('type', AuthEvent::TYPE_LOGOUT)->count(),
            'failed' => $events->where('type', AuthEvent::TYPE_FAILED)->count(),
            'total_users' => User::count(),
            'new_emails' => $events->where('type', AuthEvent::TYPE_REGISTERED)
                ->pluck('email')->filter()->values()->all(),
            'health' => $this->health($from, $to, $audience, $locks, $queue),
        ];

        if ($this->option('preview')) {
            $this->preview($stats);

            return self::SUCCESS;
        }

        $email = (string) config('app.admin_report_email', '');

        if ($email === '') {
            $this->error('Няма ADMIN_REPORT_EMAIL (нито ADMIN_EMAIL) в .env — задай го и презареди config кеша.');

            return self::FAILURE;
        }

        Mail::to($email)->send(new DailyActivityMail($stats));
        $this->info("Дневният отчет за {$stats['date']} е изпратен на {$email}.");

        return self::SUCCESS;
    }

    /**
     * Здравната част: четирите секции плюс обединения списък с проблемите.
     *
     * Дневните числа (провалени задачи, тръгнали вълни) са за поискания ден;
     * моментните (дълбочина на опашката, липсващи рекапи, отворен кръг) са
     * винаги „сега“ — базата не помни вчерашната им стойност.
     *
     * @return array<string, mixed>
     */
    private function health(
        CarbonImmutable $from,
        CarbonImmutable $to,
        NewsletterAudience $audience,
        PredictionLockService $locks,
        QueueHealthInspector $queue,
    ): array {
        $sections = [
            'queue' => $this->queueHealth($from, $to, $queue),
            'mail' => $this->mailHealth($from, $to, $audience),
            'recaps' => $this->recapHealth(),
            'league' => $this->leagueHealth($locks),
        ];

        $problems = [];

        foreach ($sections as $section) {
            foreach ($section['problems'] as $problem) {
                $problems[] = $problem;
            }
        }

        return $sections + ['problems' => $problems];
    }

    /**
     * Опашката: чакащи задачи, възраст на най-старата готова, провалени за деня.
     *
     * @return array<string, mixed>
     */
    private function queueHealth(CarbonImmutable $from, CarbonImmutable $to, QueueHealthInspector $queue): array
    {
        $snapshot = $queue->inspect($from, $to);
        $driver = $snapshot['driver'];

        // Броенето минава през таблиците jobs и failed_jobs. При друг драйвер
        // няма какво да се преброи и отчетът го казва, вместо да покаже
        // успокоителни нули.
        if (! $snapshot['counts_from_database']) {
            return [
                'driver' => $driver,
                'pending' => 0,
                'oldest_minutes' => null,
                'failed_today' => 0,
                'problems' => [],
                'line' => "Драйверът е „{$driver}“, не database — опашката не се брои от базата.",
            ];
        }

        $pending = $snapshot['pending'];
        $oldestMinutes = $snapshot['oldest_minutes'];
        $failedToday = $snapshot['failed_in_window'];

        $problems = [];

        if ($queue->isStale($oldestMinutes)) {
            $problems[] = [
                'label' => 'опашката стои',
                'text' => "Най-старата готова задача чака {$this->humanMinutes($oldestMinutes)}, чакащи общо: {$pending}. "
                    .'При този размер опашката се изпразва за секунди, така че толкова изчакване значи спрял worker: '
                    .'провери systemctl status padok-queue.',
            ];
        }

        if ($failedToday > 0) {
            $problems[] = [
                'label' => "провалени задачи: {$failedToday}",
                'text' => "В failed_jobs днес: {$failedToday}. Кои и защо показва php artisan queue:failed.",
            ];
        }

        $waiting = $this->plural($pending, 'чакаща задача', 'чакащи задачи');

        $line = match (true) {
            $pending === 0 => "Празна, провалени днес: {$failedToday}.",
            $oldestMinutes === null => "{$waiting}, всички отложени за по-късно; провалени днес: {$failedToday}.",
            default => "{$waiting}, най-старата готова от {$this->humanMinutes($oldestMinutes)}; провалени днес: {$failedToday}.",
        };

        return [
            'driver' => $driver,
            'pending' => $pending,
            'oldest_minutes' => $oldestMinutes,
            'failed_today' => $failedToday,
            'problems' => $problems,
            'line' => $line,
        ];
    }

    /**
     * Писмата: кои вълни са маркирани днес и колко писма са могли да излязат.
     *
     * ВАЖНО за четенето: редът в newsletter_sends се записва ПРЕДИ самото
     * разпращане (виж SendsBulkMail). Наличието му доказва, че командата е
     * стартирала — НЕ че писмата са стигнали. Затова тук никъде не пише
     * „изпратени“, а обемът е оценка ОТГОРЕ: подсещането например стига само до
     * хората без прогноза, не до цялата аудитория.
     *
     * @return array<string, mixed>
     */
    private function mailHealth(CarbonImmutable $from, CarbonImmutable $to, NewsletterAudience $audience): array
    {
        $waves = NewsletterSend::query()
            ->whereBetween('sent_at', [$from, $to])
            ->get()
            ->groupBy('mail_type')
            ->map(fn ($rows, string $type): array => [
                'type' => $type,
                'label' => $this->mailTypeLabel($type),
                'count' => $rows->count(),
            ])
            ->values()
            ->all();

        // Алармите за news pipeline-а също живеят в тази таблица, но отиват до
        // един админски адрес — в обема на масовата поща нямат работа.
        $operational = [NewsletterSend::TYPE_PIPELINE_ALERT, NewsletterSend::TYPE_PIPELINE_RECOVERED];

        $bulkWaves = 0;

        foreach ($waves as $wave) {
            if (! in_array($wave['type'], $operational, true)) {
                $bulkWaves += $wave['count'];
            }
        }

        $users = $audience->users();
        $recipients = $users->count() + $audience->subscribersWithoutAccount($users)->count();
        $estimate = $bulkWaves * $recipients;

        $problems = [];

        $cap = $this->mailDailyCap();

        if ($cap > 0 && $estimate > $cap) {
            $problems[] = [
                'label' => 'дневният лимит на пощата',
                'text' => "Масови вълни днес: {$bulkWaves}, получатели: {$recipients} — до {$estimate} писма при таван "
                    ."{$cap} на ден. Над тавана доставчикът отказва, всеки получател се проваля поотделно, а "
                    .'командата пак излиза с успех — точно така изчезваха писма в състезателните петъци и недели.',
            ];
        }

        if ($waves === []) {
            $line = 'Днес не е тръгвала нито една вълна писма.';
        } else {
            $names = implode(', ', array_map(
                fn (array $wave): string => $wave['count'] > 1 ? "{$wave['label']} ×{$wave['count']}" : $wave['label'],
                $waves,
            ));

            $line = "Тръгнали днес: {$names} — до {$this->plural($estimate, 'писмо', 'писма')} към "
                .$this->plural($recipients, 'получател', 'получатели')
                .' (редът се пише преди разпращането: доказва тръгнала команда, не доставени писма).';
        }

        return [
            'waves' => $waves,
            'bulk_waves' => $bulkWaves,
            'recipients' => $recipients,
            'estimate' => $estimate,
            'cap' => $cap,
            'problems' => $problems,
            'line' => $line,
        ];
    }

    /**
     * Рекапите: приключили кръгове без готов рекап и такива, които са се отказали.
     *
     * Обхватът е ТЕКУЩИЯТ сезон. По-назад базата пази и години отпреди OpenF1,
     * за които рекап никога няма да има — вечните десетки „липсващи“ биха
     * превърнали секцията в шум, който се прескача.
     *
     * @return array<string, mixed>
     */
    private function recapHealth(): array
    {
        if (! config('features.data_recap')) {
            return [
                'enabled' => false,
                'season' => null,
                'missing' => [],
                'missing_count' => 0,
                'abandoned' => [],
                'abandoned_count' => 0,
                'problems' => [],
                'line' => 'Рекапите с данни са изключени (FEATURE_DATA_RECAP).',
            ];
        }

        $season = Season::current();

        if ($season === null) {
            return [
                'enabled' => true,
                'season' => null,
                'missing' => [],
                'missing_count' => 0,
                'abandoned' => [],
                'abandoned_count' => 0,
                'problems' => [],
                'line' => 'Няма сезон, маркиран като текущ — рекапите не могат да се проверят.',
            ];
        }

        $missing = Race::query()
            ->where('season_id', $season->id)
            ->whereNotNull('race_datetime_utc')
            ->where('race_datetime_utc', '<', now()->subHours(self::RECAP_GRACE_HOURS))
            ->whereDoesntHave('dataRecap', fn (Builder $query) => $query->ready())
            ->orderBy('race_datetime_utc')
            ->get();

        // Само неуспелите: кръг, минал през пет опита и накрая проработил, не е
        // изоставен и няма какво да прави в списъка за оправяне.
        $abandoned = RaceDataRecap::query()
            ->where('attempts', '>=', self::RECAP_MAX_ATTEMPTS)
            ->whereNull('generated_at')
            ->with('race')
            ->get();

        $problems = [];

        if ($missing->isNotEmpty()) {
            $oldest = $missing->first();

            $problems[] = [
                'label' => "без рекап: {$missing->count()}",
                'text' => "Приключили кръгове от сезон {$season->year} без рекап: {$missing->count()} (най-стар: {$oldest->name_bg}). "
                    ."Прозорецът на почасовия крон за тях е затворен — наваксването е php artisan padok:race-data-recap --season={$season->year}.",
            ];
        }

        if ($abandoned->isNotEmpty()) {
            $problems[] = [
                'label' => "отказали се рекапи: {$abandoned->count()}",
                'text' => "Рекапи с {$this->plural(self::RECAP_MAX_ATTEMPTS, 'опит', 'опита')} и нула резултат: {$abandoned->count()}. "
                    .'Няма да бъдат опитани отново — нито почасово, нито при наваксване. Оправи причината и пусни кръга поименно с --rebuild.',
            ];
        }

        $line = $missing->isEmpty() && $abandoned->isEmpty()
            ? "Всички приключили кръгове от сезон {$season->year} имат рекап."
            : "Без рекап: {$this->plural($missing->count(), 'кръг', 'кръга')} от сезон {$season->year}; отказали се: {$abandoned->count()}.";

        return [
            'enabled' => true,
            'season' => $season->year,
            'missing' => $missing->take(5)->map(fn (Race $race): array => [
                'name' => $race->name_bg,
                'date' => $race->race_datetime_utc?->setTimezone('Europe/Sofia')->format('d.m.Y') ?? '—',
            ])->all(),
            'missing_count' => $missing->count(),
            'abandoned' => $abandoned->take(5)->map(fn (RaceDataRecap $recap): array => [
                'name' => $recap->race?->name_bg ?? "състезание #{$recap->race_id}",
                'attempts' => $recap->attempts,
                'error' => $recap->last_error,
            ])->all(),
            'abandoned_count' => $abandoned->count(),
            'problems' => $problems,
            'line' => $line,
        ];
    }

    /**
     * Лигата: следващият незаключен кръг и колко души вече са подали прогноза.
     *
     * Една прогноза на човек (unique по user_id + race_id), тоест броят редове е
     * броят хора. Това е единственото число, което казва дали сайтът се ползва
     * по предназначение — нула прогнози в навечерието на кръг значи или че
     * подсещането не е тръгнало, или че формата не приема.
     *
     * @return array<string, mixed>
     */
    private function leagueHealth(PredictionLockService $locks): array
    {
        // Заключването е минути преди квалификацията, затова кръг с бъдеща
        // квалификация вече може да е затворен — филтрира се по срока, не по
        // часа на сесията.
        $race = Race::query()
            ->whereNotNull('qualifying_datetime_utc')
            ->where('qualifying_datetime_utc', '>=', now())
            ->orderBy('qualifying_datetime_utc')
            ->limit(5)
            ->get()
            ->first(fn (Race $candidate): bool => $locks->lockDeadline($candidate)?->isFuture() === true);

        if ($race === null) {
            return [
                'race' => null,
                'deadline' => null,
                'hours_left' => null,
                'predictions' => 0,
                'problems' => [],
                'line' => 'Няма незаключен кръг напред — извън сезона или календарът не е синхронизиран.',
            ];
        }

        $deadline = $locks->lockDeadline($race);
        $hoursLeft = (int) floor(now()->diffInHours($deadline, absolute: true));
        $predictions = $race->predictions()->count();

        $problems = [];

        if ($predictions === 0 && $hoursLeft <= self::LEAGUE_ALARM_HOURS) {
            $problems[] = [
                'label' => 'нула прогнози',
                'text' => "До заключването на {$race->name_bg} остават {$this->humanHours($hoursLeft)} и няма нито една прогноза. "
                    .'Провери дали подсещането е тръгнало и дали формата приема.',
            ];
        }

        $deadlineText = $deadline->setTimezone('Europe/Sofia')->format('d.m, H:i').' ч.';

        return [
            'race' => $race->name_bg,
            'deadline' => $deadlineText,
            'hours_left' => $hoursLeft,
            'predictions' => $predictions,
            'problems' => $problems,
            'line' => "{$race->name_bg}: {$this->plural($predictions, 'прогноза', 'прогнози')}, заключване {$deadlineText} (след {$this->humanHours($hoursLeft)}).",
        ];
    }

    /**
     * Български етикет на вълната. Динамичните типове (куиз по седмица,
     * еднократен анонс) се разпознават по представка — иначе отчетът показва
     * голия slug, което пак е по-добре от премълчана вълна.
     */
    private function mailTypeLabel(string $type): string
    {
        $known = [
            NewsletterSend::TYPE_DIGEST => 'седмичен дайджест',
            NewsletterSend::TYPE_PULSE => 'извънсезонен пулс',
            NewsletterSend::TYPE_PREDICTION_REMINDER => 'подсещане за прогноза',
            NewsletterSend::TYPE_LIVE_COVERAGE => 'анонс за живо отразяване',
            NewsletterSend::TYPE_PIPELINE_ALERT => 'аларма за новините',
            NewsletterSend::TYPE_PIPELINE_RECOVERED => 'възстановени новини',
        ];

        if (isset($known[$type])) {
            return $known[$type];
        }

        return match (true) {
            str_starts_with($type, 'quiz-monday-') => 'анонс на куиза',
            str_starts_with($type, 'announcement-') => 'еднократен анонс',
            default => $type,
        };
    }

    /**
     * Число + съществително в правилното число.
     *
     * Съществува, защото отчетът се чете надве-натри: „1 приключили кръга“
     * спъва окото точно в реда, който трябва да се разбере от един поглед.
     */
    private function plural(int $count, string $one, string $many): string
    {
        return $count.' '.($count === 1 ? $one : $many);
    }

    /** „6 ч“ се хваща с един поглед, „364 минути“ — не. */
    private function humanMinutes(int $minutes): string
    {
        if ($minutes < 60) {
            return "{$minutes} мин";
        }

        $hours = intdiv($minutes, 60);

        if ($hours < 24) {
            return "{$hours} ч";
        }

        $days = intdiv($hours, 24);

        return $days === 1 ? '1 ден' : "{$days} дни";
    }

    private function humanHours(int $hours): string
    {
        return match (true) {
            $hours < 1 => 'по-малко от час',
            $hours === 1 => '1 час',
            default => "{$hours} часа",
        };
    }

    /**
     * @param  array<string, mixed>  $stats
     */
    private function preview(array $stats): void
    {
        $this->table(['Показател', 'Стойност'], [
            ['Дата', $stats['date']],
            ['Нови регистрации', $stats['registrations']],
            ['Влизания', $stats['logins']." (уникални: {$stats['unique_logins']})"],
            ['Изходи', $stats['logouts']],
            ['Неуспешни опити', $stats['failed']],
            ['Общо потребители', $stats['total_users']],
        ]);

        $health = $stats['health'];

        if ($health['problems'] === []) {
            $this->info('Няма открити проблеми.');
        } else {
            $this->warn('Проблеми ('.count($health['problems']).'):');

            foreach ($health['problems'] as $problem) {
                $this->line("  · {$problem['label']} — {$problem['text']}");
            }
        }

        $this->table(['Секция', 'Състояние'], [
            ['Опашка', $health['queue']['line']],
            ['Писма', $health['mail']['line']],
            ['Рекапи', $health['recaps']['line']],
            ['Лига', $health['league']['line']],
        ]);
    }
}
