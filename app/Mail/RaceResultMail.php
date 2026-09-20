<?php

declare(strict_types=1);

namespace App\Mail;

use App\Models\Race;
use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/**
 * Другата половина на уикенда: какво донесе прогнозата ти.
 *
 * Досега кръгът свършваше в тишина — подсещането преди заключването беше
 * единственото писмо, а точките се появяваха някъде в профила, ако човек се
 * сети да влезе. Затова 15 от 21 прогнозирали досега са подали точно по
 * една прогноза: няма нищо, което да ги върне след състезанието.
 *
 * Получават го САМО хората, подали прогноза за този кръг — писмото е отговор
 * на тяхно собствено действие, не разпращане.
 *
 * @param  array<string, int>  $breakdown  какво е познал (ключове като в PredictionScore)
 */
class RaceResultMail extends Mailable
{
    use Queueable, SerializesModels;

    /**
     * @param  array<string, int>  $breakdown
     * @param  array{rank: int, total: int}  $raceRank  мястото в този кръг
     * @param  int|null  $seasonRank  мястото в класирането за сезона
     * @param  string  $userUnsubscribeUrl  signed линк за спиране на имейлите
     */
    public function __construct(
        public Race $race,
        public int $points,
        public array $breakdown,
        public array $raceRank,
        public ?int $seasonRank,
        public string $userUnsubscribeUrl,
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            subject: "Падок — {$this->points} т. за {$this->race->name_bg}",
        );
    }

    public function content(): Content
    {
        return new Content(
            markdown: 'mail.race-result',
            with: ['rows' => $this->rows()],
        );
    }

    /**
     * Разбивката като четими редове — същият ред и същите имена като на сайта.
     *
     * @return array<int, array{label: string, points: int}>
     */
    private function rows(): array
    {
        $labels = [
            'p1' => 'Победител',
            'p2' => 'Второ място',
            'p3' => 'Трето място',
            'pole' => 'Pole позиция',
            'fastest_lap' => 'Най-бърза обиколка',
            'dnf' => 'Брой отпаднали',
            'safety_car' => 'Safety car',
        ];

        $rows = [];

        foreach ($labels as $key => $label) {
            if (! array_key_exists($key, $this->breakdown)) {
                continue;
            }

            $rows[] = ['label' => $label, 'points' => (int) $this->breakdown[$key]];
        }

        return $rows;
    }
}
