<?php

declare(strict_types=1);

namespace App\Filament\Resources;

use App\Filament\Resources\RaceResource\Pages\CreateRace;
use App\Filament\Resources\RaceResource\Pages\EditRace;
use App\Filament\Resources\RaceResource\Pages\ListRaces;
use App\Models\Race;
use Filament\Actions\EditAction;
use Filament\Forms\Components\DateTimePicker;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Tables\Columns\IconColumn;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

class RaceResource extends Resource
{
    protected static ?string $model = Race::class;

    protected static string|\BackedEnum|null $navigationIcon = 'heroicon-o-flag';

    protected static string|\UnitEnum|null $navigationGroup = 'Данни от Формула 1';

    protected static ?string $navigationLabel = 'Състезания';

    protected static ?string $modelLabel = 'състезание';

    protected static ?string $pluralModelLabel = 'състезания';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            Select::make('season_id')
                ->label('Сезон')
                ->relationship('season', 'year')
                ->required(),
            TextInput::make('round')->label('Кръг')->numeric()->required(),
            TextInput::make('name')->label('Име')->required(),
            TextInput::make('circuit')->label('Писта')->required(),
            TextInput::make('country')->label('Държава')->required(),
            DateTimePicker::make('race_datetime_utc')->label('Старт (UTC)'),
            DateTimePicker::make('qualifying_datetime_utc')->label('Квалификация (UTC)'),
            DateTimePicker::make('sprint_datetime_utc')->label('Спринт (UTC)'),
            Toggle::make('has_sprint')->label('Спринт уикенд'),
            Toggle::make('manual_schedule')
                ->label('Ръчни часове')
                ->helperText('Календарът се синхронизира от Jolpica два пъти на ден. Включи, когато поправяш час преди Jolpica — иначе поправката се връща. Изключи, щом Jolpica се обнови.'),
            Select::make('pole_driver_id')
                ->label('Pole пилот')
                ->relationship('poleDriver', 'last_name')
                ->getOptionLabelFromRecordUsing(fn ($record) => $record->fullName())
                ->searchable(),
            // Попълва се от OpenF1 (SafetyCarDetector); ръчната стойност има
            // предимство. null = неизвестно (не се точкува).
            Select::make('had_safety_car')
                ->label('Имаше ли safety car?')
                ->options([1 => 'Да', 0 => 'Не'])
                ->placeholder('Неизвестно')
                ->helperText('Попълва се автоматично от OpenF1 след състезанието; виртуалният (VSC) не се брои. Ръчно въведената стойност не се презаписва.'),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('round')->label('Кръг')->sortable(),
                TextColumn::make('name')->label('Име')->searchable()->sortable(),
                TextColumn::make('season.year')->label('Сезон')->sortable(),
                IconColumn::make('has_sprint')->label('Спринт')->boolean(),
                TextColumn::make('race_datetime_utc')
                    ->label('Старт')
                    ->dateTime('d.m.Y H:i')
                    ->timezone('Europe/Sofia')
                    ->sortable(),
                IconColumn::make('had_safety_car')
                    ->label('SC')
                    ->boolean()
                    ->placeholder('?'),
            ])
            ->filters([
                SelectFilter::make('season')->relationship('season', 'year'),
            ])
            ->defaultSort('round')
            ->recordActions([
                EditAction::make(),
            ]);
    }

    public static function getPages(): array
    {
        return [
            'index' => ListRaces::route('/'),
            'create' => CreateRace::route('/create'),
            'edit' => EditRace::route('/{record}/edit'),
        ];
    }
}
