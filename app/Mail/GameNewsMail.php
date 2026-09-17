<?php

declare(strict_types=1);

namespace App\Mail;

use App\Mail\Concerns\HasUnsubscribeHeaders;
use Illuminate\Bus\Queueable;
use Illuminate\Mail\Mailable;
use Illuminate\Mail\Mailables\Content;
use Illuminate\Mail\Mailables\Envelope;
use Illuminate\Queue\SerializesModels;

/**
 * Какво е ново в играта (септември 2026): истинско състезание — по-умни
 * ботове, DRS, наказания, радио, задочни битки — и двете класации. Пуска се
 * ръчно с padok:announce-game-news, СЛЕД деплоя (описва живи неща).
 */
class GameNewsMail extends Mailable
{
    use HasUnsubscribeHeaders, Queueable, SerializesModels;

    /**
     * @param  string|null  $unsubscribeToken  токен за отписване (само за бюлетинни абонати)
     * @param  string|null  $userUnsubscribeUrl  signed линк за спиране на имейлите (само за потребители с акаунт)
     */
    public function __construct(
        public ?string $unsubscribeToken = null,
        public ?string $userUnsubscribeUrl = null,
    ) {}

    public function envelope(): Envelope
    {
        return new Envelope(
            subject: 'Ново в играта на Падок: истинско състезание, DRS и битки с реални играчи 🏁',
        );
    }

    public function content(): Content
    {
        return new Content(
            markdown: 'mail.game-news',
        );
    }
}
