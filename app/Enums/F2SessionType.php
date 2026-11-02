<?php

declare(strict_types=1);

namespace App\Enums;

enum F2SessionType: string
{
    case Practice = 'practice';
    case Qualifying = 'qualifying';
    case QualifyingGroupA = 'qualifying_group_a';
    case QualifyingGroupB = 'qualifying_group_b';
    case SprintRace = 'sprint_race';
    case FeatureRace = 'feature_race';
    // Второ главно състезание в един кръг — Баку 2026 („Feature Race 2"),
    // наваксване за отменен кръг. Отделна стойност по същата причина като
    // групите на квалификацията: (кръг, вид) е уникален.
    case SecondFeatureRace = 'feature_race_2';

    public function label(): string
    {
        return match ($this) {
            self::Practice => 'Свободна тренировка',
            self::Qualifying => 'Квалификация',
            self::QualifyingGroupA => 'Квалификация, група А',
            self::QualifyingGroupB => 'Квалификация, група Б',
            self::SprintRace => 'Спринт',
            self::FeatureRace => 'Главно състезание',
            self::SecondFeatureRace => 'Второ главно състезание',
        };
    }

    /**
     * Етикетът в контекста на кръга.
     *
     * Кръг с второ главно състезание (Баку 2026) има две квалификации за целия
     * старт — Qualifying 1 и 2, не групи като в Монако. Там „група А/Б" е
     * невярно, а се вижда и в последните резултати на всеки пилот.
     */
    public function labelInRound(bool $hasSecondFeatureRace): string
    {
        return match (true) {
            $hasSecondFeatureRace && $this === self::QualifyingGroupA => 'Квалификация 1',
            $hasSecondFeatureRace && $this === self::QualifyingGroupB => 'Квалификация 2',
            default => $this->label(),
        };
    }

    /**
     * Видът на сесия от `meetingSessions` в официалното API.
     *
     * От 28.07.2026 API-то праща `sessionType` („Practice", „Qualifying",
     * „Race") и `sessionNumber` вместо кратките кодове. Смяната мина без
     * предупреждение и три месеца синхронът пропускаше всяка сесия, затова
     * старите кодове остават като резерва.
     *
     * Номерът е задължителен и непознатият връща null: втора тренировка,
     * сложена в реда на първата, би я презаписала тихо.
     *
     * Qualifying 1 и 2 влизат в групите А и Б. В Монако това наистина са две
     * групи по половин старт („Qualifying A/B"). В Баку 2026 са две отделни
     * квалификации за целия старт, а втората нарежда второто главно — виж
     * labelInRound(). Държим ги като отделни стойности, защото
     * `f2_race_sessions` е уникална по (кръг, вид) — една обща „квалификация"
     * би изгубила едната.
     *
     * @param  array<string, mixed>  $session
     */
    public static function fromApiSession(array $session): ?self
    {
        $type = strtolower(trim((string) ($session['sessionType'] ?? '')));
        $number = $session['sessionNumber'] ?? null;

        if ($type === '' || ! is_numeric($number)) {
            return self::fromApiCode((string) ($session['session'] ?? ''));
        }

        return match ([$type, (int) $number]) {
            ['practice', 0] => self::Practice,
            ['qualifying', 0] => self::Qualifying,
            ['qualifying', 1] => self::QualifyingGroupA,
            ['qualifying', 2] => self::QualifyingGroupB,
            ['race', 1] => self::SprintRace,
            ['race', 2] => self::FeatureRace,
            ['race', 3] => self::SecondFeatureRace,
            default => null,
        };
    }

    /**
     * Кодът на сесията в API-то до 28.07.2026 (p, q, q1, q2, r1, r).
     */
    public static function fromApiCode(string $code): ?self
    {
        return match (strtolower($code)) {
            'p' => self::Practice,
            'q' => self::Qualifying,
            'q1' => self::QualifyingGroupA,
            'q2' => self::QualifyingGroupB,
            'r1' => self::SprintRace,
            'r' => self::FeatureRace,
            default => null,
        };
    }

    /**
     * Сесиите с шампионатни точки — за заявки като „победи" и „следващо
     * състезание", за да не изреждат видовете поотделно.
     *
     * @return array<int, self>
     */
    public static function races(): array
    {
        return [self::SprintRace, self::FeatureRace, self::SecondFeatureRace];
    }

    /**
     * Носи ли сесията шампионатни точки.
     */
    public function isRace(): bool
    {
        return in_array($this, self::races(), strict: true);
    }

    /**
     * Номерът на сесията, който API-то очаква като `session` параметър.
     * null = параметърът се пропуска (обикновена квалификация).
     */
    public function apiSessionNumber(): ?int
    {
        return match ($this) {
            self::Practice => 0,
            self::Qualifying => null,
            self::QualifyingGroupA, self::SprintRace => 1,
            self::QualifyingGroupB, self::FeatureRace => 2,
            self::SecondFeatureRace => 3,
        };
    }

    /**
     * Отрязъкът в URL-а на страницата за сесията (`/f2/races/{race}/{session}`).
     *
     * `sprint` и `feature` са наследени и НЕ бива да се преименуват — външни
     * линкове и вече публикувани постове в канала сочат към тях.
     */
    public function urlSegment(): string
    {
        return match ($this) {
            self::Practice => 'practice',
            self::Qualifying => 'qualifying',
            self::QualifyingGroupA => 'qualifying-a',
            self::QualifyingGroupB => 'qualifying-b',
            self::SprintRace => 'sprint',
            self::FeatureRace => 'feature',
            self::SecondFeatureRace => 'feature-2',
        };
    }

    public static function fromUrlSegment(string $segment): ?self
    {
        foreach (self::cases() as $case) {
            if ($case->urlSegment() === $segment) {
                return $case;
            }
        }

        return null;
    }

    /**
     * Подредба в рамките на уикенда — за показване и за реда на публикуване.
     */
    public function order(): int
    {
        return match ($this) {
            self::Practice => 1,
            self::Qualifying, self::QualifyingGroupA => 2,
            self::QualifyingGroupB => 3,
            self::SprintRace => 4,
            self::FeatureRace => 5,
            self::SecondFeatureRace => 6,
        };
    }

    /**
     * Съответният вид публикация в канала.
     */
    public function channelPostKind(): ChannelPostKind
    {
        return match ($this) {
            self::Practice => ChannelPostKind::F2Practice,
            self::Qualifying, self::QualifyingGroupA, self::QualifyingGroupB => ChannelPostKind::F2Qualifying,
            self::SprintRace => ChannelPostKind::F2SprintRace,
            self::FeatureRace, self::SecondFeatureRace => ChannelPostKind::F2FeatureRace,
        };
    }
}
