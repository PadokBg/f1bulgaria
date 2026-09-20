/**
 * Картичка с резултата от прогноза — 1200×630 canvas за споделяне.
 *
 * Рисува се в браузъра, а не на сървъра с GD, по същата причина като
 * share-картата на играта: шрифтовете на сайта живеят в браузъра, а GD би
 * искал TTF файл с кирилица в репото (виж App\Services\Og\CircuitOgImage —
 * точно затова картинката на „Данни" е без текст).
 *
 * Зарежда се мързеливо — трябва само при натиснат „Сподели".
 */

const WIDTH = 1200;
const HEIGHT = 630;

const DISPLAY_FAMILY = '"Exo 2", Figtree, system-ui, -apple-system, sans-serif';
const TEXT_FAMILY = 'Figtree, system-ui, -apple-system, sans-serif';

const BRAND = '#e10600';

/**
 * @param {object} data
 * @param {string} data.raceName     Името на кръга, напр. „Гран при на Азербайджан"
 * @param {string} data.userName     Името на прогнозиралия
 * @param {number} data.points       Спечелените точки
 * @param {number|null} data.rank    Позиция в кръга
 * @param {number|null} data.total   Колко души са прогнозирали
 * @param {Array<{label: string, hit: boolean}>} data.rows  Какво е познал
 * @returns {Promise<Blob>}
 */
export async function buildPredictionCard(data) {
    await loadFonts();

    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');

    const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    gradient.addColorStop(0, '#101014');
    gradient.addColorStop(1, '#1b1b22');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // Карирана лента отгоре — същият мотив като картата на играта.
    const square = 20;
    for (let x = 0; x < WIDTH / square; x++) {
        for (let y = 0; y < 2; y++) {
            ctx.fillStyle = (x + y) % 2 === 0 ? '#ffffff' : '#0a0a0a';
            ctx.fillRect(x * square, y * square, square, square);
        }
    }

    ctx.fillStyle = BRAND;
    ctx.fillRect(0, 40, 12, HEIGHT - 40);

    // Заглавие: кой и къде.
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#a1a1aa';
    ctx.font = `600 26px ${TEXT_FAMILY}`;
    ctx.fillText(truncate(ctx, data.raceName, 900), 64, 96);

    ctx.fillStyle = '#ffffff';
    ctx.font = `800 64px ${DISPLAY_FAMILY}`;
    ctx.fillText(truncate(ctx, data.userName, 900), 64, 136);

    // Числото, заради което картичката изобщо се споделя.
    ctx.fillStyle = BRAND;
    ctx.font = `900 140px ${DISPLAY_FAMILY}`;
    const pointsText = `${data.points}`;
    ctx.fillText(pointsText, 64, 236);

    const pointsWidth = ctx.measureText(pointsText).width;
    ctx.fillStyle = '#e4e4e7';
    ctx.font = `700 44px ${DISPLAY_FAMILY}`;
    ctx.fillText('точки', 64 + pointsWidth + 20, 320);

    if (data.rank && data.total) {
        ctx.fillStyle = '#a1a1aa';
        ctx.font = `600 30px ${TEXT_FAMILY}`;
        ctx.fillText(`${data.rank}-и от ${data.total} прогнозирали`, 64, 402);
    }

    drawRows(ctx, data.rows ?? []);

    ctx.fillStyle = '#52525b';
    ctx.font = `600 26px ${TEXT_FAMILY}`;
    ctx.fillText('padok.bg', 64, HEIGHT - 76);

    ctx.fillStyle = BRAND;
    ctx.beginPath();
    ctx.arc(64 + ctx.measureText('padok.bg').width + 12, HEIGHT - 64, 6, 0, Math.PI * 2);
    ctx.fill();

    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Дясната колона: какво е познал и какво не.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{label: string, hit: boolean}>} rows
 */
function drawRows(ctx, rows) {
    const left = 680;
    const top = 150;
    const lineHeight = 56;

    rows.slice(0, 7).forEach((row, i) => {
        const y = top + i * lineHeight;

        ctx.fillStyle = row.hit ? 'rgba(52,211,153,0.12)' : 'rgba(255,255,255,0.03)';
        roundRect(ctx, left, y, 456, 44, 10);
        ctx.fill();

        ctx.fillStyle = row.hit ? '#34d399' : '#52525b';
        ctx.font = `700 24px ${TEXT_FAMILY}`;
        ctx.fillText(row.hit ? '✓' : '✗', left + 16, y + 10);

        ctx.fillStyle = row.hit ? '#e4e4e7' : '#71717a';
        ctx.font = `600 24px ${TEXT_FAMILY}`;
        ctx.fillText(truncate(ctx, row.label, 390), left + 48, y + 10);
    });
}

/** Реже текста с многоточие, за да не изтече извън картата. */
function truncate(ctx, text, maxWidth) {
    const value = String(text ?? '');

    if (ctx.measureText(value).width <= maxWidth) {
        return value;
    }

    let cut = value;

    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) {
        cut = cut.slice(0, -1);
    }

    return `${cut}…`;
}

async function loadFonts() {
    if (!document.fonts?.load) {
        return;
    }

    try {
        await Promise.all([
            document.fonts.load(`900 140px ${DISPLAY_FAMILY}`),
            document.fonts.load(`800 64px ${DISPLAY_FAMILY}`),
            document.fonts.load(`600 26px ${TEXT_FAMILY}`),
        ]);
    } catch {
        // Блокиран CDN/offline — рисуваме със системния шрифт.
    }
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}
